import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Lane } from "../src/store-types.ts";
import {
  BLOCKED_THRESHOLD,
  BLOCKED_WINDOW_MIN,
  budgetOverrun,
  DEFAULT_BUDGET_MIN,
  findingText,
  parseBlocked,
  pathFamily,
  readBlockedLog,
  repeatedBlocks,
  repeatedScratch,
  SAME_COMMAND_THRESHOLD,
} from "../src/watchdog-rules.ts";

const MIN = 60_000;
const lane = (patch: Partial<Lane> = {}): Lane => ({
  key: "solar-tools",
  sessionRef: { runtime: "herdr", id: "w1:p5" },
  paneId: "w1:p5",
  tabId: "w1:t5",
  brief: "/tmp/brief.md",
  cwd: "/tmp",
  status: "working",
  createdAt: 0,
  lastActivityAt: 0,
  nudges: 0,
  log: [],
  ...patch,
});

describe("watchdog budget rule", () => {
  test("a lane inside 1.5x its declared budget is left alone, and one past it is a finding", () => {
    const declared = lane({ budgetMin: 40 });
    expect(budgetOverrun(declared, 60 * MIN)).toBeUndefined();
    expect(budgetOverrun(declared, 60 * MIN + 1)).toEqual({
      rule: "budget",
      key: "solar-tools",
      budgetMin: 40,
      elapsedMin: 60,
    });
  });

  test("a lane started without --budget-min is held to the 40-minute default", () => {
    expect(DEFAULT_BUDGET_MIN).toBe(40);
    expect(budgetOverrun(lane(), 59 * MIN)).toBeUndefined();
    expect(budgetOverrun(lane(), 61 * MIN)?.rule).toBe("budget");
  });

  test("READY, done, lost and waiting lanes are never a budget finding", () => {
    for (const status of ["ready", "done", "lost"] as const)
      expect(budgetOverrun(lane({ status }), 600 * MIN)).toBeUndefined();
    expect(budgetOverrun(lane({ status: "waiting" }), 61 * MIN)).toBeUndefined();
    expect(budgetOverrun(lane({ budgetMin: 0 }), 600 * MIN)).toBeUndefined();
  });
});

describe("watchdog repeat rule", () => {
  const screen = (...lines: string[]): string => lines.join("\n");

  test("the same scratch path written and removed three times is a finding", () => {
    const found = repeatedScratch(
      screen(
        "$ cat > /tmp/proxy-dbg.mjs <<'EOF'",
        "$ node /tmp/proxy-dbg.mjs",
        "$ rm /tmp/proxy-dbg.mjs",
        "$ cat > /tmp/proxy-dbg-1234.mjs <<'EOF'",
        "$ rm /tmp/proxy-dbg-1234.mjs",
        "$ cat > /tmp/proxy-dbg-5678.mjs <<'EOF'",
        "$ rm /tmp/proxy-dbg-5678.mjs",
      ),
    );
    expect(found?.rule).toBe("repeat");
    if (found?.rule !== "repeat") throw new Error("expected a repeat finding");
    expect(found.path).toBe("/tmp/proxy-dbg.mjs");
    expect(found.count).toBe(6);
  });

  test("two runs of the same test, or a scratch file read twice, is not a loop", () => {
    expect(
      repeatedScratch(screen("$ bun test ./test/login.test.ts", "$ bun test ./test/login.test.ts")),
    ).toBeUndefined();
    expect(
      repeatedScratch(screen("$ cat /tmp/dbg.log", "$ cat /tmp/dbg.log", "$ grep x /tmp/dbg.log")),
    ).toBeUndefined();
    expect(repeatedScratch(screen("$ rm /tmp/dbg.log", "$ rm /tmp/dbg.log"))).toBeUndefined();
  });

  test("a repo source file edited three times is not scratch work", () => {
    expect(
      repeatedScratch(
        screen("$ sed -i '' s/a/b/ src/login.ts", "$ sed -i '' s/b/c/ src/login.ts", "$ sed -i '' s/c/d/ src/login.ts"),
      ),
    ).toBeUndefined();
  });

  test("one short command run SAME_COMMAND_THRESHOLD times is a finding", () => {
    const line = "$ curl -s localhost:3000/health";
    const once = Array.from({ length: SAME_COMMAND_THRESHOLD - 1 }, () => line);
    expect(repeatedScratch(screen(...once))).toBeUndefined();
    const found = repeatedScratch(screen(...once, line));
    expect(found?.rule).toBe("repeat");
    if (found?.rule !== "repeat") throw new Error("expected a repeat finding");
    expect(found.path).toContain("same command");
  });

  test("a path's random suffix names the same file", () => {
    expect(pathFamily("/tmp/dbgflow-17.ts")).toBe("/tmp/dbgflow.ts");
    expect(pathFamily("/tmp/a.log")).toBe("/tmp/a.log");
  });
});

describe("watchdog blocked rule", () => {
  const NOW = Date.parse("2026-11-17T12:00:00.000Z");
  const at = (minAgo: number): string => new Date(NOW - minAgo * MIN).toISOString();
  const blocked = (minAgo: number, target: string): string =>
    JSON.stringify({ ts: at(minAgo), verdict: "blocked", tool: "bash", target, count: 3 });
  const laneIn = (cwd: string): Lane => lane({ cwd, key: "stuck" });
  const CWD = "/Users/jib/.dori-superagent/worktrees/stuck";

  test("a blocked record parses; a broken line, another verdict or no target does not", () => {
    expect(parseBlocked(blocked(1, `${CWD}/x.ts`))).toEqual({ at: NOW - MIN, target: `${CWD}/x.ts` });
    expect(parseBlocked("{not json")).toBeUndefined();
    expect(parseBlocked("")).toBeUndefined();
    expect(parseBlocked("[]")).toBeUndefined();
    expect(parseBlocked(JSON.stringify({ ts: at(1), verdict: "allowed", target: CWD }))).toBeUndefined();
    expect(parseBlocked(JSON.stringify({ ts: at(1), verdict: "blocked", key: "eval:abc" }))).toBeUndefined();
    expect(parseBlocked(JSON.stringify({ ts: "yesterday", verdict: "blocked", target: CWD }))).toBeUndefined();
  });

  test("BLOCKED_THRESHOLD blocks inside the window are a finding; one fewer is not", () => {
    expect(BLOCKED_THRESHOLD).toBe(5);
    expect(BLOCKED_WINDOW_MIN).toBe(15);
    const few = Array.from({ length: BLOCKED_THRESHOLD - 1 }, (_, i) => blocked(i, `${CWD}/mkdbg${i}.ts`));
    expect(repeatedBlocks(laneIn(CWD), few, NOW)).toBeUndefined();
    const found = repeatedBlocks(laneIn(CWD), [...few, blocked(6, `${CWD}`)], NOW);
    expect(found).toEqual({ rule: "blocked", key: "stuck", count: BLOCKED_THRESHOLD, windowMin: 15 });
    expect(findingText(found!, "백업 /x")).toBe(
      "[WATCHDOG] stuck repeat-guard 차단 반복으로 자동 종료(15분 안에 5건); 백업 /x",
    );
  });

  test("records older than the window, or from the future, do not count", () => {
    const old = Array.from({ length: BLOCKED_THRESHOLD }, (_, i) => blocked(16 + i, CWD));
    expect(repeatedBlocks(laneIn(CWD), old, NOW)).toBeUndefined();
    const future = Array.from({ length: BLOCKED_THRESHOLD }, () => blocked(-1, CWD));
    expect(repeatedBlocks(laneIn(CWD), future, NOW)).toBeUndefined();
    const edge = Array.from({ length: BLOCKED_THRESHOLD }, (_, i) => blocked(15 - i * 0.1, CWD));
    expect(repeatedBlocks(laneIn(CWD), edge, NOW)?.rule).toBe("blocked");
  });

  test("only targets carrying this lane's cwd count; other lanes and bare commands never trip it", () => {
    const other = "/Users/jib/.dori-superagent/worktrees/stuck-2";
    const mixed = [
      blocked(1, CWD),
      blocked(2, `${CWD}/src/a.ts`),
      blocked(3, other),
      blocked(4, `${other}/src/b.ts`),
      blocked(5, "grep /tmp/x.log foo"),
      blocked(6, JSON.stringify({ ts: at(6), verdict: "blocked", key: "eval:abc" })),
    ];
    // The lane's own cwd is "stuck"; "stuck-2" is a sibling worktree and its records are never counted.
    expect(repeatedBlocks(laneIn(CWD), mixed, NOW)).toBeUndefined();
    const both = [...mixed, blocked(7, CWD), blocked(8, CWD), blocked(9, CWD)];
    expect(repeatedBlocks(laneIn(CWD), both, NOW)).toMatchObject({ rule: "blocked", count: 5 });
    expect(repeatedBlocks(laneIn(other), both, NOW)).toBeUndefined();
  });

  test("a missing log reads as no lines, and a log with broken lines still counts the good ones", () => {
    const dir = mkdtempSync(join(tmpdir(), "dori-log-"));
    expect(readBlockedLog(join(dir, "repeat-guard.log"))).toEqual([]);
    expect(readBlockedLog(join(dir, "no-such-dir", "repeat-guard.log"))).toEqual([]);
    const file = join(dir, "repeat-guard.log");
    const lines = ["{broken", blocked(1, CWD), "", blocked(2, CWD), blocked(3, CWD), blocked(4, CWD), blocked(5, CWD)];
    writeFileSync(file, `${lines.join("\n")}\n`);
    expect(repeatedBlocks(laneIn(CWD), readBlockedLog(file), NOW)).toMatchObject({ rule: "blocked", count: 5 });
  });
});
