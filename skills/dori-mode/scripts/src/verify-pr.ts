import type { Runner } from "./run.ts";
import {
  checkPr,
  failed,
  optionErrors,
  type PrCommit,
  type PrFile,
  type VerifyPrOptions,
  type VerifyPrResult,
} from "./verify-pr-check.ts";

export const verifyPr = async (
  repo: string,
  number: number,
  run: Runner,
  options: VerifyPrOptions = {},
): Promise<VerifyPrResult> => {
  const errors = optionErrors(repo, number, options);
  if (errors.length) return failed(repo, number, errors);
  const api = async (endpoint: string): Promise<unknown> => {
    const r = await run(["gh", "api", "--method", "GET", endpoint], {
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      timeoutMs: 120_000,
    });
    if (r.code !== 0) throw new Error(`gh api ${endpoint}: exit ${r.code}: ${(r.err || r.out).trim()}`);
    try {
      return JSON.parse(r.out);
    } catch {
      throw new Error(`gh api ${endpoint}: invalid JSON`);
    }
  };
  try {
    const root = `repos/${repo}`;
    const metadata = (value: unknown): { body: string | null; head: { sha: string }; commits: number } => {
      const p = value as { body?: unknown; head?: { sha?: unknown }; commits?: unknown } | null;
      if (
        !p ||
        (p.body !== null && typeof p.body !== "string") ||
        typeof p.head?.sha !== "string" ||
        !/^[a-f0-9]{40}$/i.test(p.head.sha) ||
        !Number.isSafeInteger(p.commits) ||
        Number(p.commits) < 1
      )
        throw new Error("incomplete PR metadata");
      return p as { body: string | null; head: { sha: string }; commits: number };
    };
    const before = metadata(await api(`${root}/pulls/${number}`));
    const listed: { sha: string }[] = [];
    for (let page = 1; ; page++) {
      const rows = await api(`${root}/pulls/${number}/commits?per_page=100&page=${page}`);
      if (!Array.isArray(rows) || !rows.every((c) => c && typeof c.sha === "string" && /^[a-f0-9]{40}$/i.test(c.sha)))
        throw new Error("incomplete PR commit list");
      listed.push(...rows);
      // More commits than the PR reports fails the count check below instead of paging forever.
      if (rows.length < 100 || listed.length > before.commits) break;
    }
    if (listed.length !== before.commits || new Set(listed.map((c) => c.sha)).size !== listed.length)
      throw new Error(`incomplete PR commit list: received ${listed.length}, expected ${before.commits}`);
    if (listed.at(-1)?.sha !== before.head.sha) throw new Error("PR commit list does not end at the current head");
    const commits: PrCommit[] = [];
    for (const listedCommit of listed) {
      const files: PrFile[] = [];
      let commit: PrCommit | undefined;
      for (let page = 1; ; page++) {
        const c = (await api(`${root}/commits/${listedCommit.sha}?per_page=100&page=${page}`)) as PrCommit | null;
        if (
          !c ||
          c.sha !== listedCommit.sha ||
          typeof c.commit?.message !== "string" ||
          !("author" in c.commit) ||
          !("committer" in c.commit) ||
          !Array.isArray(c.files) ||
          !c.files.every(
            (f) =>
              typeof f.filename === "string" &&
              typeof f.status === "string" &&
              (f.patch === undefined || typeof f.patch === "string") &&
              (f.previous_filename === undefined || typeof f.previous_filename === "string"),
          )
        )
          throw new Error(`incomplete commit data for ${listedCommit.sha}`);
        commit = c;
        files.push(...c.files);
        if (c.files.length < 100) break;
        if (page >= 30) throw new Error(`${listedCommit.sha}: cannot verify beyond GitHub's 3000-file commit limit`);
      }
      commits.push({ ...commit, files });
    }
    const files: PrFile[] = [];
    for (let page = 1; ; page++) {
      const rows = await api(`${root}/pulls/${number}/files?per_page=100&page=${page}`);
      if (
        !Array.isArray(rows) ||
        !rows.every((f) => f && typeof f.filename === "string" && typeof f.status === "string")
      )
        throw new Error("incomplete PR file list");
      files.push(...rows);
      if (rows.length < 100) break;
      if (page >= 30) throw new Error("cannot verify beyond GitHub's 3000-file PR limit");
    }
    const after = metadata(await api(`${root}/pulls/${number}`));
    if (before.head.sha !== after.head.sha || before.body !== after.body || before.commits !== after.commits)
      throw new Error("PR changed during verification; run verify-pr again");
    return checkPr({ repo, number, body: before.body, head: before.head.sha, commits, files }, options);
  } catch (e) {
    return failed(repo, number, [e instanceof Error ? e.message : String(e)]);
  }
};

export const formatVerifyPr = (result: VerifyPrResult): string =>
  [
    `${result.ok ? "PASS" : "FAIL"} ${result.repo}#${result.number}${result.head ? ` at ${result.head}` : ""}`,
    ...result.errors.map((error) => `- ${error}`),
    ...result.warnings.map((warning) => `WARNING ${warning}`),
    ...(result.asyncUiTests.length
      ? [
          "Async UI loop candidates (conservative; not executed):",
          ...result.asyncUiTests.map((file) => `- ${file}`),
          `Run from the repository checkout at ${result.head}:`,
          result.loopCommand!,
        ]
      : ["No changed async UI test candidates found; no loop executed."]),
  ].join("\n");
