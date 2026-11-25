/**
 * One Mac task on the engine: find the app's window, wait while the owner is using that app (its window is the
 * front one), photo before, press each step by its accessibility name (AXPress; the engine's background click
 * reports "ok" without the press landing), check the expected value, photo after. The stop switch is read before
 * every step.
 */
import type { Engine, Reply } from "./mac-engine.ts";
import { findRef, findWindow, type MacTask, shownValues, showsValue, type Win } from "./mac.ts";

export type RunOpts = {
  readonly stopped: () => boolean;
  readonly sleep: (ms: number) => Promise<void>;
  /** How long one wait for the owner lasts, and how many waits a task may spend before it gives up. */
  readonly waitMs: number;
  readonly maxWaits: number;
  readonly photos: boolean;
};

export type RunResult = {
  readonly ok: boolean;
  readonly shown: string[];
  readonly note: string;
  readonly before?: Uint8Array<ArrayBuffer>;
  readonly after?: Uint8Array<ArrayBuffer>;
  /** How many times the task waited for the owner. */
  readonly waited: number;
};

const snapshotOf = async (e: Engine, target: string): Promise<string> =>
  ((await e.call("ax.snapshot", { target, opts: { all: true, maxNodes: 3000 } })).result as { text?: string })?.text ??
  "";

const photo = async (e: Engine, target: string): Promise<Uint8Array<ArrayBuffer> | undefined> => {
  const r = (await e.call("capture", { target, caps: { maxWidth: 900, maxBytes: 2_000_000 } })).result as
    | { data?: string | null }
    | undefined;
  return r?.data ? new Uint8Array(Buffer.from(r.data, "base64")) : undefined;
};

/** The engine held the input back for the owner: try again after a wait. */
const heldForOwner = (r: Reply): boolean => {
  const d = r.error?.data as { code?: string; disposition?: { delivery?: string; retry?: string } } | undefined;
  return (
    d?.code === "Suspended" || (d?.disposition?.delivery === "not_delivered" && d.disposition.retry === "after_user")
  );
};

export const runTask = async (e: Engine, t: MacTask, o: RunOpts): Promise<RunResult> => {
  let waited = 0;
  let before: Uint8Array<ArrayBuffer> | undefined;
  const done = async (ok: boolean, note: string, shown: string[] = [], target?: string): Promise<RunResult> => {
    const after = o.photos && target ? await photo(e, target) : undefined;
    return { ok, note, shown, waited, ...(before ? { before } : {}), ...(after ? { after } : {}) };
  };
  const windowNow = async (): Promise<Win | undefined> =>
    findWindow(((await e.call("windows")).result as Win[] | undefined) ?? [], t.app);
  /** Waits while the owner's front window is the target's; false once the waits are spent. */
  const ownerAway = async (): Promise<boolean> => {
    for (;;) {
      const w = await windowNow();
      if (!w?.focused) return true;
      if (waited >= o.maxWaits) return false;
      waited++;
      await o.sleep(o.waitMs);
    }
  };
  const w = await windowNow();
  if (!w) return done(false, `${t.app} 창을 못 찾았어요`);
  if (!(await ownerAway())) return done(false, `지브가 ${t.app}을(를) 쓰는 중이라 멈췄어요`, [], w.id);
  if (o.photos) before = await photo(e, w.id);
  for (const step of t.steps) {
    if (o.stopped()) return done(false, `도리방 "멈춰"로 멈췄어요 (${step} 전에)`, [], w.id);
    if (!(await ownerAway())) return done(false, `지브가 ${t.app}을(를) 쓰는 중이라 멈췄어요`, [], w.id);
    const ref = findRef(await snapshotOf(e, w.id), step);
    if (!ref) return done(false, `"${step}" 버튼을 못 찾았어요`, [], w.id);
    for (;;) {
      const r = await e.call("ax.perform", { ref, action: "AXPress" });
      if (!r.error) break;
      if (!heldForOwner(r) || waited >= o.maxWaits)
        return done(false, `"${step}" 못 눌렀어요: ${r.error.message}`, [], w.id);
      waited++;
      await o.sleep(o.waitMs);
    }
  }
  const after = await snapshotOf(e, w.id);
  const ok = t.expect === undefined || showsValue(after, t.expect);
  return done(ok, ok ? "" : "결과가 기대와 달라요", shownValues(after), w.id);
};
