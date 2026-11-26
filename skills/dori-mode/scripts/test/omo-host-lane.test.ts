import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { OmoHostRuntime } from "../../../../src/runtime/omo-host/index.ts";
import { FakeOmoHost, SOCKET, writeGoal } from "../../../../test/fake-omo-host.ts";
import { ConfigError, loadConfig } from "../src/config.ts";
import { anchoredReportLine } from "../src/freshness.ts";
import { launchLane } from "../src/launch.ts";
import { pauseLane, resumeLane } from "../src/pause.ts";
import type { Lane } from "../src/registry.ts";
import { Reports } from "../src/reports.ts";
import type { Runner } from "../src/run.ts";
import { runtimesOf } from "../src/run.ts";
import { resolveSession } from "../src/session-id.ts";
import { agentStatus } from "../src/sessions.ts";
import { startupFailure } from "../src/startup-screen.ts";
import { workingTimer } from "../src/supervision-observe.ts";
import { depsFor, fakeClock, fakeRunner, newWorld, withState, type World } from "./fakes.ts";

const T0 = Date.parse("2026-11-20T02:00:00.000Z");
let state: ReturnType<typeof withState>;
let world: World;
let host: FakeOmoHost;
beforeEach(() => {
  state = withState();
  world = newWorld();
  host = new FakeOmoHost(join(state.dir, "sessions"));
});
afterEach(() => state.done());

const runner = (): Runner => {
  const rest = fakeRunner(world);
  return async (argv) => {
    if (argv[0] !== "omo") return rest(argv);
    const r = await host.exec("omo", argv.slice(1));
    return { code: r.code, out: r.stdout.trim(), err: r.stderr };
  };
};
const deps = (at = T0) => ({
  ...depsFor(world, fakeClock(at), state.dir, { runtime: "hc", laneRuntime: "omo-host", laneWorkspace: "g1" }),
  run: runner(),
});

test("laneRuntime takes omo-host; runtime never does, so the lead stays on a terminal runtime", async () => {
  const path = join(state.dir, "config.json");
  writeFileSync(path, JSON.stringify({ runtime: "hc", laneRuntime: "omo-host" }));
  expect(await loadConfig(path, "/home/ana")).toMatchObject({ runtime: "hc", laneRuntime: "omo-host" });
  writeFileSync(path, JSON.stringify({ runtime: "omo-host" }));
  await expect(loadConfig(path, "/home/ana")).rejects.toThrow(ConfigError);
  writeFileSync(path, JSON.stringify({ laneRuntime: "tmux" }));
  await expect(loadConfig(path, "/home/ana")).rejects.toThrow(/invalid laneRuntime/);
});

test("launch opens the lane in the host with its model, sends the launch prompt, and its footer carries the env", async () => {
  const brief = join(state.dir, "brief.md");
  writeFileSync(brief, "# brief\nDo the thing.\n");
  const d = deps();
  const launched = runner();
  const run: Runner = async (argv, opts) => {
    const r = await launched(argv, opts);
    // The agent sets its goal as its first turn starts, as `ulw set goal and work` makes it do.
    if (argv[0] === "omo" && argv[3] === "prompt") writeGoal(host.sessions.get(argv[4] ?? "")!, "active");
    return r;
  };
  const r = await launchLane({ ...d, run }, { key: "fix-x", title: "t", brief, done: "closed acme/app#3" });
  const [open, prompt] = host.calls.filter((c) => c[0] === "open" || c[0] === "prompt");
  expect(open).toEqual(["open", "--cwd", "/repo", "--model", d.config.defaultModel, "--name", "dori/g1/fix-x"]);
  expect(prompt?.[2]).toContain("You are the fix-x lane");
  expect(r.startup).toBe("STARTUP_OK fix-x 00000000-0000-4000-8000-000000000001");
  expect(r.lane.sessionRef).toEqual({ runtime: "omo-host", id: "00000000-0000-4000-8000-000000000001", group: "g1" });
  expect(world.calls.filter((c) => c[0] === "hc" || c[0] === "herdr")).toEqual([]);
  expect(readFileSync(brief, "utf8")).toMatch(/claim-done fix-x/);
  expect(readFileSync(brief, "utf8")).toMatch(/env DORI_CONFIG=\S+ DORI_STATE_DIR=\S+ bun \S+cli\.ts report fix-x/);
  // The lane has no terminal id to infer the lead's runtime from, so the footer names the exact argv.
  expect(readFileSync(brief, "utf8")).toContain('["hc","send","lead:p1","--","[REPORT] ..."]');
});

test("the rendered transcript is a screen the lane parsers read: report, working timer, provider error, idle stall", async () => {
  const s = host.add({
    id: "00000000-0000-4000-8000-000000000009",
    state: { isStreaming: true, lifecycle: { state: "running", since: new Date(T0 - 65_000).toISOString() } },
    entries: [
      { type: "message", message: { role: "user", content: "ulw set goal and work" } },
      { type: "custom", customType: "work-custody" },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", name: "bash", arguments: { command: "bun cli.ts report kk" } }],
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolName: "bash",
          content: [{ type: "text", text: "[REPORT] kk | milestone | built x" }],
        },
      },
      {
        type: "message",
        message: { role: "assistant", content: [], stopReason: "error", errorMessage: "429 Too Many Requests" },
      },
    ],
  });
  const rt = new OmoHostRuntime(host.exec, { now: () => T0 });
  const ref = { runtime: "omo-host" as const, id: s.id };
  const working = await rt.read(ref, 60);
  expect(working.split("\n")).toEqual([
    "> ulw set goal and work",
    "• bash bun cli.ts report kk",
    "  [REPORT] kk | milestone | built x",
    "Error: 429 Too Many Requests",
    "Working (1m 5s)",
  ]);
  expect(workingTimer(working)).toEqual({ kind: "working", seconds: 65, step: 1 });
  expect(anchoredReportLine(working, "kk")).toBe("[REPORT] kk | milestone | built x");
  expect(startupFailure(working)).toBe("429 Too Many Requests");

  s.state = { ...s.state, isStreaming: false };
  const reports = new Reports(state.dir);
  reports.report("kk", "milestone", "built x", T0 - 30 * 60_000);
  expect(reports.observe("kk", await rt.read(ref, 60), T0, 15 * 60_000)?.state).toBe("stalled");
});

test("a lane waiting on its own background command reads as running, never as an idle stall", async () => {
  const waitingOn = (background: unknown[]) => ({
    state: "waiting_background",
    since: new Date(T0 - 90_000).toISOString(),
    waitingOn: { children: 0, background, human: [] },
  });
  const shell = {
    source: "terminal-background-sessions",
    activeCount: 1,
    items: [{ id: "bash_1", label: "sleep 200" }],
  };
  const s = host.add({ id: "00000000-0000-4000-8000-000000000011", state: { lifecycle: waitingOn([shell]) } });
  const rt = new OmoHostRuntime(host.exec, { now: () => T0 });
  const ref = { runtime: "omo-host" as const, id: s.id };
  const reports = new Reports(state.dir);
  reports.report("kk", "milestone", "started", T0 - 30 * 60_000);
  const screen = await rt.read(ref, 60);
  expect(screen.split("\n").at(-1)).toBe("Running (1m 30s) · waiting on 1 background task");
  expect(reports.observe("kk", screen, T0, 15 * 60_000)?.state).toBe("running");
  // The goal monitor alone is no work: an idle lane with a goal still reads as the idle prompt.
  s.state = { ...s.state, lifecycle: waitingOn([{ source: "goal-monitor", activeCount: 1 }]) };
  expect((await rt.read(ref, 60)).split("\n").at(-1)).toBe("❯");
});

test("pause and resume are confirmed from the goal record, since a host session prints the goal command nowhere", async () => {
  const s = host.add({ id: "00000000-0000-4000-8000-000000000005" });
  writeGoal(s, "active");
  const lane: Lane = {
    key: "fix-x",
    title: "t",
    thread: "none",
    brief: "/b.md",
    done: "closed acme/app#3",
    openedAt: new Date(T0).toISOString(),
    sessionRef: { runtime: "omo-host", id: s.id },
    pane: s.id,
  };
  const paused = await pauseLane(deps(), lane, "owner said wait");
  expect(paused.lines).toEqual(["PAUSED fix-x goal paused"]);
  expect((await resumeLane(deps(), paused.lane, "go on")).lines).toEqual(["RESUMED fix-x as working, goal resumed"]);
  expect(host.calls.filter((c) => c[0] === "prompt").map((c) => c[2])).toEqual(["/goal pause", "/goal resume"]);
});

test("a parked lane (idle past the host's eviction window) is resumed by the status lookup a delivery starts with", async () => {
  const s = host.add({ id: "00000000-0000-4000-8000-000000000006", parked: true });
  const ref = { runtime: "omo-host" as const, id: s.id };
  expect(await agentStatus(runtimesOf(deps()), ref)).toBe("idle");
  expect(s.parked).toBe(false);
  host.sessions.clear();
  expect(await agentStatus(runtimesOf(deps()), ref)).toBeUndefined();
});

test("a lane's own dori call finds its lane by PI_SESSION_ID, and its session id is the ref itself", async () => {
  const d = deps();
  const id = "00000000-0000-4000-8000-000000000007";
  await d.registry.write({
    key: "fix-x",
    title: "t",
    thread: "none",
    brief: "/b.md",
    done: "closed acme/app#3",
    openedAt: new Date(T0).toISOString(),
    sessionRef: { runtime: "omo-host", id },
    pane: id,
  });
  const self = runtimesOf(d).selfAny({ SENPI_RPC_HOST_PUBLIC_SOCKET: SOCKET, PI_SESSION_ID: id, HC_TERMINAL_ID: "t3" });
  expect((await d.registry.bySession(self))?.key).toBe("fix-x");
  expect(await resolveSession({ runtime: "omo-host", id }, "/repo", [], { run: d.run, sessionsDir: "/s" })).toEqual({
    id,
    via: "runtime",
  });
});
