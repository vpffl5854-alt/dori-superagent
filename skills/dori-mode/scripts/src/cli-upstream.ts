/** dori upstream [--report] | apply <branch>: follow the original repository without touching the live checkout. */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { IncidentsConfig } from "./cli-incidents.ts";
import { type Command, die } from "./cli-context.ts";
import { fill } from "./config.ts";
import { run } from "./run.ts";
import { type SyncResult, syncBrief, syncKey, syncMessage } from "./upstream.ts";

export type UpstreamConfig = { readonly branch?: string; readonly upstream?: string; readonly push?: string };

const REPO = resolve(import.meta.dir, "../../../..");
const CI_TIMEOUT_MS = 20 * 60_000;

const sync = async (branch: string, upstream: string, push: string): Promise<SyncResult & { head: string }> => {
  const git = (cwd: string, ...a: string[]) => run(["git", "-C", cwd, ...a], { timeoutMs: 120_000 });
  await git(REPO, "fetch", "-q", upstream.split("/")[0] ?? "origin");
  const head = (await git(REPO, "rev-parse", upstream)).out.trim();
  const commits = (await git(REPO, "log", "--format=%s", `${branch}..${upstream}`)).out.split("\n").filter(Boolean);
  if (commits.length === 0) return { kind: "level", head };
  const dir = join(mkdtempSync(join(tmpdir(), "dori-upstream-")), "wt");
  try {
    await git(REPO, "worktree", "add", "-q", "--detach", dir, branch);
    const m = await run(
      [
        "git",
        "-C",
        dir,
        "-c",
        "user.name=dori",
        "-c",
        "user.email=dori@localhost",
        "merge",
        "--no-edit",
        "-q",
        upstream,
      ],
      { timeoutMs: 120_000 },
    );
    if (m.code !== 0) {
      const files = (await git(dir, "diff", "--name-only", "--diff-filter=U")).out.split("\n").filter(Boolean);
      await git(dir, "merge", "--abort");
      return { kind: "conflict", files, commits, head };
    }
    for (const cwd of [dir, join(dir, "skills/dori-mode/scripts")])
      await run(["bun", "install"], { cwd, timeoutMs: 600_000 });
    const ci = await run(["bun", "run", "ci"], { cwd: dir, timeoutMs: CI_TIMEOUT_MS });
    const key = syncKey(head);
    await git(dir, "branch", "-f", key, "HEAD");
    await git(REPO, "push", "-q", "-f", push, `${key}:${key}`);
    if (ci.code !== 0)
      return {
        kind: "red",
        branch: key,
        tail: `${ci.out}\n${ci.err}`.trim().split("\n").slice(-15).join("\n"),
        commits,
        head,
      };
    return { kind: "ready", branch: key, commits, head };
  } finally {
    await git(REPO, "worktree", "remove", "--force", dir);
    rmSync(join(dir, ".."), { recursive: true, force: true });
  }
};

const upstream: Command = async ({ positionals, values, config }) => {
  const cfg = (config as { upstream?: UpstreamConfig }).upstream ?? {};
  const branch = cfg.branch ?? "discord-lane-answer";
  const up = cfg.upstream ?? "origin/main";
  const push = cfg.push ?? "mine";
  if (positionals[0] === "apply") {
    // The owner said yes: fast-forward the live branch to the tested sync branch, and nothing else.
    const key = positionals[1] ?? die("apply needs the sync branch (upstream-xxxxxxxx)");
    const cur = (await run(["git", "-C", REPO, "branch", "--show-current"])).out.trim();
    if (cur !== branch) die(`the live checkout is on ${cur}, not ${branch}`);
    const ff = await run(["git", "-C", REPO, "merge", "--ff-only", key]);
    if (ff.code !== 0) die(`UPSTREAM_APPLY_FAILED ${ff.err.slice(0, 200)}`);
    await run(["git", "-C", REPO, "push", "-q", push, branch]);
    return void console.log(`UPSTREAM_APPLIED ${key} -> ${branch} (restart long-running services to load it)`);
  }
  const r = await sync(branch, up, push);
  console.log(
    r.kind === "level"
      ? "UPSTREAM_LEVEL"
      : `UPSTREAM_${r.kind.toUpperCase()} ${r.commits.length} commits${"files" in r ? ` conflicts=${r.files.join(",")}` : ""}${"branch" in r ? ` branch=${r.branch}` : ""}`,
  );
  if (values["report"] !== true || r.kind === "level") return;
  const statePath = join(config.stateDir, "upstream.json");
  const last = existsSync(statePath)
    ? (JSON.parse(readFileSync(statePath, "utf8")) as { head?: string }).head
    : undefined;
  if (last === r.head) return void console.log("UPSTREAM_ALREADY_REPORTED");
  const key = syncKey(r.head);
  const text = syncMessage(r, key) ?? "";
  const inc = (config as { incidents?: IncidentsConfig }).incidents ?? {};
  if (r.kind !== "ready" && inc.harness?.length) {
    const dir = join(config.stateDir, "upstream");
    mkdirSync(dir, { recursive: true });
    const brief = join(dir, `${key}.md`);
    writeFileSync(brief, syncBrief(r, key, up));
    await run(
      [...inc.harness, "backlog", "add", key, "--brief", brief, "--title", `${key} 원본 따라잡기`, "--priority", "5"],
      { timeoutMs: 60_000 },
    );
  }
  for (const argv of [inc.notifyArgv, inc.leadArgv])
    if (argv?.length) await run(fill(argv, { text }), { timeoutMs: 60_000 });
  writeFileSync(statePath, JSON.stringify({ head: r.head, kind: r.kind, at: new Date().toISOString() }));
  console.log(`UPSTREAM_REPORTED ${key}`);
};

export const upstreamCommands: Readonly<Record<string, Command>> = { upstream };
