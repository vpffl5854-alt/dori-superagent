import { describe, expect, test } from "bun:test";
import type { Lane } from "../src/store-types.ts";
import {
  budgetOverrun,
  DEFAULT_BUDGET_MIN,
  pathFamily,
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
