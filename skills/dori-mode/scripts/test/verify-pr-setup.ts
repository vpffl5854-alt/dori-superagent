import { expect } from "bun:test";
import { readFileSync } from "node:fs";
import type { Runner, RunOptions } from "../src/run.ts";
import {
  checkPr as checkWith,
  type CommitIdentity,
  type PrCommit,
  type PrSnapshot,
  type VerifyPrOptions,
} from "../src/verify-pr-check.ts";

// Synthetic fixtures in the shape of GitHub's API, one per case; see each file's commits for the case it covers.
export const FIXTURES = [
  "fix-with-own-ui-test",
  "fix-then-untested-copy-fix",
  "tests-in-later-commits",
  "follow-up-fixes-without-tests",
  "fixture-file-is-not-a-test",
  "wrong-commit-email",
  "release-chore",
  "browser-test-only",
] as const;

export const fixture = (name: string): PrSnapshot =>
  JSON.parse(readFileSync(new URL(`./fixtures/verify-pr/${name}.json`, import.meta.url), "utf8"));

export const IDENTITY: CommitIdentity = { name: "Example Dev", email: "12345+example@users.noreply.github.com" };

export const withIdentity: VerifyPrOptions = { expectedIdentity: IDENTITY };

export const checkPr = (p: PrSnapshot, options: VerifyPrOptions = {}) => checkWith(p, { ...withIdentity, ...options });

export const shaOf = (p: PrSnapshot, message: string): string =>
  p.commits.find((c) => c.commit.message === message)?.sha ?? "";

export const sha = "a".repeat(40);

export const otherSha = "b".repeat(40);

export const commit = (files: PrCommit["files"], message = "fix(ui): preserve pending work", id = sha): PrCommit => ({
  sha: id,
  commit: { message, author: IDENTITY, committer: IDENTITY },
  files,
});

export const source = { filename: "src/features/Dialog.tsx", status: "modified" };

export const changedTest = {
  filename: "src/features/Dialog.test.tsx",
  status: "modified",
  patch: "+test('pending', async () => { await ready; });",
};

export const snapshot = (
  commits: readonly PrCommit[] = [commit([source, changedTest])],
  body: string | null = null,
): PrSnapshot => ({
  repo: "acme/app",
  number: 99,
  head: commits.at(-1)?.sha ?? sha,
  body,
  commits,
  files: commits.flatMap((c) => c.files),
});

export const json = (value: unknown) => ({ code: 0, out: JSON.stringify(value), err: "" });

export const recordedRunner = (
  p: PrSnapshot,
): { run: Runner; calls: { argv: readonly string[]; opts?: RunOptions | undefined }[] } => {
  const calls: { argv: readonly string[]; opts?: RunOptions | undefined }[] = [];
  const run: Runner = async (argv, opts) => {
    calls.push({ argv, opts });
    // The endpoint is checked by the dispatch below; any other argument fails here.
    expect(argv).toEqual(["gh", "api", "--method", "GET", argv[4]!]);
    const endpoint = argv[4]!;
    if (endpoint === `repos/${p.repo}/pulls/${p.number}`)
      return json({ body: p.body, head: { sha: p.head }, commits: p.commits.length });
    if (endpoint.includes(`/pulls/${p.number}/commits?`)) {
      const page = Number(new URLSearchParams(endpoint.split("?")[1]).get("page"));
      return json(p.commits.slice((page - 1) * 100, page * 100).map((c) => ({ sha: c.sha })));
    }
    if (endpoint.includes(`/pulls/${p.number}/files?`)) {
      const page = Number(new URLSearchParams(endpoint.split("?")[1]).get("page"));
      return json(p.files.slice((page - 1) * 100, page * 100));
    }
    const c = p.commits.find((c) => endpoint.startsWith(`repos/${p.repo}/commits/${c.sha}?`));
    if (c) {
      const page = Number(new URLSearchParams(endpoint.split("?")[1]).get("page"));
      return json({ ...c, files: c.files.slice((page - 1) * 100, page * 100) });
    }
    throw new Error(`unexpected read ${endpoint}`);
  };
  return { run, calls };
};
