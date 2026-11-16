import { expect, test } from "bun:test";
import { cliCommand, footer } from "../src/launch-footer.ts";
import type { Runner } from "../src/run.ts";
import { formatVerifyPr, verifyPr } from "../src/verify-pr.ts";
import {
  fixture,
  IDENTITY,
  withIdentity,
  checkPr,
  sha,
  otherSha,
  commit,
  source,
  changedTest,
  snapshot,
  json,
  recordedRunner,
} from "./verify-pr-setup.ts";

test("fix source classification includes styles, scripts, deletions, and old renamed source paths", () => {
  for (const file of [
    { filename: "src/ui.css", status: "modified" },
    { filename: "distribution/release/collect.mjs", status: "modified" },
    { filename: "src/old.ts", status: "removed" },
    { filename: "docs/retired.txt", previous_filename: "src/old.ts", status: "renamed" },
  ])
    expect(checkPr(snapshot([commit([file])])).ok).toBe(false);
  for (const file of [
    { filename: "docs/example.ts", status: "modified" },
    { filename: "README.md", status: "modified" },
  ]) {
    expect(checkPr(snapshot([commit([file])])).ok).toBe(true);
  }
  expect(checkPr(snapshot([commit([source], "feat(ui): add dialog")])).ok).toBe(true);
  expect(checkPr(snapshot([commit([source], "fix(ui)!: change dialog contract")])).ok).toBe(false);
});

test("an unscoped fix: or fix!: commit that touches source needs a test like a scoped one", () => {
  for (const message of ["fix: deliver to omo panes", "fix!: change dialog contract"]) {
    expect(checkPr(snapshot([commit([source], message)])).ok).toBe(false);
    expect(checkPr(snapshot([commit([source, changedTest], message)])).ok).toBe(true);
  }
  expect(checkPr(snapshot([commit([source], "fixup: tidy")])).ok).toBe(true);
});

test("async UI candidates include browser tests with .ts extensions, are deduplicated, and are never run", async () => {
  const p = fixture("browser-test-only");
  const fake = recordedRunner(p);
  const result = await verifyPr(p.repo, p.number, fake.run, { ...withIdentity, loopCount: 50, cwd: "/owned/checkout" });
  expect(result.ok).toBe(true);
  expect(result.asyncUiTests).toEqual(["src/features/settings/Templates.test.ts"]);
  expect(result.loopCommand).toContain('[ "$i" -lt 50 ]');
  expect(result.loopCommand).toContain("bun --no-env-file test './src/features/settings/Templates.test.ts'");
  expect(result.loopCommand).toContain("|| exit $?");
  expect(
    fake.calls.every((c) => c.argv[0] === "gh" && c.opts?.cwd === "/owned/checkout" && c.opts?.timeoutMs === 120_000),
  ).toBe(true);
  expect(formatVerifyPr(result)).toContain(p.head);
});

test("loop candidates include DOM patch evidence outside UI directories and shell-quote paths", () => {
  const file = {
    filename: "test/we'ird.test.ts",
    status: "modified",
    patch: "+const browser = new Bun.WebView();\n+await browser.navigate('/');",
  };
  const result = checkPr(snapshot([commit([file], "test: browser regression")]));
  expect(result.asyncUiTests).toEqual([file.filename]);
  expect(result.loopCommand).toContain("'./test/we'\\''ird.test.ts'");
  expect(
    checkPr(snapshot([commit([{ filename: "src/server/service.test.ts", status: "added" }], "test: server")]))
      .loopCommand,
  ).toBeUndefined();
});

test("a later deletion or rename does not leave an unrunnable old test in the loop command", () => {
  const removed = commit([{ ...changedTest, status: "removed" }], "test(ui): retire old regression", otherSha);
  expect(checkPr(snapshot([commit([changedTest], "test(ui): add regression"), removed])).asyncUiTests).toEqual([]);
  const renamed = commit(
    [
      {
        ...changedTest,
        filename: "src/features/NewDialog.test.tsx",
        previous_filename: changedTest.filename,
        status: "renamed",
      },
    ],
    "test(ui): rename regression",
    otherSha,
  );
  expect(checkPr(snapshot([commit([changedTest], "test(ui): add regression"), renamed])).asyncUiTests).toEqual([
    "src/features/NewDialog.test.tsx",
  ]);
});

test("invalid inputs fail without calling gh", async () => {
  const fake = recordedRunner(snapshot());
  for (const [repo, number, loopCount] of [
    ["--help", 1, 20],
    ["acme/app", 0, 20],
    ["acme/app", 1.5, 20],
    ["acme/app", 1, 0],
    ["acme/app", 1, Infinity],
  ] as const) {
    expect((await verifyPr(repo, number, fake.run, { ...withIdentity, loopCount })).ok).toBe(false);
  }
  expect(fake.calls).toHaveLength(0);
});

test("GitHub command failures and invalid JSON fail closed", async () => {
  for (const r of [
    { code: 1, out: "", err: "authentication failed" },
    { code: 0, out: "not json", err: "" },
  ]) {
    expect((await verifyPr("acme/app", 3, async () => r, withIdentity)).ok).toBe(false);
  }
  expect(
    (
      await verifyPr(
        "acme/app",
        3,
        async () => {
          throw new Error("offline");
        },
        withIdentity,
      )
    ).ok,
  ).toBe(false);
});

test("missing metadata, incomplete commit lists, and missing commit identities fail closed", async () => {
  const p = snapshot();
  for (const alter of [
    (endpoint: string) => (endpoint.endsWith("/pulls/99") ? { head: { sha }, commits: 1 } : undefined),
    (endpoint: string) => (endpoint.includes("/pulls/99/commits?") ? [] : undefined),
    (endpoint: string) =>
      endpoint.includes(`/commits/${sha}?`) ? { sha, commit: { message: "fix(ui): bad" }, files: [] } : undefined,
    (endpoint: string) => (endpoint.includes(`/commits/${sha}?`) ? { ...p.commits[0], files: undefined } : undefined),
  ]) {
    const fake = recordedRunner(p);
    const run: Runner = async (argv, opts) => {
      const value = alter(argv[4]!);
      return value === undefined ? fake.run(argv, opts) : json(value);
    };
    expect((await verifyPr(p.repo, p.number, run, withIdentity)).ok).toBe(false);
  }
});

test("commit-file pagination finds a test beyond the first hundred files", async () => {
  const files = [
    ...Array.from({ length: 100 }, (_, i) => ({ filename: `src/file-${i}.ts`, status: "modified" })),
    changedTest,
  ];
  const p = snapshot([commit(files)]);
  const fake = recordedRunner(p);
  expect((await verifyPr(p.repo, p.number, fake.run, withIdentity)).ok).toBe(true);
  expect(fake.calls.some((c) => c.argv[4]!.includes(`/commits/${sha}?per_page=100&page=2`))).toBe(true);
});

test("PR commit pagination checks identities beyond the first hundred commits", async () => {
  const commits = Array.from({ length: 101 }, (_, i) =>
    commit([changedTest], "test(ui): regression", i.toString(16).padStart(40, "0")),
  );
  const last = commits[100]!;
  commits[100] = { ...last, commit: { ...last.commit, author: null } };
  const p = snapshot(commits);
  const fake = recordedRunner(p);
  const result = await verifyPr(p.repo, p.number, fake.run, withIdentity);
  expect(result.ok).toBe(false);
  expect(result.errors).toHaveLength(1);
  expect(result.errors[0]).toStartWith(last.sha);
});

test("a head or body change during verification is not certified", async () => {
  for (const change of [{ head: { sha: otherSha } }, { body: "No test: new exception" }, { commits: 2 }]) {
    const p = snapshot();
    const fake = recordedRunner(p);
    let reads = 0;
    const run: Runner = async (argv, opts) => {
      if (argv[4] === `repos/${p.repo}/pulls/${p.number}` && ++reads === 2)
        return json({ body: p.body, head: { sha: p.head }, commits: 1, ...change });
      return fake.run(argv, opts);
    };
    expect((await verifyPr(p.repo, p.number, run, withIdentity)).ok).toBe(false);
  }
});

test("a commit list that keeps returning full pages stops at the PR's commit count", async () => {
  const p = snapshot();
  const fake = recordedRunner(p);
  let pages = 0;
  const run: Runner = async (argv, opts) => {
    if (!argv[4]!.includes("/pulls/99/commits?")) return fake.run(argv, opts);
    if (++pages > 5) throw new Error("commit list read past the PR's commit count");
    return json(Array.from({ length: 100 }, () => ({ sha })));
  };
  const result = await verifyPr(p.repo, p.number, run, withIdentity);
  expect(result.ok).toBe(false);
  expect(result.errors[0]).toStartWith("incomplete PR commit list");
  expect(pages).toBe(1);
});

test("a duplicate commit list cannot satisfy the expected count", async () => {
  const p = snapshot([commit([source, changedTest]), commit([changedTest], "test(ui): more", otherSha)]);
  const fake = recordedRunner(p);
  const run: Runner = async (argv, opts) =>
    argv[4]!.includes("/pulls/99/commits?") ? json([{ sha }, { sha }]) : fake.run(argv, opts);
  expect((await verifyPr(p.repo, p.number, run, withIdentity)).ok).toBe(false);
});

test("a commit list for a different head cannot be certified", async () => {
  const p = { ...snapshot(), head: otherSha };
  const fake = recordedRunner(p);
  expect((await verifyPr(p.repo, p.number, fake.run, withIdentity)).ok).toBe(false);
});

test("the lane footer lists configured commit identities and the verify-pr rule", () => {
  const lane = {
    key: "demo-lane",
    title: "demo",
    thread: "none",
    brief: "/b.md",
    done: "merged acme/app#1",
    openedAt: "2026-01-01T00:00:00Z",
  };
  const text = footer(lane, "w1:p1", { "acme/app": IDENTITY });
  expect(text).toContain(`  - acme/app: git -c user.name='Example Dev' -c user.email='${IDENTITY.email}' commit ...`);
  expect(text).toContain(`run ${cliCommand()} verify-pr <owner/repo> <number>`);
  expect(footer(lane, "w1:p1")).not.toContain("Before committing");
});
