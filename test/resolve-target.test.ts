import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveTarget } from "../src/target.ts";
import { Refusal } from "../src/refusal.ts";
import type { SessionRef } from "../src/runtime/types.ts";
import type { Lane } from "../src/store-types.ts";
import { World } from "./fake.ts";

const lane = (key: string, sessionRef: SessionRef, status: Lane["status"] = "working"): Lane => ({
  key,
  sessionRef,
  paneId: sessionRef.id,
  tabId: "",
  brief: "/b.md",
  cwd: "/w",
  status,
  createdAt: 0,
  lastActivityAt: 0,
  nudges: 0,
  log: [],
});

function setup() {
  const d = new World().deps();
  writeFileSync(join(d.store.root, "roles.json"), JSON.stringify({ lead: "w1:p1", duty: "hc:t2" }));
  d.store.saveLane(lane("t7", { runtime: "herdr", id: "w1:p5" }));
  d.store.saveLane(lane("t8", { runtime: "hc", id: "t8" }, "done"));
  return d;
}

describe("resolveTarget: prefixed ref, role, open lane key, bare herdr pane", () => {
  test.each([
    ["hc:t7", { runtime: "hc", id: "t7" }],
    ["herdr:w1:p3", { runtime: "herdr", id: "w1:p3" }],
    ["w1:p3", { runtime: "herdr", id: "w1:p3" }],
    ["lead", { runtime: "herdr", id: "w1:p1" }],
    ["duty", { runtime: "hc", id: "t2" }],
    ["t7", { runtime: "herdr", id: "w1:p5" }],
  ] as const)("%s", (target, want) => {
    expect(resolveTarget(setup(), target)).toEqual(want);
  });

  test("a lane named t7 wins over the hc terminal t7, which needs its prefix", () => {
    const d = setup();
    expect(resolveTarget(d, "t7")).toEqual({ runtime: "herdr", id: "w1:p5" });
    expect(resolveTarget(d, "hc:t7")).toEqual({ runtime: "hc", id: "t7" });
  });

  test.each([
    ["t8", "unknown target t8"],
    ["nobody", "unknown target nobody"],
    ["hc:w1:p3", "not a session ref"],
    ["herdr:t7", "not a session ref"],
    ["hourly-loop", "no hourly-loop session registered"],
  ])("%s is refused: %s", (target, why) => {
    expect(() => resolveTarget(setup(), target)).toThrow(Refusal);
    expect(() => resolveTarget(setup(), target)).toThrow(why);
  });
});
