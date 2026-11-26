import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HeavyAdmissionError } from "../src/heavy-lock.ts";
import {
  acquireSlot,
  decideNow,
  type HeavyPolicy,
  heldSlots,
  pidAlive,
  SAMPLE_MAX_AGE_MS,
  WARMUP_MS,
} from "../src/heavy-slot.ts";
import { withState } from "./fakes.ts";

const policy: HeavyPolicy = { minSlots: 1, maxSlots: 4, maxLoad: 10, jobMemGb: 4, memFreeMinPct: 15 };
const asRoot = process.getuid?.() === 0;

let state: ReturnType<typeof withState>;
beforeEach(() => {
  state = withState();
});
afterEach(() => state.done());

const holder = (dir: string, n: number, pid: number): string => {
  const slot = join(dir, `slot.${n}`);
  mkdirSync(slot, { recursive: true });
  writeFileSync(join(slot, "owner"), `${pid} job${n} ${new Date(Date.now() - 2 * WARMUP_MS).toISOString()}`);
  return slot;
};

// host() that takes 1.5 s of clock time on every call, like a slow memory read after the load read.
const slowHost = (dir: string) => {
  let t = 0;
  let sampled = 0;
  const logs: string[] = [];
  const deps = {
    dir,
    policy,
    pid: 7,
    alive: () => true,
    log: (l: string) => logs.push(l),
    host: async () => {
      sampled++;
      t += SAMPLE_MAX_AGE_MS + 500;
      return { load1: 2, memFreePct: 80, memTotalGb: 30 };
    },
    elapsedMs: () => t,
    clock: {
      // The wall clock steps back 2 s on every read: the age must not depend on it.
      now: (() => {
        let wall = Date.now();
        return () => (wall -= 2_000);
      })(),
      sleep: async () => {
        throw new Error("waits");
      },
    },
  };
  return { deps, logs, sampled: () => sampled };
};

test("time spent inside host() counts toward the sample age, so a slow probe cannot admit above the floor", async () => {
  const dir = join(state.dir, "heavy");
  holder(dir, 1, process.pid);
  const { deps, logs, sampled } = slowHost(dir);
  await expect(acquireSlot(deps, "slow-probe", 1)).rejects.toThrow("waits");
  expect(sampled()).toBe(3);
  expect(heldSlots(deps)).toHaveLength(1);
  expect(logs[0]).toContain("load unknown");
});

test("a sample that stays slow still lets the floor run, decided on unknown readings", async () => {
  const dir = join(state.dir, "heavy");
  mkdirSync(dir, { recursive: true });
  const { deps, logs, sampled } = slowHost(dir);
  expect(await acquireSlot(deps, "floor", 1)).toBe(join(dir, "slot.1"));
  expect(sampled()).toBe(3);
  expect(logs[0]).toContain("(floor)");
});

test.skipIf(asRoot)("a process of another user (EPERM) is alive, not dead", () => {
  expect(pidAlive(1)).toBe(true);
});

test.skipIf(asRoot)("an owner file that exists but cannot be read keeps its slot held, however old", () => {
  const dir = join(state.dir, "heavy");
  const slot = holder(dir, 1, 999_999);
  const old = new Date(Date.now() - 10 * 60_000);
  utimesSync(slot, old, old);
  chmodSync(join(slot, "owner"), 0o000);
  try {
    expect(
      heldSlots({ dir, alive: () => false, clock: { now: () => Date.now(), sleep: async () => {} } }),
    ).toHaveLength(1);
  } finally {
    chmodSync(join(slot, "owner"), 0o644);
  }
});

test.skipIf(asRoot)("a slot directory that cannot be listed stops admission with a clear error", async () => {
  const dir = join(state.dir, "heavy");
  holder(dir, 1, process.pid);
  chmodSync(dir, 0o000);
  try {
    expect(() =>
      heldSlots({ dir, alive: () => true, clock: { now: () => Date.now(), sleep: async () => {} } }),
    ).toThrow(HeavyAdmissionError);
  } finally {
    chmodSync(dir, 0o755);
  }
});

// Two samples: the first slow (stale), the second fast; the stale one must decide nothing in either direction.
const twoSamples = (first: number, second: number) => {
  let t = 0;
  const loads = [first, second];
  return {
    policy,
    clock: { now: () => Date.now(), sleep: async () => {} },
    elapsedMs: () => t,
    host: async () => {
      const load1 = loads.shift() ?? second;
      if (loads.length === 1) t += SAMPLE_MAX_AGE_MS + 500;
      return { load1, memFreePct: 80, memTotalGb: 30 };
    },
  };
};

test("a stale sample decides neither a start nor a wait: the fresh one after it does", async () => {
  const held = [{ slot: "slot.1", owner: { pid: 1, label: "running", since: 0 } }];
  const rising = await decideNow(twoSamples(2, 12), held);
  expect(rising).toMatchObject({ admit: false, limit: 1 });
  expect(rising.reason).toContain("load 12.0 >= 10");
  const falling = await decideNow(twoSamples(12, 2), held);
  expect(falling).toMatchObject({ admit: true, limit: 4 });
  expect(falling.reason).toContain("load 2.0 < 10");
});

test("nothing reads a clock between the fresh sample and the claim, so no pause there can act on it", async () => {
  const dir = join(state.dir, "heavy");
  holder(dir, 1, process.pid);
  const events: string[] = [];
  const slot = await acquireSlot(
    {
      dir,
      policy,
      pid: 7,
      alive: () => true,
      log: () => {},
      elapsedMs: () => {
        events.push("elapsed");
        return 0;
      },
      host: async () => {
        events.push("host");
        return { load1: 2, memFreePct: 80, memTotalGb: 30 };
      },
      clock: {
        now: () => {
          events.push("now");
          return Date.now();
        },
        sleep: async () => {},
      },
    },
    "after-sample",
    1,
  );
  expect(slot).toBe(join(dir, "slot.2"));
  expect(events.slice(events.lastIndexOf("host"))).toEqual(["host", "elapsed"]);
});
