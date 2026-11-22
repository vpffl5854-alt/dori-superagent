import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Deps } from "../src/harness.ts";
import type { Exec } from "../src/runtime/exec.ts";
import { type HardLimitOptions, hardLimitPass, keepNames, runHardLimit } from "../src/hard-timeout.ts";
import { startLane } from "../src/lanes.ts";
import { setup } from "./harness-setup.ts";

const MIN = 60_000;
const T0 = 1_000_000;
const KEEP = ["lead", "duty", "duty-loop", "hourly-loop"];

const opts = (log: string[] = []): HardLimitOptions => ({
  limitMin: 60,
  keep: KEEP,
  log: (line) => log.push(line),
});

const row = (address: string, name: string | undefined, createdMs: number | undefined) => ({
  address,
  ...(name === undefined ? {} : { name }),
  ...(createdMs === undefined ? {} : { created_ms: createdMs }),
});

const ls = (rows: unknown[]) => ({
  code: 0,
  stdout: JSON.stringify({ hidden_finished: 0, terminals: rows }),
  stderr: "",
});

type Answer = { readonly code: number; readonly stdout: string; readonly stderr: string };

// The pass reads `d.now()`, which is bound when the deps are built, so the test moves that clock rather than `w.clock`.
const setNow = (d: Deps, at: number): void => {
  (d as { now: () => number }).now = () => at;
};

// The watcher's hc calls: `ls` and each pane's `read` answer from the test, every kill/rm is recorded.
const withHc = (d: Deps, answers: { ls: () => Answer; screens?: Record<string, string> }) => {
  const base = d.exec;
  const closed: string[] = [];
  (d as { exec: Exec }).exec = async (cmd, argv, options) => {
    // The watcher asks for JSON (`hc --json ls`), so the subcommand is the first word that is not a flag.
    const subAt = argv.findIndex((a, i) => i > 0 && !a.startsWith("-"));
    const sub = subAt < 0 ? undefined : argv[subAt];
    const rest = subAt < 0 ? [] : argv.slice(subAt + 1);
    if (cmd === "hc" && sub === "ls") return answers.ls();
    if (cmd === "hc" && sub === "read") {
      const text = answers.screens?.[rest[0] ?? ""];
      return text === undefined
        ? { code: 3, stdout: "", stderr: "not_found" }
        : { code: 0, stdout: JSON.stringify({ text }), stderr: "" };
    }
    if (cmd === "hc" && (sub === "kill" || sub === "rm")) {
      closed.push(`${sub} ${rest[0]}`);
      return { code: 0, stdout: "{}", stderr: "" };
    }
    if (cmd === "hc" && sub === "run") return base(cmd, argv, options);
    if (cmd === "git") return { code: 0, stdout: "", stderr: "" };
    return base(cmd, argv, options);
  };
  return closed;
};

const hcLane = async (d: ReturnType<typeof setup>["d"], brief: string) =>
  startLane(d, "old-lane", brief, { group: "w1" });

describe("hard limit pass", () => {
  test("rule 1: closes a lane pane past 60 minutes, backs it up and tells the lead", async () => {
    const { d, lead, brief } = setup({ runtime: "hc" });
    const lane = await hcLane(d, brief);
    expect(lane.sessionRef.id).toBe("t1");
    setNow(d, T0 + 61 * MIN);
    const closed = withHc(d, { ls: () => ls([row("t1", "old-lane", T0)]) });
    const events = await hardLimitPass(d, opts());
    expect(events).toContainEqual({
      pane: "t1",
      action: "budget",
      detail: expect.stringContaining("[WATCHDOG] old-lane 시간 초과로 자동 종료(예산 60분 x1.5, 경과 61분)"),
    });
    expect(closed).toEqual(["kill t1", "rm t1"]);
    expect(lead.received.at(-1)).toContain(
      "[WATCHDOG] old-lane 시간 초과로 자동 종료(예산 60분 x1.5, 경과 61분); 백업 ",
    );
    const backup = lead.received.at(-1)?.match(/백업 (\S+)/)?.[1] ?? "";
    expect(backup).toContain(join(d.store.root, "backups", "watchdog-old-lane-"));
    expect(await Bun.file(join(backup, "old-lane.md")).exists()).toBe(true);
  });

  test("rule 2: closes a lane looping on one scratch path, whatever its age", async () => {
    const { d, lead, brief } = setup({ runtime: "hc" });
    await hcLane(d, brief);
    setNow(d, T0 + 5 * MIN);
    const screen = [
      "$ cat > /tmp/proxy-dbg.mjs <<'EOF'",
      "$ rm /tmp/proxy-dbg.mjs",
      "$ cat > /tmp/proxy-dbg.mjs <<'EOF'",
      "$ rm /tmp/proxy-dbg.mjs",
      "$ cat > /tmp/proxy-dbg.mjs <<'EOF'",
    ].join("\n");
    const closed = withHc(d, { ls: () => ls([row("t1", "old-lane", T0)]), screens: { t1: screen } });
    const events = await hardLimitPass(d, opts());
    expect(events).toContainEqual({
      pane: "t1",
      action: "repeat",
      detail: expect.stringContaining(
        "[WATCHDOG] old-lane 반복 작업 감지로 자동 종료(같은 경로 5회: /tmp/proxy-dbg.mjs)",
      ),
    });
    expect(closed).toEqual(["kill t1", "rm t1"]);
    expect(lead.received.at(-1)).toContain("반복 작업 감지로 자동 종료");
  });

  test("rule 3: closes a lane the repeat-guard blocked 5 times in 15 minutes", async () => {
    const { d, lead, brief } = setup({ runtime: "hc" });
    const lane = await hcLane(d, brief);
    setNow(d, T0 + 5 * MIN);
    mkdirSync(join(d.store.root, "logs"), { recursive: true });
    const at = (ms: number) =>
      JSON.stringify({ ts: new Date(ms).toISOString(), verdict: "blocked", target: `${lane.cwd}/x.ts` });
    writeFileSync(
      join(d.store.root, "logs", "repeat-guard.log"),
      [1, 2, 3, 4, 5].map((i) => at(T0 + 5 * MIN - i * MIN)).join("\n"),
    );
    const closed = withHc(d, { ls: () => ls([row("t1", "old-lane", T0)]) });
    const events = await hardLimitPass(d, opts());
    expect(events).toContainEqual({
      pane: "t1",
      action: "blocked",
      detail: expect.stringContaining("[WATCHDOG] old-lane repeat-guard 차단 반복으로 자동 종료(15분 안에 5건)"),
    });
    expect(closed).toEqual(["kill t1", "rm t1"]);
    expect(lead.received.at(-1)).toContain("repeat-guard 차단 반복");
  });

  test("a calm lane inside the limit is left open", async () => {
    const { d, brief } = setup({ runtime: "hc" });
    await hcLane(d, brief);
    setNow(d, T0 + 60 * MIN);
    const closed = withHc(d, { ls: () => ls([row("t1", "old-lane", T0)]), screens: { t1: "$ ls\n$ cat README.md" } });
    expect(await hardLimitPass(d, opts())).toEqual([]);
    expect(closed).toEqual([]);
  });

  test("lead, duty and loop panes are never closed, by name or by registered ref", async () => {
    const { d } = setup({ runtime: "hc" });
    d.store.setRole("duty", { runtime: "hc", id: "t9" });
    setNow(d, T0 + 600 * MIN);
    const closed = withHc(d, {
      ls: () =>
        ls([
          row("t1", "lead", T0),
          row("t2", "duty", T0),
          row("t3", "duty-loop", T0),
          row("t4", "hourly-loop", T0),
          row("t9", "duty-renamed", T0),
          row("t5", undefined, T0),
        ]),
    });
    expect(await hardLimitPass(d, { ...opts(), keep: [...KEEP, "t9"] })).toEqual([]);
    expect(closed).toEqual([]);
  });

  test("a chat lane name is kept, so the hard limit never closes it", async () => {
    const { d } = setup({ runtime: "hc" });
    writeFileSync(join(d.store.root, "config.json"), JSON.stringify({ chatLanes: ["discord-chat"] }));
    const names = keepNames(d);
    expect(names).toContain("discord-chat");
    expect(names).toContain("lead");
  });

  test("a failed hc ls is logged and the next pass still closes", async () => {
    const { d } = setup({ runtime: "hc" });
    setNow(d, T0 + 61 * MIN);
    const log: string[] = [];
    let answer: Answer = { code: 5, stdout: "", stderr: "unavailable" };
    const closed = withHc(d, { ls: () => answer });
    expect(await hardLimitPass(d, opts(log))).toContainEqual({
      action: "ls-failed",
      detail: expect.stringContaining("hc ls exited 5"),
    });
    expect(log[0]).toContain("next pass continues");
    expect(closed).toEqual([]);
    answer = { code: 0, stdout: "{broken", stderr: "" };
    expect((await hardLimitPass(d, opts(log)))[0]?.action).toBe("ls-failed");
    answer = ls([row("t1", "old-lane", T0)]);
    expect((await hardLimitPass(d, opts(log)))[0]?.action).toBe("budget");
    expect(closed).toEqual(["kill t1", "rm t1"]);
  });

  test("the loop keeps running after a failed pass", async () => {
    const { d } = setup({ runtime: "hc" });
    const log: string[] = [];
    let passes = 0;
    let stop: () => void = () => {};
    const done = new Promise<void>((resolve) => {
      stop = resolve;
    });
    (d as { exec: Exec }).exec = async (cmd) => {
      if (cmd !== "hc") return { code: 0, stdout: "", stderr: "" };
      passes++;
      if (passes === 1) throw new Error("hc missing");
      if (passes === 2) return { code: 1, stdout: "", stderr: "boom" };
      stop();
      return ls([]);
    };
    const running = runHardLimit(d, { ...opts(), intervalMs: 1 }, (line) => log.push(line));
    await done;
    void running.catch(() => undefined);
    expect(passes).toBe(3);
    expect(log[0]).toContain("hc ls failed, next pass continues: hc missing");
    expect(log[1]).toContain("HARD_TIMEOUT ls-failed");
  });
});
