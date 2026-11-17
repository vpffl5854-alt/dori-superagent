// The rules the duty loop applies to a running lane. All are pure: the caller reads the lane, the clock, the screen
// and the repeat-guard log, and this file decides. Thresholds are deliberately conservative, so a normal retry is
// never a finding.
import { readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { Lane } from "./store-types.ts";

export const DEFAULT_BUDGET_MIN = 40;
export const BUDGET_FACTOR = 1.5;
export const REPEAT_THRESHOLD = 3;
export const SAME_COMMAND_THRESHOLD = 4;
export const BLOCKED_WINDOW_MIN = 15;
export const BLOCKED_THRESHOLD = 5;
// Only scratch-looking paths count: /tmp files, debug scripts, stray logs. A repo source file does not.
const SCRATCH_PATH =
  /(?:^|[\s'"=])((?:\/tmp|\/private\/tmp|\/var\/folders)\/\S+|\S*(?:dbg|debug|tmp|scratch)\S*\.(?:m?[jt]s|cjs|sh|log|json|txt)|[^\s/]+\.log)\b/g;
// The verbs that write or remove a file; a read (cat, grep, git status) is not a loop on its own.
const WRITE_VERB =
  /(?:^|[|;&(]\s*)(?:rm\s|cp\s|mv\s|sed\s|tee\s|touch\s|cat\s*>|echo\s*>|\S+\.(?:m?[jt]s|cjs|sh)(?:\s|$))/;
// A command line that is only a command name and a few arguments, so a long script never counts as "the same command".
const SHORT_COMMAND = 80;
// A tool's own result line (`✓ <1s`, `✗ exit 1`, `done · 1 call`): every run of any tool prints one, so counting them
// makes a lane that worked a lot look like a lane that ran one command over and over.
const TOOL_RESULT_LINE = /^[✓✗✕·•]\s/;
const TOOL_RESULT_TAIL = /\s(?:done|failed)\s·\s/;
// The prompt a lane is opened with, and the routing line a turn opens with: printed once per turn, not run by the lane.
const PROMPT_LINE = /^(?:Ask:|I read this as)\s/;
// A pane's frame line (`│`, `─`, `❯`): drawn by the terminal, never a command the lane ran, and the same on every turn.
const FRAME_LINE = /^[│┃┆┊╎╏─━═─❯>·•\s]+$/;
// An ellipsis the pane prints where it cut a line short (`...`), not a command.
const ELLIPSIS_LINE = /^[.…]+$/;

export type WatchdogFinding =
  | { readonly rule: "budget"; readonly key: string; readonly budgetMin: number; readonly elapsedMin: number }
  | { readonly rule: "repeat"; readonly key: string; readonly path: string; readonly count: number }
  | { readonly rule: "blocked"; readonly key: string; readonly count: number; readonly windowMin: number };

export const budgetMin = (lane: Lane): number => lane.budgetMin ?? DEFAULT_BUDGET_MIN;

// Rule 1: past BUDGET_FACTOR times the declared budget. A READY, done or lost lane is never a finding.
export function budgetOverrun(lane: Lane, now: number): WatchdogFinding | undefined {
  if (lane.status !== "working") return undefined;
  const budget = budgetMin(lane);
  if (!(budget > 0)) return undefined;
  const elapsedMin = (now - lane.createdAt) / 60_000;
  return elapsedMin > budget * BUDGET_FACTOR
    ? { rule: "budget", key: lane.key, budgetMin: budget, elapsedMin: Math.floor(elapsedMin) }
    : undefined;
}

// A scratch path as one path: a suffix of random characters (/tmp/proxy-dbg-1234.mjs) is the same file.
export const pathFamily = (path: string): string => {
  const stem = /^(.*)[-_][0-9]+(\.[a-z]+)?$/.exec(path);
  return stem === null ? path : (stem[1] ?? "") + (stem[2] ?? "");
};

const commandLines = (screen: string): string[] =>
  Bun.stripANSI(screen)
    .split("\n")
    .map((line) => line.trim())
    .map((line) => line.replace(/^[^\w/]*[❯$>]\s+/, "").trim())
    .filter(Boolean);

// Rule 2: one scratch path written or removed REPEAT_THRESHOLD times, or one short command run SAME_COMMAND_THRESHOLD
// times, on the visible screen. The screen is the lane's recent history, so its own length is the window.
export function repeatedScratch(screen: string): WatchdogFinding | undefined {
  const paths = new Map<string, { path: string; count: number }>();
  const commands = new Map<string, number>();
  for (const line of commandLines(screen)) {
    const writes = WRITE_VERB.test(line);
    for (const match of line.matchAll(SCRATCH_PATH)) {
      const path = match[1] ?? "";
      if (!writes) continue;
      const family = pathFamily(path);
      const seen = paths.get(family) ?? { path, count: 0 };
      paths.set(family, { path: seen.path, count: seen.count + 1 });
    }
    if (
      line.length <= SHORT_COMMAND &&
      !TOOL_RESULT_LINE.test(line) &&
      !TOOL_RESULT_TAIL.test(line) &&
      !PROMPT_LINE.test(line) &&
      !FRAME_LINE.test(line) &&
      !ELLIPSIS_LINE.test(line) &&
      !line.includes("[REPORT]") &&
      !line.includes("[LEAD]")
    )
      commands.set(line, (commands.get(line) ?? 0) + 1);
  }
  const loop = [...paths.values()].find((p) => p.count >= REPEAT_THRESHOLD);
  if (loop) return { rule: "repeat", key: "", path: loop.path, count: loop.count };
  const same = [...commands.entries()].find(([, count]) => count >= SAME_COMMAND_THRESHOLD);
  if (same) return { rule: "repeat", key: "", path: `same command x${same[1]}: ${same[0]}`, count: same[1] };
  return undefined;
}

// Rule 3 input: one line of ~/.dori/logs/repeat-guard.log, the JSONL the omo repeat-guard extension appends. Only a
// blocked record with a target is kept; anything else (a broken line, another verdict, a record without a target) is
// dropped silently, because a log is not a contract.
type BlockedRecord = { readonly at: number; readonly target: string };

export const parseBlocked = (line: string): BlockedRecord | undefined => {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null) return undefined;
  const { ts, verdict, target } = raw as Record<string, unknown>;
  if (verdict !== "blocked" || typeof ts !== "string" || typeof target !== "string") return undefined;
  const at = Date.parse(ts);
  return Number.isFinite(at) ? { at, target } : undefined;
};

// A lane is named only by a target that carries its cwd as a whole path: /worktrees/a must not claim
// /worktrees/a2/..., and the cwd alone (a command run at the lane root) names it too. A record that names no lane
// counts for none.
const namesLane = (target: string, cwd: string): boolean => {
  const dir = resolve(cwd);
  return [`${dir}${sep}`, `${dir}/`].some((p) => target.includes(p)) || target.trim() === dir;
};

// Rule 3: BLOCKED_THRESHOLD calls of the lane blocked by the repeat-guard within BLOCKED_WINDOW_MIN. The guard stops
// one call; a lane that keeps earning blocks is stuck, and the log is the record of it.
export function repeatedBlocks(
  lane: Lane,
  lines: readonly string[],
  now: number,
  windowMin = BLOCKED_WINDOW_MIN,
): WatchdogFinding | undefined {
  const since = now - windowMin * 60_000;
  let count = 0;
  for (const line of lines) {
    const record = parseBlocked(line);
    if (record && record.at >= since && record.at <= now && namesLane(record.target, lane.cwd)) count++;
  }
  return count >= BLOCKED_THRESHOLD ? { rule: "blocked", key: lane.key, count, windowMin } : undefined;
}

// The log's lines, or none when the file is missing or unreadable: no log is no evidence of a loop.
export function readBlockedLog(path: string): string[] {
  try {
    return readFileSync(path, "utf8").split("\n");
  } catch {
    return [];
  }
}

export function findingText(f: WatchdogFinding, note?: string): string {
  const why =
    f.rule === "budget"
      ? `시간 초과로 자동 종료(예산 ${f.budgetMin}분 x${BUDGET_FACTOR}, 경과 ${f.elapsedMin}분)`
      : f.rule === "repeat"
        ? `반복 작업 감지로 자동 종료(같은 경로 ${f.count}회: ${f.path})`
        : `repeat-guard 차단 반복으로 자동 종료(${f.windowMin}분 안에 ${f.count}건)`;
  return `[WATCHDOG] ${f.key} ${why}${note ? `; ${note}` : ""}`;
}
