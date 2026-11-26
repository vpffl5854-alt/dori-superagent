import { afterEach, beforeEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { ConfigError, loadConfig } from "../src/config.ts";
import { leadKind, prepareLaunch } from "../src/launch.ts";
import { depsFor, fakeClock, newWorld, withState, type World } from "./fakes.ts";

const T0 = Date.parse("2026-11-21T02:00:00.000Z");
let state: ReturnType<typeof withState>;
let world: World;
beforeEach(() => {
  state = withState();
  world = newWorld();
});
afterEach(() => state.done());

const configWith = async (body: object) => {
  const path = join(state.dir, "config.json");
  writeFileSync(path, JSON.stringify(body));
  return loadConfig(path, "/home/ana");
};

test("leadRuntime takes omo-host beside a terminal runtime", async () => {
  expect(await configWith({ runtime: "hc", leadRuntime: "omo-host" })).toMatchObject({
    runtime: "hc",
    leadRuntime: "omo-host",
  });
});

test("an unknown leadRuntime stops the load with its name", async () => {
  await expect(configWith({ runtime: "hc", leadRuntime: "tmux" })).rejects.toThrow(/invalid leadRuntime/);
});

test("runtime still never takes omo-host, even when leadRuntime does", async () => {
  await expect(configWith({ runtime: "omo-host", leadRuntime: "omo-host" })).rejects.toThrow(ConfigError);
});

test("leadKind is leadRuntime when set, else the selected runtime, and the lane footer follows it", async () => {
  expect(leadKind(depsFor(world, fakeClock(T0), state.dir, { leadRuntime: "omo-host" }))).toBe("omo-host");
  expect(leadKind(depsFor(world, fakeClock(T0), state.dir))).toBe("herdr");
  const brief = join(state.dir, "brief.md");
  writeFileSync(brief, "# brief\n");
  const input = { key: "fix-x", title: "t", brief, done: "closed acme/app#3" };
  const viaHc = await prepareLaunch(depsFor(world, fakeClock(T0), state.dir, { leadRuntime: "hc" }), input);
  expect(viaHc.preamble).toContain(JSON.stringify(["hc", "send", "lead:p1", "--", "[REPORT] ..."]));
});
