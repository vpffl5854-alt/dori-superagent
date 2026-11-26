import { afterEach, beforeEach, expect, test } from "bun:test";

import { closeLane, type FlowDeps } from "../src/done-flow.ts";
import type { Lane } from "../src/registry.ts";
import type { Runner } from "../src/run.ts";
import { depsFor, fakeClock, fakeRunner, newWorld, withState, type World } from "./fakes.ts";
import { hcTerm } from "./hc-runner.ts";

// The fake herdr reports shell_pid 100 for every pane (fakes.ts), so 100 is the lane pane's root process.
const lane: Lane = {
  key: "demo-lane",
  title: "demo",
  thread: "none",
  pane: "w:p1",
  brief: "/briefs/demo.md",
  done: "merged acme/app#1",
  cwd: "/repo",
  openedAt: "2026-01-01T11:00:00.000Z",
};

// Before the close: the pane's shell, its agent, one watch pipeline the agent started, and processes of other owners.
const BEFORE = [
  "  1     0 /sbin/init",
  "100     1 -bash",
  "101   100 agent --session demo",
  "200   101 /bin/sh -c tail -n 0 -F /tmp/build.log | grep --line-buffered FAIL",
  "201   200 tail -n 0 -F /tmp/build.log",
  "202   200 grep --line-buffered FAIL",
  "300     1 tail -n 0 -F /tmp/build.log",
  "400     1 agent --session other",
].join("\n");

let state: ReturnType<typeof withState>;
let world: World;
let tables: string[];
let rootEnv: string | undefined;

const kills = () => world.calls.filter((c) => c[0] === "kill");
const receipt = (lines: readonly string[]) =>
  JSON.parse(lines.at(-1)?.replace(/^CLOSED \S+ /, "") ?? "{}") as { cleanup: string[] };

const deps = (): FlowDeps => {
  const base = depsFor(world, fakeClock(Date.parse("2026-01-01T12:00:00.000Z")), state.dir);
  const inner = fakeRunner(world);
  const run: Runner = async (argv, opts) => {
    if (argv[0] === "ps" && argv[1] === "eww") {
      world.calls.push([...argv]);
      return rootEnv === undefined ? { code: 1, out: "", err: "" } : { code: 0, out: rootEnv, err: "" };
    }
    if (argv[0] === "ps") {
      world.calls.push([...argv]);
      const out = tables.shift();
      return out === undefined ? { code: 1, out: "", err: "ps: unavailable" } : { code: 0, out, err: "" };
    }
    if (argv[0] === "kill") {
      world.calls.push([...argv]);
      return { code: 0, out: "", err: "" };
    }
    return inner(argv, opts);
  };
  return { ...base, run };
};

beforeEach(() => {
  state = withState();
  world = newWorld();
  world.panes = [{ pane_id: "w:p1", workspace_id: "w", agent: "pi", agent_status: "idle" }];
  rootEnv = "-bash HOME=/home/test HERDR_PANE_ID=w:p1 TERM=xterm";
});
afterEach(() => state.done());

test("watchers the lane started that outlive its pane are stopped by exact pid, and nothing else is", async () => {
  // After the pane closed, the watch pipeline was re-parented to init and kept running.
  tables = [
    BEFORE,
    [
      "  1     0 /sbin/init",
      "200     1 /bin/sh -c tail -n 0 -F /tmp/build.log | grep --line-buffered FAIL",
      "201   200 tail -n 0 -F /tmp/build.log",
      "202   200 grep --line-buffered FAIL",
      "300     1 tail -n 0 -F /tmp/build.log",
      "400     1 agent --session other",
    ].join("\n"),
  ];
  const r = await closeLane(deps(), lane, "Done");
  expect(r.closed).toBe(true);
  expect(kills()).toEqual([["kill", "-TERM", "200", "201", "202"]]);
  expect(receipt(r.lines).cleanup).toContain("3 lane processes outlived the pane, stopped: 200 201 202");
});

test("a pid reused by another program after the close is left alone", async () => {
  tables = [BEFORE, ["  1     0 /sbin/init", "201     1 /usr/bin/editor notes.md"].join("\n")];
  const r = await closeLane(deps(), lane, "Done");
  expect(kills()).toEqual([]);
  expect(receipt(r.lines).cleanup).toContain("no lane process outlived the pane");
});

test("an unreadable process table stops nothing, says so, and does not hold the close", async () => {
  tables = [];
  const r = await closeLane(deps(), lane, "Done");
  expect(r.closed).toBe(true);
  expect(kills()).toEqual([]);
  expect(receipt(r.lines).cleanup).toContain("lane processes not checked: ps: unavailable");
});

const AFTER = [
  "  1     0 /sbin/init",
  "200     1 /bin/sh -c tail -n 0 -F /tmp/build.log | grep --line-buffered FAIL",
  "201   200 tail -n 0 -F /tmp/build.log",
  "202   200 grep --line-buffered FAIL",
].join("\n");
const tableReads = () => world.calls.filter((c) => c[0] === "ps" && c[1] === "-A");

test("a root pid that is not this session's process on this host signals nothing and says so", async () => {
  // The runtime's pid names a process on another host; here the same pid is some unrelated program.
  rootEnv = "/usr/sbin/daemon HOME=/";
  tables = [BEFORE, AFTER];
  const r = await closeLane(deps(), lane, "Done");
  expect(r.closed).toBe(true);
  expect(kills()).toEqual([]);
  expect(tableReads()).toEqual([]);
  expect(receipt(r.lines).cleanup).toContain(
    "lane processes not checked: session root 100 on this host does not carry HERDR_PANE_ID=w:p1 (the session may run on another host)",
  );
});

test("a root whose environment cannot be read here signals nothing", async () => {
  rootEnv = undefined;
  tables = [BEFORE, AFTER];
  const r = await closeLane(deps(), lane, "Done");
  expect(kills()).toEqual([]);
  expect(receipt(r.lines).cleanup).toContain(
    "lane processes not checked: session root 100 could not be read on this host",
  );
});

test("an hc lane needs its own terminal id on the root; another runtime's inherited id does not count", async () => {
  world.terminals = { t7: hcTerm({ pid: 100 }) };
  const hcLane: Lane = { ...lane, pane: "t7", sessionRef: { runtime: "hc", id: "t7" } };
  rootEnv = "-bash HERDR_PANE_ID=w:p1";
  tables = [BEFORE, AFTER];
  const r = await closeLane(deps(), hcLane, "Done");
  expect(kills()).toEqual([]);
  expect(receipt(r.lines).cleanup).toContain(
    "lane processes not checked: session root 100 on this host does not carry HC_TERMINAL_ID=t7 (the session may run on another host)",
  );
  rootEnv = "-bash HERDR_PANE_ID=w:p1 HC_TERMINAL_ID=t7";
  tables = [BEFORE, AFTER];
  world.calls = [];
  world.terminals = { t7: hcTerm({ pid: 100 }) };
  await closeLane(deps(), hcLane, "Done");
  expect(kills()).toEqual([["kill", "-TERM", "200", "201", "202"]]);
});
