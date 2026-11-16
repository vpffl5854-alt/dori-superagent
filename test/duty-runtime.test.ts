import { describe, expect, test } from "bun:test";
import { dutyTick } from "../src/duty.ts";
import type { SessionRef } from "../src/runtime/types.ts";
import type { Lane } from "../src/store-types.ts";
import { terminal } from "./fake-hc.ts";
import { World } from "./fake.ts";

const REF: SessionRef = { runtime: "hc", id: "t1", group: "g" };
const lane = (over: Partial<Lane> = {}): Lane => ({
  key: "hc-lane",
  sessionRef: REF,
  paneId: "t1",
  tabId: "",
  brief: "/b.md",
  cwd: "/w",
  status: "working",
  createdAt: 0,
  lastActivityAt: 0,
  nudges: 0,
  log: [],
  ...over,
});

describe("the duty pass on hc lanes", () => {
  test("an agent in error waits like a blocked one: no nudge however long it is idle", async () => {
    const w = new World();
    const d = w.deps({ runtime: "hc" });
    w.hc.terminals.set("t1", terminal({ status: { state: "error", app: "omo" } }));
    d.store.saveLane(lane());
    w.clock = 60 * 60_000;
    expect(await dutyTick(d)).toEqual([]);
    expect(d.store.lane("hc-lane")!.nudges).toBe(0);
    expect(w.hc.sent).toEqual([]);
  });

  test("a lane under migration is left alone: not lost, not nudged, its activity stamp untouched", async () => {
    const w = new World();
    const d = w.deps({ runtime: "hc" });
    d.store.saveLane(lane({ migration: true }));
    w.clock = 60 * 60_000;
    expect(await dutyTick(d)).toEqual([]);
    expect(d.store.lane("hc-lane")).toMatchObject({ status: "working", nudges: 0, lastActivityAt: 0 });
    expect(w.hc.calls).toEqual([]);
  });

  test("a migration that starts during the probe is seen by the re-read before saving", async () => {
    const w = new World();
    const d = w.deps({ runtime: "hc" });
    d.store.saveLane(lane());
    const exec = w.hc.exec;
    w.hc.terminals.set("t1", terminal({ state: "finished" }));
    Object.defineProperty(w.hc, "exec", {
      value: async (cmd: string, argv: readonly string[]) => {
        d.store.saveLane({ ...d.store.lane("hc-lane")!, migration: true });
        return exec(cmd, argv);
      },
    });
    expect(await dutyTick(d)).toEqual([]);
    expect(d.store.lane("hc-lane")!.status).toBe("working");
  });
});
