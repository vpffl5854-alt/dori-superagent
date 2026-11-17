// The two rules the duty loop applies to a running lane. Both are pure: the caller reads the lane, the clock and the
// screen, and this file decides. Thresholds are deliberately conservative, so a normal retry is never a finding.
import type { Lane } from "./store-types.ts";

export const DEFAULT_BUDGET_MIN = 40;
export const BUDGET_FACTOR = 1.5;
export const REPEAT_THRESHOLD = 3;
export const SAME_COMMAND_THRESHOLD = 4;
// Only scratch-looking paths count: /tmp files, debug scripts, stray logs. A repo source file does not.
const SCRATCH_PATH =
  /(?:^|[\s'"=])((?:\/tmp|\/private\/tmp|\/var\/folders)\/\S+|\S*(?:dbg|debug|tmp|scratch)\S*\.(?:m?[jt]s|cjs|sh|log|json|txt)|[^\s/]+\.log)\b/g;
// The verbs that write or remove a file; a read (cat, grep, git status) is not a loop on its own.
const WRITE_VERB =
  /(?:^|[|;&(]\s*)(?:rm\s|cp\s|mv\s|sed\s|tee\s|touch\s|cat\s*>|echo\s*>|\S+\.(?:m?[jt]s|cjs|sh)(?:\s|$))/;
// A command line that is only a command name and a few arguments, so a long script never counts as "the same command".
const SHORT_COMMAND = 80;

export type WatchdogFinding =
  | { readonly rule: "budget"; readonly key: string; readonly budgetMin: number; readonly elapsedMin: number }
  | { readonly rule: "repeat"; readonly key: string; readonly path: string; readonly count: number };

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
    if (line.length <= SHORT_COMMAND && !line.includes("[REPORT]") && !line.includes("[LEAD]"))
      commands.set(line, (commands.get(line) ?? 0) + 1);
  }
  const loop = [...paths.values()].find((p) => p.count >= REPEAT_THRESHOLD);
  if (loop) return { rule: "repeat", key: "", path: loop.path, count: loop.count };
  const same = [...commands.entries()].find(([, count]) => count >= SAME_COMMAND_THRESHOLD);
  if (same) return { rule: "repeat", key: "", path: `same command x${same[1]}: ${same[0]}`, count: same[1] };
  return undefined;
}

export function findingText(f: WatchdogFinding, note?: string): string {
  const why =
    f.rule === "budget"
      ? `시간 초과로 자동 종료(예산 ${f.budgetMin}분 x${BUDGET_FACTOR}, 경과 ${f.elapsedMin}분)`
      : `반복 작업 감지로 자동 종료(같은 경로 ${f.count}회: ${f.path})`;
  return `[WATCHDOG] ${f.key} ${why}${note ? `; ${note}` : ""}`;
}
