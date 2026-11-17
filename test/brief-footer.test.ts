import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { done, ready, startLane } from "../src/lanes.ts";
import { setup } from "./harness-setup.ts";

test("re-opening a lane keeps one copy of the lane rules in its brief", async () => {
  const { w, d, brief } = setup();
  const first = await startLane(d, "again", brief, { group: "w1" });
  const path = d.store.briefPath("again");
  expect(readFileSync(path, "utf8").match(/## Lane rules \(added by dori/g)?.length).toBe(1);

  w.panes.get(first.paneId)!.status = "gone";
  await ready(d, "again", "done", ["file:///tmp/evidence"]);
  await done(d, "again");
  await startLane(d, "again", path, { group: "w1" });

  const twice = readFileSync(path, "utf8");
  expect(twice.match(/## Lane rules \(added by dori/g)?.length).toBe(1);
  expect(twice.startsWith("Fix the flaky login test.")).toBe(true);
});
