import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Deps } from "../src/harness.ts";
import { hooksSettled } from "../src/hooks.ts";
import { done, ready, report, startLane } from "../src/lanes.ts";
import type { World } from "./fake.ts";
import { setup } from "./harness-setup.ts";

const config = (d: Deps, value: unknown) => writeFileSync(join(d.store.root, "config.json"), JSON.stringify(value));
const idleCalls = (w: World) => w.calls.filter((c) => c.cmd === "idle-hook").map((c) => c.argv);

async function finish(d: Deps, key: string): Promise<void> {
  await ready(d, key, "finished", ["receipt.txt"]);
  await done(d, key);
  await hooksSettled();
}

describe("onIdle", () => {
  test("does not run while another work lane is open, then runs once the last one closes", async () => {
    const { w, d, brief } = setup();
    await startLane(d, "first", brief, { group: "w1" });
    await startLane(d, "second", brief, { group: "w1" });
    config(d, { hooks: { onIdle: ["idle-hook", "{key}"] } });
    await finish(d, "first");
    expect(idleCalls(w)).toEqual([]);
    await finish(d, "second");
    expect(idleCalls(w)).toEqual([["second"]]);
  });

  test("a waiting or ready lane still counts as open work", async () => {
    const { w, d, brief } = setup();
    await startLane(d, "closing", brief, { group: "w1" });
    await startLane(d, "parked", brief, { group: "w1" });
    await startLane(d, "reviewed", brief, { group: "w1" });
    await report(d, "parked", "blocked on CI", "waiting");
    await ready(d, "reviewed", "awaiting merge", ["pr"]);
    config(d, { hooks: { onIdle: ["idle-hook", "{key}"] } });
    await finish(d, "closing");
    expect(idleCalls(w)).toEqual([]);
  });

  test("a lane listed in chatLanes does not count as work", async () => {
    const { w, d, brief } = setup();
    await startLane(d, "discord-chat", brief, { group: "w1" });
    await report(d, "discord-chat", "listening", "waiting");
    await startLane(d, "task", brief, { group: "w1" });
    config(d, { chatLanes: ["discord-chat"], hooks: { onIdle: ["idle-hook", "{key}"] } });
    await finish(d, "task");
    expect(idleCalls(w)).toEqual([["task"]]);
  });
});
