import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { acquireSlot, releaseSlot } from "../src/heavy-slot.ts";
import { guardTick, sampleHost } from "../src/host-guard.ts";
import type { Runner } from "../src/run.ts";
import { fakeClock, withState } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");

let state: ReturnType<typeof withState>;

beforeEach(() => {
  state = withState();
});

afterEach(() => state.done());

const linuxHost =
  (meminfo: string | null): Runner =>
  async (argv) => {
    const [cmd] = argv;
    if (cmd === "cat" && argv[1] === "/proc/meminfo")
      return meminfo === null ? { code: 1, out: "", err: "no such file" } : { code: 0, out: meminfo, err: "" };
    if (cmd === "cat") return { code: 0, out: "0.50 0.40 0.30 1/200 999", err: "" };
    if (cmd === "df")
      return {
        code: 0,
        out: "Filesystem 1K-blocks Used Available Use% Mounted\n/dev/x 1000 500 524288 50% /",
        err: "",
      };
    return { code: 127, out: "", err: "not found" };
  };

test("the host guard alerts on low disk, clears when it recovers, and flips compute readiness on load", () => {
  const t = { loadAlert: 150, loadOk: 80, memFreeMinPct: 20, diskFreeMinGb: 50, panesMax: 20 };
  const st = { alerting: false } as { alerting: boolean; computeReady?: boolean };
  const healthy = { load1: 40, memFreePct: 50, diskFreeGb: 200, swapFreeGb: 4, panes: 5 };
  expect(guardTick(healthy, t, st)).toEqual(["HOST_GUARD COMPUTE_READY load 40 < 80"]);
  expect(guardTick({ ...healthy, diskFreeGb: 12 }, t, st)).toEqual(["HOST_GUARD ALERT disk free 12 GB < 50 GB"]);
  expect(guardTick({ ...healthy, diskFreeGb: 12 }, t, st)).toEqual([]);
  const recovered = guardTick({ ...healthy, load1: 120 }, t, st);
  expect(recovered[0]).toStartWith("HOST_GUARD CLEAR");
  expect(recovered.slice(1)).toEqual(["HOST_GUARD COMPUTE_BUSY load 120"]);
});

test("on Linux the host guard reports 0% free when MemAvailable is 0", async () => {
  const s = await sampleHost(
    linuxHost("MemTotal:       16000000 kB\nMemFree:               0 kB\nMemAvailable:          0 kB\n"),
  );
  expect(s.memFreePct).toBe(0);
});

test("on Linux the host guard reads free memory from /proc/meminfo when memory_pressure is missing", async () => {
  const s = await sampleHost(
    linuxHost("MemTotal:       16000000 kB\nMemFree:          200000 kB\nMemAvailable:    4000000 kB\n"),
  );
  expect(s.memFreePct).toBe(25);
});

test("the host guard keeps memory at 100% when neither memory_pressure nor /proc/meminfo works", async () => {
  expect((await sampleHost(linuxHost(null))).memFreePct).toBe(100);
  expect((await sampleHost(linuxHost("MemTotal:       16000000 kB\n"))).memFreePct).toBe(100);
});

test("a heavy slot waits for load to drop, and a slot held by a dead process is taken over", async () => {
  const dir = join(state.dir, "heavy");
  const clock = fakeClock(T0);
  let loads = [120, 95, 40];
  const base = { dir, slots: 1, maxLoad: 80, clock, pid: 4242, load: async () => loads.shift() ?? 40 };
  const slot = await acquireSlot({ ...base, alive: () => true }, "build");
  expect(loads).toEqual([]);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(slot, "owner"), "999999 other 2026-01-01T00:00:00Z");
  loads = [10];
  let polls = 0;
  const stolen = await acquireSlot(
    {
      ...base,
      alive: (pid) => pid !== 999999,
      clock: {
        ...clock,
        sleep: async () => {
          polls++;
        },
      },
    },
    "test",
  );
  expect(stolen).toBe(slot);
  expect(polls).toBe(0);
  releaseSlot(stolen);
});

test("a slot whose owner is alive is not taken", async () => {
  const dir = join(state.dir, "heavy");
  mkdirSync(join(dir, "slot.1"), { recursive: true });
  writeFileSync(join(dir, "slot.1", "owner"), "1 busy now");
  utimesSync(join(dir, "slot.1"), new Date(), new Date());
  let polls = 0;
  const clock = {
    now: () => Date.now(),
    sleep: async () => {
      polls++;
      if (polls > 2) throw new Error("stop");
    },
  };
  await expect(
    acquireSlot({ dir, slots: 1, maxLoad: 80, clock, pid: 7, load: async () => 10, alive: () => true }, "x", 1),
  ).rejects.toThrow("stop");
});

test("an unknown session count (-1) is an alert, not a pass", () => {
  const t = { loadAlert: 150, loadOk: 80, memFreeMinPct: 20, diskFreeMinGb: 50, panesMax: 20 };
  const st = { alerting: false, computeReady: true };
  const healthy = { load1: 40, memFreePct: 50, diskFreeGb: 200, swapFreeGb: 4, panes: 5 };
  expect(guardTick({ ...healthy, panes: -1 }, t, st)).toEqual(["HOST_GUARD ALERT session count unknown"]);
  expect(guardTick({ ...healthy, panes: -1 }, { ...t, panesMax: 0 }, st)[0]).toStartWith("HOST_GUARD CLEAR");
});
