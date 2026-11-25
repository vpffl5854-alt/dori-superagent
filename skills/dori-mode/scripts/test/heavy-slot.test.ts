import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  acquireSlot,
  type HeavyPolicy,
  heavyAdmission,
  heldSlots,
  WARMUP_MS,
  warmingCount,
} from "../src/heavy-slot.ts";
import { fakeClock, withState } from "./fakes.ts";

const policy: HeavyPolicy = { minSlots: 1, maxSlots: 4, maxLoad: 10, jobMemGb: 4, memFreeMinPct: 15 };
const host = (memFreePct: number, load1 = 2) => ({ load1, memFreePct, memTotalGb: 30 });

let state: ReturnType<typeof withState>;
beforeEach(() => {
  state = withState();
});
afterEach(() => state.done());

test("free memory above the guard floor sets the limit: 15 GB free on 30 GB fits two more 4 GB jobs", () => {
  const d = heavyAdmission(policy, host(50), 1, 0);
  expect(d).toMatchObject({ limit: 3, admit: true });
  expect(d.reason).toStartWith("limit 3 of 1-4 (memory), running 1:");
});

test("the limit never passes the ceiling, however much memory is free", () => {
  expect(heavyAdmission(policy, host(95), 0, 0)).toMatchObject({ limit: 4, admit: true });
  expect(heavyAdmission(policy, host(95), 4, 0)).toMatchObject({ limit: 4, admit: false });
});

test("the floor always runs, even below the memory floor or over the load limit", () => {
  expect(heavyAdmission(policy, host(10), 0, 0)).toMatchObject({ limit: 1, admit: true });
  const loaded = heavyAdmission(policy, host(80, 40), 0, 0);
  expect(loaded).toMatchObject({ limit: 1, admit: true });
  expect(loaded.reason).toStartWith("limit 1 of 1-4 (floor)");
});

test("high load stops admissions above the floor without lowering what already runs", () => {
  const d = heavyAdmission(policy, host(80, 12), 2, 0);
  expect(d).toMatchObject({ limit: 2, admit: false });
  expect(d.reason).toContain("(load)");
  expect(d.reason).toContain("load 12.0 >= 10");
});

test("when memory drops the limit shrinks below the running count and only new admissions stop", () => {
  const d = heavyAdmission(policy, host(12), 3, 0);
  expect(d).toMatchObject({ limit: 2, admit: false });
  expect(d.reason).toContain("fits 1 fewer");
});

test("a job still starting is reserved at the per-job estimate, since free memory does not show it yet", () => {
  expect(heavyAdmission(policy, host(50), 1, 0).limit).toBe(3);
  expect(heavyAdmission(policy, host(50), 1, 1).limit).toBe(2);
});

test("a shrunk limit leaves every running slot in place while a new job waits", async () => {
  const dir = join(state.dir, "heavy");
  const T0 = Date.parse("2026-01-01T12:00:00.000Z");
  const since = new Date(T0 - 2 * WARMUP_MS).toISOString();
  for (const n of [1, 2, 3]) {
    mkdirSync(join(dir, `slot.${n}`), { recursive: true });
    writeFileSync(join(dir, `slot.${n}`, "owner"), `${100 + n} job${n} ${since}\n`);
  }
  const logs: string[] = [];
  let polls = 0;
  const clock = {
    ...fakeClock(T0),
    sleep: async () => {
      polls++;
      if (polls > 1) throw new Error("stop");
    },
  };
  const deps = { dir, policy, clock, pid: 7, alive: () => true, log: (l: string) => logs.push(l) };
  await expect(acquireSlot({ ...deps, host: async () => host(12) }, "new", 1)).rejects.toThrow("stop");
  expect(heldSlots(deps).map((h) => h.owner?.label)).toEqual(["job1", "job2", "job3"]);
  expect(logs).toHaveLength(1);
  expect(logs[0]).toStartWith("HEAVY_WAIT new limit 2 of 1-4 (memory), running 3:");
});

test("a job that leaves exactly the floor is admitted (the gate's 16780160 kB / 6711328 kB sample)", () => {
  const total = 16780160 / 1024 ** 2;
  const d = heavyAdmission(
    { ...policy, minSlots: 0 },
    { load1: 2, memFreePct: (6711328 / 16780160) * 100, memTotalGb: total },
    1,
    0,
  );
  expect(d).toMatchObject({ limit: 2, admit: true });
});

test("a job that leaves memory just under the floor is held: 27.6% of 31 GB minus 4 GB is 14.7%", () => {
  const p = { ...policy, minSlots: 0 };
  expect(heavyAdmission(p, { load1: 2, memFreePct: 27.6, memTotalGb: 31 }, 1, 0)).toMatchObject({
    limit: 1,
    admit: false,
  });
  expect(heavyAdmission(p, { load1: 2, memFreePct: 28, memTotalGb: 31 }, 1, 0)).toMatchObject({
    limit: 2,
    admit: true,
  });
});

test("a label with spaces keeps its start time, so an old job no longer counts as starting", () => {
  const dir = join(state.dir, "heavy");
  const T0 = Date.parse("2026-01-01T12:00:00.000Z");
  mkdirSync(join(dir, "slot.1"), { recursive: true });
  writeFileSync(join(dir, "slot.1", "owner"), `42 browser suite ${new Date(T0 - 10 * 60_000).toISOString()}`);
  const held = heldSlots({ dir, alive: () => true, clock: fakeClock(T0) });
  expect(held[0]?.owner).toEqual({ pid: 42, label: "browser suite", since: T0 - 10 * 60_000 });
  expect(warmingCount(held, T0)).toBe(0);
});

test("unknown memory gives no headroom above the floor and says so", () => {
  const d = heavyAdmission(policy, { load1: 2, memFreePct: Number.NaN, memTotalGb: 30 }, 0, 0);
  expect(d).toMatchObject({ limit: 1, admit: true });
  expect(d.reason).toContain("memory unknown");
  expect(heavyAdmission(policy, { load1: 2, memFreePct: Number.NaN, memTotalGb: 30 }, 1, 0)).toMatchObject({
    limit: 1,
    admit: false,
  });
});

test("unknown load admits nothing above the floor, however much memory is free", () => {
  const d = heavyAdmission(policy, { load1: Number.NaN, memFreePct: 90, memTotalGb: 30 }, 1, 0);
  expect(d).toMatchObject({ limit: 1, admit: false });
  expect(d.reason).toContain("load unknown");
});
