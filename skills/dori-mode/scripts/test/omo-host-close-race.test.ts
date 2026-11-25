import { afterEach, beforeEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { FakeOmoHost } from "../../../../test/fake-omo-host.ts";
import { closeLane } from "../src/done-flow.ts";
import { freshnessTick } from "../src/freshness.ts";
import { launchLane } from "../src/launch.ts";
import { type Lane, withStatus } from "../src/registry.ts";
import type { Runner } from "../src/run.ts";
import { depsFor, fakeClock, fakeRunner, newWorld, withState, type World } from "./fakes.ts";

// The omo host resumes a closed session whenever a verb names it, so every reader that can race a close (a launch's
// startup check, a freshness sweep, closeLane itself) must leave the session closed.
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

test("a lane the lead closes while its launch still checks it is closed again, not resumed by the check", async () => {
  const brief = join(state.dir, "brief.md");
  writeFileSync(brief, "# brief\n");
  const d = deps();
  const launched = runner();
  let raced = false;
  const run: Runner = async (argv, opts) => {
    // The close lands between the check's list and its state call, and the host resumes the session on that state call.
    if (argv[0] === "omo" && argv[3] === "state" && !raced) {
      raced = true;
      const at = new Date(T0).toISOString();
      await launched(["omo", "host", "session", "close", argv[4] ?? "", "--json"]);
      const lane = await d.registry.read("fix-x");
      if (lane) await d.registry.write(withStatus(lane, "closed", "closed by the lead", at, { closedAt: at }));
    }
    return launched(argv, opts);
  };
  const r = await launchLane({ ...d, run }, { key: "fix-x", title: "t", brief, done: "closed acme/app#3" });
  expect(raced).toBe(true);
  expect(r.startup).toBe("STARTUP_DONE fix-x");
  expect(host.sessions.get(r.lane.pane ?? "")?.parked).toBe(true);
});

test("closing a lane closes its host session once more after the registry write, for a read that resumed it", async () => {
  const s = host.add({ id: "00000000-0000-4000-8000-000000000008", name: "dori/g1/fix-x" });
  const proof = join(state.dir, "proof.txt");
  writeFileSync(proof, "ok\n");
  const base = runner();
  const run: Runner = async (argv, opts) => {
    const r = await base(argv, opts);
    // A launch's startup check names the session right after the first close: the host resumes it.
    if (argv[0] === "omo" && argv[3] === "close" && host.calls.filter((c) => c[0] === "close").length === 1)
      s.parked = false;
    return r;
  };
  const lane: Lane = {
    key: "fix-x",
    title: "t",
    thread: "none",
    brief: "/b.md",
    done: `file ${proof}`,
    openedAt: new Date(T0).toISOString(),
    sessionRef: { runtime: "omo-host", id: s.id, group: "g1" },
    pane: s.id,
  };
  const closed = await closeLane({ ...deps(), run }, lane, "closed by the lead");
  expect(closed.closed).toBe(true);
  expect(s.parked).toBe(true);
});

test("a freshness sweep that reads a lane while the lead closes it closes the host session again", async () => {
  const s = host.add({ id: "00000000-0000-4000-8000-000000000010", name: "dori/g1/fix-x" });
  const d = deps();
  const at = new Date(T0).toISOString();
  const lane: Lane = {
    key: "fix-x",
    title: "t",
    thread: "none",
    brief: "/b.md",
    done: "closed acme/app#3",
    openedAt: at,
    reportProtocol: "jsonl-v1",
    sessionRef: { runtime: "omo-host", id: s.id, group: "g1" },
    pane: s.id,
  };
  await d.registry.write(lane);
  const base = runner();
  let raced = false;
  const run: Runner = async (argv, opts) => {
    // The close lands between the sweep's list and its state call, and the host resumes the session on that state call.
    if (argv[0] === "omo" && argv[3] === "state" && !raced) {
      raced = true;
      await base(["omo", "host", "session", "close", s.id, "--json"]);
      await d.registry.write(withStatus(lane, "closed", "closed by the lead", at, { closedAt: at }));
    }
    return base(argv, opts);
  };
  await freshnessTick({ ...d, run }, "/home/test");
  expect(raced).toBe(true);
  expect(s.parked).toBe(true);
});
