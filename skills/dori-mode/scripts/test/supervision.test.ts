import { describe, expect, test } from "bun:test";
import { existsSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Checkpoints } from "../src/checkpoints.ts";
import type { Lane } from "../src/registry.ts";
import { Reports } from "../src/reports.ts";
import type { Runner } from "../src/run.ts";
import { Supervision } from "../src/supervision.ts";
import type { SupervisionOptions } from "../src/supervision-observe.ts";
import { fakeClock, withState } from "./fakes.ts";

const start = Date.parse("2026-10-29T00:00:00Z");

const lane: Lane = {
  key: "demo-lane",
  title: "Demo",
  thread: "",
  brief: "",
  done: "",
  openedAt: new Date(start).toISOString(),
  reportProtocol: "jsonl-v1",
};

const fixture = (options: SupervisionOptions = {}) => {
  const state = withState();
  const clock = fakeClock(start);
  const calls: string[][] = [];
  const alerts: string[] = [];
  let usage = '{"tokens":null,"costUsd":null}';
  let dirty = "";
  const run: Runner = async (argv) => {
    calls.push([...argv]);
    return { code: 0, out: argv[0] === "usage" ? usage : argv[0] === "git" ? dirty : "", err: "" };
  };
  const deps = {
    stateDir: state.dir,
    clock,
    run,
    alert: (_lane: Lane, message: string) => {
      alerts.push(message);
    },
  };
  return {
    ...state,
    clock,
    calls,
    alerts,
    deps,
    supervisor: new Supervision(deps, options),
    setUsage: (value: string) => {
      usage = value;
    },
    setDirty: (value: string) => {
      dirty = value;
    },
  };
};

describe("supervision", () => {
  test("legacy lanes perform no commands or state writes", async () => {
    const f = fixture({ usageArgv: ["usage"] });
    try {
      expect((await f.supervisor.sweep({ ...lane, reportProtocol: undefined }, "Working 40m")).enabled).toBe(false);
      expect(await f.supervisor.close({ ...lane, reportProtocol: undefined })).toBeNull();
      expect(f.calls).toEqual([]);
      expect(existsSync(join(f.dir, "lanes"))).toBe(false);
    } finally {
      f.done();
    }
  });

  test("growing same timer requires persisted observations and fresh-activity grace", async () => {
    const f = fixture();
    try {
      expect((await f.supervisor.sweep(lane, "Working (21m 0s)")).alerts).toEqual([]);
      f.clock.at += 20 * 60_000;
      const restarted = new Supervision(f.deps);
      expect((await restarted.sweep(lane, "Working (41m 0s)")).state).toBe("stalled");
      expect(f.alerts).toHaveLength(1);
      f.clock.at += 60_000;
      expect((await restarted.sweep(lane, "Working (42m 0s)")).alerts).toEqual([]);
      expect(new Reports(f.dir).read(lane.key)?.state).toBe("stalled");
      expect(f.calls.some((args) => /kill|send-text/.test(args.join(" ")))).toBe(false);
    } finally {
      f.done();
    }
  });

  test("timer reset, frozen timer, and changed timer origin do not mark hung", async () => {
    const f = fixture({ staleAfterMinutes: 0 });
    try {
      await f.supervisor.sweep(lane, "Working 25m");
      f.clock.at += 60_000;
      expect((await f.supervisor.sweep(lane, "Working 25m")).alerts).toEqual([]);
      f.clock.at += 60_000;
      expect((await f.supervisor.sweep(lane, "Working 1m")).alerts).toEqual([]);
      f.clock.at += 60_000;
      expect((await f.supervisor.sweep(lane, "Working 30m")).alerts).toEqual([]);
      f.clock.at += 60_000;
      expect((await f.supervisor.sweep(lane, "Running 31m")).alerts).toEqual([]);
    } finally {
      f.done();
    }
  });

  test("a minute-rounded timer is hung even when sweeps do not line up with its minute boundary", async () => {
    const f = fixture({ staleAfterMinutes: 0 });
    try {
      await f.supervisor.sweep(lane, "Working 25m");
      f.clock.at += 90_000; // the real timer went 25m10s -> 26m40s and shows 26m
      expect((await f.supervisor.sweep(lane, "Working 26m")).state).toBe("stalled");
    } finally {
      f.done();
    }
  });

  test("report and checkpoint progress suppress hung detection until stale", async () => {
    const f = fixture();
    try {
      const reports = new Reports(f.dir);
      reports.report(lane.key, "milestone", "starting", f.clock.now());
      await f.supervisor.sweep({ ...lane, reportProtocol: undefined }, "Working 21m");
      f.clock.at += 20 * 60_000;
      reports.report(lane.key, "milestone", "progress", f.clock.now());
      expect((await f.supervisor.sweep(lane, "Working 41m")).state).toBe("running");
      f.clock.at += 20 * 60_000;
      new Checkpoints(f.dir).write(
        lane.key,
        { step: "build", result: "ok", evidence: [], remoteEffects: [] },
        f.clock.now(),
      );
      expect((await f.supervisor.sweep(lane, "Working 61m")).state).toBe("running");
      f.clock.at += 20 * 60_000;
      expect((await f.supervisor.sweep(lane, "Working 81m")).state).toBe("stalled");
    } finally {
      f.done();
    }
  });

  test("explicit file and git changed-file activity suppress stalls without scanning", async () => {
    const f = fixture();
    try {
      const path = join(f.dir, "source.ts");
      writeFileSync(path, "first");
      const activeLane = { ...lane, cwd: f.dir, activityPaths: [path] };
      await f.supervisor.sweep(activeLane, "Running 21m");
      f.clock.at += 20 * 60_000;
      utimesSync(path, new Date(f.clock.at), new Date(f.clock.at));
      expect((await f.supervisor.sweep(activeLane, "Running 41m")).state).toBe("running");
      f.clock.at += 20 * 60_000;
      f.setDirty(" M source.ts\0?? node_modules/\0");
      expect((await f.supervisor.sweep(activeLane, "Running 61m")).state).toBe("running");
      f.clock.at += 20 * 60_000;
      expect((await f.supervisor.sweep(activeLane, "Running 81m")).state).toBe("stalled");
      f.clock.at += 60_000;
      utimesSync(path, new Date(f.clock.at), new Date(f.clock.at));
      expect((await f.supervisor.sweep(activeLane, "Running 82m")).state).toBe("running");
      expect(f.calls.every((args) => args[0] === "git")).toBe(true);
    } finally {
      f.done();
    }
  });

  test("changes under node_modules or outside the lane's cwd are not activity", async () => {
    const f = fixture();
    try {
      const activeLane = { ...lane, cwd: f.dir };
      f.setDirty(" M node_modules/a/index.js\0");
      await f.supervisor.sweep(activeLane, "Running 21m");
      f.clock.at += 20 * 60_000;
      f.setDirty(" M node_modules/b/index.js\0 M ../elsewhere.ts\0");
      expect((await f.supervisor.sweep(activeLane, "Running 41m")).state).toBe("stalled");
    } finally {
      f.done();
    }
  });
});
