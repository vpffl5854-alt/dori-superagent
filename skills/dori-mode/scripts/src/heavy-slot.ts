import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { HeavyAdmissionError, underLock } from "./heavy-lock.ts";
import type { Clock } from "./run.ts";

export type HeavyPolicy = {
  readonly minSlots: number;
  readonly maxSlots: number;
  readonly maxLoad: number;
  readonly jobMemGb: number;
  /** Free memory, in percent of total, that must remain after reserving a new job (the HOST_GUARD threshold). */
  readonly memFreeMinPct: number;
};

export type HeavyHost = { readonly load1: number; readonly memFreePct: number; readonly memTotalGb: number };

export type HeavyDecision = { readonly limit: number; readonly admit: boolean; readonly reason: string };

/**
 * The dynamic slot count. Free memory already excludes what running jobs use, except jobs still starting
 * (`warming`), which are reserved at the per-job estimate. A lower limit than `running` only stops new admissions:
 * nothing here ever ends a running job.
 */
export const heavyAdmission = (p: HeavyPolicy, host: HeavyHost, running: number, warming: number): HeavyDecision => {
  // NaN means the probe could not read the value: no headroom above the floor rather than a guess.
  const memKnown = Number.isFinite(host.memFreePct),
    loadKnown = Number.isFinite(host.load1);
  const freeGb = (host.memFreePct / 100) * host.memTotalGb;
  const spareGb = freeGb - (p.memFreeMinPct / 100) * host.memTotalGb - warming * p.jobMemGb;
  // The tolerance keeps a job that leaves exactly the floor (an exact 1.0 computed as 0.9999...) admitted.
  const fits = memKnown ? Math.floor(spareGb / p.jobMemGb + 1e-9) : Number.NEGATIVE_INFINITY;
  const loadOk = loadKnown && host.load1 < p.maxLoad;
  const wanted = loadOk ? running + fits : Math.min(running, running + fits);
  const limit = Math.max(p.minSlots, Math.min(p.maxSlots, wanted));
  const bound = wanted >= p.maxSlots ? "ceiling" : wanted < p.minSlots ? "floor" : !loadOk ? "load" : "memory";
  const reason =
    `limit ${limit} of ${p.minSlots}-${p.maxSlots} (${bound}), running ${running}${warming ? ` (${warming} starting)` : ""}: ` +
    (memKnown
      ? `memory ${+host.memFreePct.toFixed(1)}% free (${freeGb.toFixed(1)} of ${host.memTotalGb.toFixed(0)} GB), ` +
        `${p.jobMemGb} GB per job above ${p.memFreeMinPct}% fits ${fits >= 0 ? `${fits} more` : `${-fits} fewer`}; `
      : "memory unknown (could not be read); ") +
    (loadKnown
      ? `load ${host.load1.toFixed(1)} ${loadOk ? "<" : ">="} ${p.maxLoad}`
      : "load unknown (could not be read)");
  return { limit, admit: running < limit, reason };
};

export type SlotDeps = {
  readonly dir: string;
  readonly policy: HeavyPolicy;
  readonly clock: Clock;
  readonly host: () => Promise<HeavyHost>;
  readonly alive: (pid: number) => boolean;
  readonly pid: number;
  readonly log: (line: string) => void;
  /** Monotonic milliseconds for the sample age; performance.now() unless a test drives it. */
  readonly elapsedMs?: () => number;
};

const ORPHAN_MS = 60_000;
/** A job this young has not reached its memory yet, so free memory does not show it. */
export const WARMUP_MS = 120_000;

type Owner = { readonly pid: number; readonly label: string; readonly since: number };

const isMissing = (e: unknown): boolean => (e as { code?: string } | null)?.code === "ENOENT";

// null = no owner file (yet); "unreadable" = it is there but cannot be read, so its holder is unknown.
const readOwner = (slot: string): Owner | null | "unreadable" => {
  let owner = "";
  try {
    owner = readFileSync(join(slot, "owner"), "utf8");
  } catch (e) {
    return isMissing(e) ? null : "unreadable";
  }
  const words = owner.trim().split(/\s+/);
  return { pid: Number(words[0]), label: words.slice(1, -1).join(" "), since: Date.parse(words.at(-1) ?? "") };
};

// True only when the slot is confirmed free: its owner is dead, or it has no owner file and is older than ORPHAN_MS, or
// it is gone. Anything that cannot be confirmed keeps the slot held.
const orphaned = (deps: Pick<SlotDeps, "alive" | "clock">, slot: string): boolean => {
  const owner = readOwner(slot);
  if (owner === "unreadable") return false;
  if (owner) return !deps.alive(owner.pid);
  try {
    return deps.clock.now() - statSync(slot).mtimeMs > ORPHAN_MS;
  } catch (e) {
    return isMissing(e);
  }
};

export type HeldSlot = { readonly slot: string; readonly owner: Owner | null };

const ownerOf = (slot: string): Owner | null => {
  const owner = readOwner(slot);
  return owner === "unreadable" ? null : owner;
};

export const heldSlots = (deps: Pick<SlotDeps, "dir" | "alive" | "clock">): HeldSlot[] => {
  let names: string[] = [];
  try {
    names = readdirSync(deps.dir).filter((n) => /^slot\.\d+$/.test(n));
  } catch (e) {
    if (isMissing(e)) return [];
    throw new HeavyAdmissionError(
      `cannot list heavy slots in ${deps.dir}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  return names
    .sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)))
    .map((n) => join(deps.dir, n))
    .filter((slot) => !orphaned(deps, slot))
    .map((slot) => ({ slot, owner: ownerOf(slot) }));
};

export const warmingCount = (held: readonly HeldSlot[], now: number): number =>
  held.filter((h) => !h.owner || now - h.owner.since < WARMUP_MS).length;

// Only under the admission lock, on a slot heldSlots did not list: either absent or left by a dead owner, so it is
// cleared and claimed without probing its owner again.
const claim = (deps: SlotDeps, slot: string, label: string, stamp: string): string => {
  rmSync(slot, { recursive: true, force: true });
  mkdirSync(slot);
  writeFileSync(join(slot, "owner"), `${deps.pid} ${label} ${stamp}`);
  return slot;
};

export const SAMPLE_MAX_AGE_MS = 1_000;
const SAMPLE_TRIES = 3;
// The decision on a fresh sample. Its age is measured once, on monotonic time from before the first reading (load)
// to the end of the last (memory), so a slow probe or a wall-clock step cannot hide it. A sample older than
// SAMPLE_MAX_AGE_MS decides nothing (no start, no wait reason) and is taken again; after SAMPLE_TRIES stale samples the
// readings count as unknown, which admits the floor only. What follows the sample is arithmetic and the claim.
export const decideNow = async (
  deps: Pick<SlotDeps, "policy" | "host" | "clock" | "elapsedMs">,
  held: readonly HeldSlot[],
): Promise<HeavyDecision> => {
  const elapsed = deps.elapsedMs ?? (() => performance.now());
  // The wall clock (warm-up) is read before the sample: after the age check only arithmetic runs.
  const warming = warmingCount(held, deps.clock.now());
  for (let tries = 1; ; tries++) {
    const started = elapsed();
    const host = await deps.host();
    const fresh = elapsed() - started <= SAMPLE_MAX_AGE_MS;
    if (fresh || tries === SAMPLE_TRIES) {
      const used = fresh ? host : { ...host, load1: Number.NaN, memFreePct: Number.NaN };
      const d = heavyAdmission(deps.policy, used, held.length, warming);
      return fresh
        ? d
        : { ...d, reason: `${d.reason}; host sample took over ${SAMPLE_MAX_AGE_MS} ms ${SAMPLE_TRIES} times` };
    }
  }
};

export const acquireSlot = async (deps: SlotDeps, label: string, pollMs = 15_000): Promise<string> => {
  mkdirSync(deps.dir, { recursive: true });
  let last = "";
  for (;;) {
    const { d, slot } = await underLock(deps.dir, async () => {
      // Every owner probe (ps) runs before the host sample, so the memory reading is the last outside read before the
      // decision and the claim.
      const held = heldSlots(deps);
      const taken = new Set(held.map((h) => h.slot));
      const free = Array.from({ length: deps.policy.maxSlots }, (_, i) => join(deps.dir, `slot.${i + 1}`)).find(
        (s) => !taken.has(s),
      );
      const stamp = new Date(deps.clock.now()).toISOString();
      const d = await decideNow(deps, held);
      return { d, slot: d.admit && free !== undefined ? claim(deps, free, label, stamp) : null };
    });
    if (slot) {
      deps.log(`HEAVY_START ${label} ${d.reason}`);
      return slot;
    }
    if (d.reason !== last) deps.log(`HEAVY_WAIT ${label} ${d.reason}`);
    last = d.reason;
    await deps.clock.sleep(pollMs);
  }
};

export const releaseSlot = (slot: string): void => rmSync(slot, { recursive: true, force: true });

// False only for a confirmed death (no such process, or a zombie). A process of another user (EPERM), or a ps that
// fails or prints nothing, keeps the slot held: an unknown holder is counted, never reclaimed.
export const pidAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (e) {
    return (e as { code?: string } | null)?.code !== "ESRCH";
  }
  let stat = "";
  try {
    stat = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)])
      .stdout.toString()
      .trim();
  } catch {
    return true;
  }
  return !stat.startsWith("Z");
};
