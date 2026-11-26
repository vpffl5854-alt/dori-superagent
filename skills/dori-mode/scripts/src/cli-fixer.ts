/**
 * dori fixer [--dry-run] | fixer pending | fixer go <key> | fixer drop <key>: the nightly fixer (fixer.ts). The night
 * run opens at most one lane; the morning briefing shows its result with buttons, and a press runs go or drop.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { decideFix, pendingFixes } from "./cli-fixer-decide.ts";
import { type Command, die } from "./cli-context.ts";
import type { DoriConfig } from "./config.ts";
import {
  type BriefPlaces,
  type Candidate,
  FIX_PREFIX,
  huntFixBrief,
  huntFixKey,
  pickCandidate,
  selfBrief,
  selfKey,
  mentionedNumbers,
  sigOf,
} from "./fixer.ts";
import { cfgOf, harnessOf, readJson, resultPath } from "./fixer-places.ts";
import { fixableFailure, readHistory } from "./mac-learn.ts";
import { run } from "./run.ts";

const DAY = 86_400_000;

/** Faults of the last day: what the incident scanner saw, and the 맥손 tasks that failed for a reason in the code. */
const candidates = (config: DoriConfig, since: number): Candidate[] => {
  const seen = readJson<{ seen?: Record<string, { count?: number; lastAt?: string; file?: string; sample?: string }> }>(
    join(config.stateDir, "incidents.json"),
  );
  const out: Candidate[] = Object.entries(seen?.seen ?? {})
    .filter(([, v]) => Date.parse(v.lastAt ?? "") >= since)
    .map(([sig, v]) => ({
      sig,
      source: `log ${v.file ?? "?"}`,
      count: v.count ?? 1,
      evidence: [(v.sample ?? sig).slice(0, 400)],
    }));
  const mac = new Map<string, Candidate>();
  for (const e of readHistory(join(config.stateDir, "mac"), since).filter(fixableFailure)) {
    const sig = `mac: ${sigOf(e.text)}`;
    const was = mac.get(sig);
    const evidence = [
      `goal: ${e.goal}`,
      `result: ${e.text}`,
      ...e.turns.slice(-8).map((t) => `${t.act} -> ${t.result}`.slice(0, 300)),
    ];
    mac.set(sig, {
      sig,
      source: "맥손 history.jsonl",
      count: (was?.count ?? 0) + 1,
      evidence: was?.evidence ?? evidence,
    });
  }
  return [...out, ...mac.values()];
};

const openFixLane = (home: string): string | undefined =>
  (existsSync(join(home, "lanes")) ? readdirSync(join(home, "lanes")) : [])
    .filter((f) => f.startsWith(FIX_PREFIX) && f.endsWith(".json"))
    .map((f) => readJson<{ key?: string; status?: string }>(join(home, "lanes", f)))
    .find((l) => l?.status === "working" || l?.status === "waiting")?.key;

const laneKeys = (home: string): string[] =>
  (existsSync(join(home, "lanes")) ? readdirSync(join(home, "lanes")) : [])
    .filter((f) => f.endsWith(".json"))
    .map((f) => basename(f, ".json"));

/** An open pull request among the numbers the issue's comments mention ("Fix in progress: #47648"). */
const openPrIn = async (repo: string, numbers: readonly string[]): Promise<string | undefined> => {
  for (const n of numbers) {
    const r = await run(["gh", "pr", "view", n, "-R", repo, "--json", "state", "-q", ".state"]);
    if (r.code === 0 && r.out.trim() === "OPEN") return n;
  }
  return undefined;
};

/** The newest hunt brief whose issue is still open, not claimed by an open PR, and that no fix lane has had. */
const huntPick = async (c: ReturnType<typeof cfgOf>, tried: Record<string, string>, stateDir: string) => {
  const dir = join(stateDir, "hunt");
  const briefs = (existsSync(dir) ? readdirSync(dir) : [])
    .filter((f) => f.endsWith(".md"))
    .map((f) => join(dir, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  for (const path of briefs) {
    const key = huntFixKey(basename(path, ".md"));
    if (tried[key] || existsSync(join(c.home, "lanes", `${key}.json`))) continue;
    const text = readFileSync(path, "utf8");
    const m = /github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)/.exec(text);
    if (!m?.[1] || !m[2]) continue;
    // A hunt lane of any name had this issue before (hunt-49481, hunt-48810b): its answer stands.
    const before = laneKeys(c.home).find((k) => new RegExp(`(^|-)${m[2]}(b|-|$)`).test(k));
    if (before) {
      console.log(`FIXER_SKIP ${key} lane ${before} had it`);
      continue;
    }
    const s = await run(["gh", "issue", "view", m[2], "-R", m[1], "--json", "state,comments"]);
    if (s.code !== 0) continue;
    const issue = JSON.parse(s.out) as { state?: string; comments?: { body?: string }[] };
    if (issue.state !== "OPEN") continue;
    const claimedBy = await openPrIn(m[1], mentionedNumbers(issue.comments ?? [], m[2]));
    if (claimedBy) {
      console.log(`FIXER_SKIP ${key} already claimed by open PR #${claimedBy}`);
      continue;
    }
    return { key, text, repo: m[1], number: m[2] };
  }
  return undefined;
};

const night: Command = async ({ values, config }) => {
  const c = cfgOf(config);
  mkdirSync(c.dir, { recursive: true });
  const busy = openFixLane(c.home);
  if (busy) return void console.log(`FIXER_BUSY ${busy}`);
  const triedPath = join(c.dir, "tried.json");
  const tried = readJson<Record<string, string>>(triedPath) ?? {};
  const now = new Date();
  const dry = values["dry-run"] === true;
  const doriCmd = harnessOf(config).join(" ");
  const pick = pickCandidate(candidates(config, now.getTime() - DAY), tried, now.getTime());
  let key: string;
  let brief: string;
  let cwd: string;
  let tag: string;
  if (pick) {
    key = selfKey(now);
    const p: BriefPlaces = {
      key,
      worktree: join(c.home, "worktrees", key),
      branch: `fix/${key}`,
      base: `${c.remote}/${c.branch}`,
      repo: c.repo,
      live: c.live,
      resultPath: resultPath(c.dir, key),
    };
    brief = selfBrief(pick, p);
    cwd = p.worktree;
    tag = pick.sig;
    if (!dry) {
      await run(["git", "-C", c.live, "fetch", c.remote, c.branch], { timeoutMs: 120_000 });
      const wt = await run(["git", "-C", c.live, "worktree", "add", "-B", p.branch, cwd, p.base], {
        timeoutMs: 120_000,
      });
      if (wt.code !== 0) return void console.log(`FIXER_FAILED worktree ${wt.err.trim().slice(0, 200)}`);
      await run(["bun", "install", "--frozen-lockfile"], { cwd, timeoutMs: 600_000 });
    }
  } else {
    const h = await huntPick(c, tried, config.stateDir);
    if (!h) return void console.log("FIXER_NOTHING");
    key = h.key;
    cwd = c.huntClone;
    tag = key;
    brief = huntFixBrief(h.text, h.repo, {
      key,
      worktree: cwd,
      branch: `claude/${h.number}-${key.slice(-20)}`.replace(/-+$/, ""),
      base: "origin/main",
      repo: h.repo,
      live: c.live,
      resultPath: resultPath(c.dir, key),
    });
  }
  brief = brief.replaceAll("{{dori}}", doriCmd);
  if (dry) return void console.log(`FIXER_DRY ${key}\n${brief}`);
  const briefPath = join(c.home, "briefs", `${key}.md`);
  mkdirSync(dirname(briefPath), { recursive: true });
  writeFileSync(briefPath, brief);
  const h = [...harnessOf(config).slice(0, 1), "DORI_RUNTIME=hc", ...harnessOf(config).slice(1)];
  const s = await run([...h, "start", key, "--brief", briefPath, "--cwd", cwd, "--budget-min", String(c.budgetMin)], {
    timeoutMs: 180_000,
  });
  if (s.code !== 0) return void console.log(`FIXER_FAILED start ${(s.err || s.out).trim().slice(0, 300)}`);
  writeFileSync(triedPath, JSON.stringify({ ...tried, [tag]: now.toISOString() }, null, 2));
  await run(
    [
      ...h,
      "send",
      "lead",
      "--text",
      `[밤 점검] ${key} 레인을 열었다 (${tag.slice(0, 100)}). 이 레인은 review·merge 하지 말고, READY가 되어도 닫지 말 것: 아침 브리핑에서 지브가 버튼으로 정한다.`,
    ],
    { timeoutMs: 60_000 },
  );
  console.log(`FIXER_STARTED ${key} ${briefPath}`);
};

const fixer: Command = async (ctx) => {
  const [sub, key] = ctx.positionals;
  if (!sub) return night(ctx);
  if (sub === "pending") {
    for (const p of pendingFixes(ctx.config)) console.log(`FIX_PENDING ${p.key} ${JSON.stringify(p.result)}`);
    return;
  }
  if ((sub === "go" || sub === "drop") && key)
    return void console.log((await decideFix(ctx.config, key, sub === "go")).line);
  die("usage: fixer [--dry-run] | fixer pending | fixer go|drop <key>");
};

export const fixerCommands: Readonly<Record<string, Command>> = { fixer };
