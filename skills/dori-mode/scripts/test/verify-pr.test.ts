import { expect, test } from "bun:test";
import type { Runner } from "../src/run.ts";
import { verifyPr } from "../src/verify-pr.ts";
import type { CommitIdentity } from "../src/verify-pr-check.ts";
import {
  FIXTURES,
  fixture,
  IDENTITY,
  withIdentity,
  checkPr,
  shaOf,
  sha,
  otherSha,
  commit,
  source,
  changedTest,
  snapshot,
  recordedRunner,
} from "./verify-pr-setup.ts";

for (const name of FIXTURES) {
  test(`fixture ${name} is checked using every commit's files and Git identities`, async () => {
    const p = fixture(name);
    const fake = recordedRunner(p);
    const result = await verifyPr(p.repo, p.number, fake.run, withIdentity);
    expect(result.ok).toBe(name !== "wrong-commit-email");
    expect(result.head).toBe(p.head);
    expect(fake.calls.filter((c) => c.argv[4]!.includes(`/commits/`))).toHaveLength(p.commits.length);
    expect(fake.calls.some((c) => c.argv[4]!.includes("/files"))).toBe(true);
    expect(fake.calls.filter((c) => c.argv[4] === `repos/${p.repo}/pulls/${p.number}`)).toHaveLength(2);
  });
}

test("fixes whose tests land in other commits pass with one warning per untested fix commit", () => {
  const p = fixture("tests-in-later-commits");
  const result = checkPr(p);
  expect(result.ok).toBe(true);
  expect(result.errors).toEqual([]);
  expect(result.warnings).toHaveLength(2);
  for (const message of [
    "fix(capture): retain the dialog while saving",
    "fix(notes): tighten the tag filter boundary",
  ]) {
    expect(result.warnings.some((e) => e.startsWith(shaOf(p, message)) && e.includes("without its own"))).toBe(true);
  }
  expect(result.asyncUiTests).toContain("src/features/capture/CaptureDialog.test.tsx");
  expect(result.asyncUiTests).toContain("src/features/inbox/SnoozeSheet.test.tsx");
});

test("a fixture file next to a test is not a test, and a wrong email names both roles", () => {
  expect(checkPr(fixture("fixture-file-is-not-a-test")).asyncUiTests).not.toContain(
    "src/features/settings/Templates.fixture.tsx",
  );
  const wrong = checkPr(fixture("wrong-commit-email"));
  expect(wrong.errors.map((e) => e.split(": ")[1]?.split(" ")[1])).toEqual(["author", "committer"]);
  expect(checkPr(fixture("follow-up-fixes-without-tests")).warnings).toHaveLength(3);
  expect(checkPr(fixture("release-chore")).warnings).toEqual([]);
});

test("a later test commit satisfies the PR gate but keeps a per-commit warning", () => {
  const result = checkPr(snapshot([commit([source]), commit([changedTest], "test(ui): cover pending work", otherSha)]));
  expect(result.ok).toBe(true);
  expect(result.errors).toEqual([]);
  expect(result.warnings[0]).toStartWith(sha);
});

test("a synthetic source fix without any PR test change fails unless explicitly waived", () => {
  const p = fixture("source-fix-without-tests");
  expect(checkPr(p).ok).toBe(false);
  expect(checkPr(p).errors).toHaveLength(1);
  const waived = checkPr({ ...p, body: "No test: CSS-only presentation change" });
  expect(waived.ok).toBe(true);
  expect(waived.warnings).toHaveLength(2);
  expect(checkPr({ ...snapshot(), files: [source] }).ok).toBe(false);
});

test("fixtures, source maps, and test helpers do not stand in for changed executable tests", () => {
  for (const filename of [
    "test/fixtures/example.test.ts",
    "test/helpers/browser.ts",
    "test/fakes.ts",
    "test/setup.ts",
    "src/example.test.ts.snap",
    "src/example.test.ts.map",
  ]) {
    expect(checkPr(snapshot([commit([source, { filename, status: "added" }])])).ok).toBe(false);
  }
});

test("Java, Kotlin and Swift files in a test directory count as tests", () => {
  for (const filename of [
    "src/test/java/com/acme/DialogTest.java",
    "app/src/test/kotlin/DialogTest.kt",
    "Tests/AppTests/DialogTests.swift",
  ]) {
    expect(checkPr(snapshot([commit([source, { filename, status: "added" }])])).ok).toBe(true);
  }
});

test("a real test whose name is helpers, mocks, fakes or fixture still counts; their directories do not", () => {
  for (const filename of [
    "test/helpers.test.ts",
    "src/mocks.test.ts",
    "test/fakes.spec.js",
    "tests/fixture_test.py",
    "test/setup.test.ts",
  ]) {
    expect(checkPr(snapshot([commit([source, { filename, status: "added" }])])).ok).toBe(true);
  }
  for (const filename of ["test/mocks/api.test.ts", "src/helpers/format.test.ts"]) {
    expect(checkPr(snapshot([commit([source, { filename, status: "added" }])])).ok).toBe(false);
  }
});

test("an added or changed test in the fix commit passes, but deleting a test does not", () => {
  for (const status of ["added", "modified", "renamed", "copied", "changed"]) {
    expect(checkPr(snapshot([commit([source, { ...changedTest, status }])])).ok).toBe(true);
  }
  const result = checkPr(snapshot([commit([source, { ...changedTest, status: "removed" }])]));
  expect(result.ok).toBe(false);
  expect(result.asyncUiTests).toEqual([]);
});

test("only an explicit nonempty No test line exempts source fixes, never identity", () => {
  for (const body of [
    "No test: presentation-only color adjustment",
    "## Verification\nNo test:  generated source; exercised by upstream suite\r\n",
  ]) {
    expect(checkPr(snapshot([commit([source])], body)).ok).toBe(true);
  }
  for (const body of [
    "No test:",
    "No test:   \nSome unrelated reason",
    "We have No test: reason",
    "No tests: reason",
    null,
  ]) {
    expect(checkPr(snapshot([commit([source])], body)).ok).toBe(false);
  }
  const bad = commit([source]);
  expect(checkPr(snapshot([{ ...bad, commit: { ...bad.commit, committer: null } }], "No test: copy change")).ok).toBe(
    false,
  );
});

test("both identities need nonempty names and the expected email", () => {
  for (const role of ["author", "committer"] as const) {
    for (const identity of [
      null,
      { name: "", email: IDENTITY.email },
      { name: IDENTITY.name, email: "" },
      { name: IDENTITY.name, email: "wrong@example.com" },
    ]) {
      const c = commit([source, changedTest]);
      const result = checkPr(snapshot([{ ...c, commit: { ...c.commit, [role]: identity } }]));
      expect(result.ok).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain(role);
    }
  }
});

test("emails match whatever their case", () => {
  const c = commit([source, changedTest]);
  const upper = { name: IDENTITY.name, email: IDENTITY.email.toUpperCase() };
  expect(checkPr(snapshot([{ ...c, commit: { ...c.commit, author: upper, committer: upper } }])).ok).toBe(true);
  expect(
    checkPr(snapshot([c]), {
      expectedIdentity: { name: IDENTITY.name, email: "12345+Example@Users.NoReply.GitHub.com" },
    }).ok,
  ).toBe(true);
});

test("names may vary and GitHub noreply is accepted only as a merge committer", () => {
  const c = commit([source, changedTest]);
  const renamed = { name: "example", email: IDENTITY.email };
  const github = { name: "GitHub", email: "noreply@github.com" };
  expect(checkPr(snapshot([{ ...c, commit: { ...c.commit, author: renamed, committer: renamed } }])).ok).toBe(true);
  const merge = { ...c, parents: [{ sha }, { sha: otherSha }], commit: { ...c.commit, committer: github } };
  expect(checkPr(snapshot([merge])).ok).toBe(true);
  expect(checkPr(snapshot([{ ...merge, parents: [{ sha }] }])).ok).toBe(false);
  expect(checkPr(snapshot([{ ...merge, commit: { ...merge.commit, author: github } }])).ok).toBe(false);
  expect(checkPr(fixture("browser-test-only")).warnings).toEqual([]);
});

test("a configured noreply@github.com identity does not let GitHub's address pass outside a merge committer", () => {
  const github = { name: "GitHub", email: "noreply@github.com" };
  const c = commit([source, changedTest]);
  const byGithub = { ...c, commit: { ...c.commit, author: github, committer: github } };
  const result = checkPr(snapshot([byGithub]), { expectedIdentity: github });
  expect(result.ok).toBe(false);
  expect(result.errors).toHaveLength(2);
  expect(
    checkPr(snapshot([{ ...byGithub, parents: [{ sha }, { sha: otherSha }] }]), { expectedIdentity: github }).errors,
  ).toHaveLength(1);
});

test("a configured identity without a string name or email fails before a GitHub read, without throwing", async () => {
  const run: Runner = async () => {
    throw new Error("gh must not be called");
  };
  for (const bad of [{ email: IDENTITY.email }, { name: "Example Dev", email: 12345 }, null]) {
    const result = await verifyPr("acme/app", 99, run, { expectedIdentity: bad as unknown as CommitIdentity });
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("repoIdentities");
  }
});

test("a repo with no configured identity fails before a GitHub read", async () => {
  const p = { ...snapshot(), repo: "acme/other" };
  const fake = recordedRunner(p);
  expect((await verifyPr(p.repo, p.number, fake.run)).ok).toBe(false);
  expect(fake.calls).toHaveLength(0);
  expect((await verifyPr(p.repo, p.number, fake.run, { expectedIdentity: IDENTITY })).ok).toBe(true);
  expect(checkPr(snapshot(), { expectedIdentity: { name: "", email: "" } }).ok).toBe(false);
});
