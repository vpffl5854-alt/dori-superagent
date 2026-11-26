import { describe, expect, test } from "bun:test";
import { dutyTick } from "../src/duty.ts";
import { report, startLane } from "../src/lanes.ts";
import { setup } from "./harness-setup.ts";

const stuckAt = (received: string[]): string[] => received.filter((m) => m.includes("[STUCK "));

describe("a pane resting in blocked or error", () => {
  test("tells the lead once per stall after ten minutes, and types nothing into the pane", async () => {
    const { w, d, lead, brief } = setup();
    // A budget longer than this test's clock: the subject is the stall clock, and Dori's watchdog (budget x1.5) would
    // otherwise close the lane mid-test for an unrelated reason.
    const lane = await startLane(d, "stuck", brief, { group: "w1", budgetMin: 240 });
    const pane = w.panes.get(lane.paneId)!;
    pane.status = "blocked";
    const at = async (min: number) => {
      w.clock = lane.createdAt + min * 60_000;
      return dutyTick(d);
    };

    // The first sight of the stall only starts the clock.
    expect(await at(0)).toEqual([]);
    expect(await at(9)).toEqual([]);
    expect(stuckAt(lead.received)).toEqual([]);
    expect(await at(11)).toContainEqual({ lane: "stuck", action: "stuck" });
    expect(stuckAt(lead.received)).toHaveLength(1);
    expect(stuckAt(lead.received)[0]).toContain("[STUCK stuck]");
    expect(stuckAt(lead.received)[0]).toContain("blocked for 11 min");
    expect(stuckAt(lead.received)[0]).toContain("needs a person");

    // The same stall is reported once, however long it lasts.
    expect(await at(30)).toEqual([]);
    expect(await at(90)).toEqual([]);
    expect(stuckAt(lead.received)).toHaveLength(1);

    // Nothing was ever typed into the pane, and no nudge was recorded.
    expect(pane.received).toEqual([]);
    expect(d.store.lane("stuck")!.nudges).toBe(0);
    expect(d.store.lane("stuck")!.log.filter((e) => e.kind === "nudge")).toEqual([]);
  });

  test("is reported again after the pane works and stalls a second time", async () => {
    const { w, d, lead, brief } = setup();
    const lane = await startLane(d, "twice", brief, { group: "w1" });
    const pane = w.panes.get(lane.paneId)!;
    pane.status = "blocked";
    w.clock = lane.createdAt;
    expect(await dutyTick(d)).toEqual([]);
    w.clock = lane.createdAt + 11 * 60_000;
    expect(await dutyTick(d)).toContainEqual({ lane: "twice", action: "stuck" });
    expect(stuckAt(lead.received)).toHaveLength(1);

    // Idle, not working: the stall is over either way, and the record says so on disk. The idle lane then takes its
    // ordinary first nudge, which is a different message to a different place.
    pane.status = "idle";
    w.clock += 60_000;
    expect(await dutyTick(d)).toContainEqual({ lane: "twice", action: "nudge-1" });
    expect(stuckAt(lead.received)).toHaveLength(1);
    expect(d.store.lane("twice")!.blockedSince).toBeUndefined();
    expect(d.store.lane("twice")!.blockedAlerted).toBeUndefined();

    pane.status = "blocked";
    w.clock += 60_000;
    expect(await dutyTick(d)).toEqual([]);
    w.clock += 11 * 60_000;
    expect(await dutyTick(d)).toContainEqual({ lane: "twice", action: "stuck" });
    expect(stuckAt(lead.received)).toHaveLength(2);
  });

  test("a working pane is never reported, and the stall clock starts at the first blocked sight", async () => {
    const { w, d, lead, brief } = setup();
    const busy = await startLane(d, "busy", brief, { group: "w1", budgetMin: 240 });
    const late = await startLane(d, "late", brief, { group: "w1", budgetMin: 240 });
    w.panes.get(busy.paneId)!.status = "working";
    w.panes.get(late.paneId)!.status = "working";
    w.clock = busy.createdAt + 60 * 60_000;
    expect(await dutyTick(d)).toEqual([]);
    expect(stuckAt(lead.received)).toEqual([]);

    // Blocked only for the last two minutes: the minute count is measured from the first tick that saw it, never from
    // how long the session has been alive.
    w.panes.get(late.paneId)!.status = "blocked";
    expect(await dutyTick(d)).toEqual([]);
    w.clock += 2 * 60_000;
    expect(await dutyTick(d)).toEqual([]);
    w.clock += 9 * 60_000;
    expect(await dutyTick(d)).toContainEqual({ lane: "late", action: "stuck" });
    expect(stuckAt(lead.received)).toHaveLength(1);
    expect(stuckAt(lead.received)[0]).toContain("blocked for 11 min");
    expect(stuckAt(lead.received).some((m) => m.includes("busy"))).toBe(false);
  });

  test("a lane that reported WAITING is not told twice: it already named what it waits on", async () => {
    const { w, d, lead, brief } = setup();
    const lane = await startLane(d, "waiting", brief, { group: "w1" });
    await report(d, "waiting", "WAITING: a person must approve the release", "waiting");
    w.panes.get(lane.paneId)!.status = "blocked";
    w.clock = lane.createdAt + 60 * 60_000;
    expect(await dutyTick(d)).toEqual([]);
    expect(stuckAt(lead.received)).toEqual([]);
    expect(d.store.lane("waiting")!.blockedSince).toBeUndefined();
  });
});
