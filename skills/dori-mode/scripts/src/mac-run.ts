/**
 * One Mac task on the engine: find the app's window, wait while the owner is using that app (its window is the
 * front one), photo before, press each step by its accessibility name (AXPress; the engine's background click
 * reports "ok" without the press landing), check the expected value, photo after. The stop switch is read before
 * every step.
 */
import type { Engine, Reply } from "./mac-engine.ts";
import { findRef, findWindow, type MacTask, parseStep, shownValues, showsValue, type Win } from "./mac.ts";
import { closesWindow, frameRef, SEVERAL_WINDOWS_NOTE, severalWindows } from "./mac-frame.ts";

export type RunOpts = {
  readonly stopped: () => boolean;
  readonly sleep: (ms: number) => Promise<void>;
  /** How long one wait for the owner lasts, and how many waits a task may spend before it gives up. */
  readonly waitMs: number;
  readonly maxWaits: number;
  readonly photos: boolean;
  /** How long since the owner last touched the keyboard or mouse; unset, the owner counts as always there. */
  readonly ownerIdleMs?: () => number;
};

/** An app can put itself in front (TextEdit's open panel does): the owner is using it only with recent input. */
export const OWNER_IDLE_MS = 60_000;
export const ownerUsing = (w: Win | undefined, o: Pick<RunOpts, "ownerIdleMs">): boolean =>
  Boolean(w?.focused) && (o.ownerIdleMs?.() ?? 0) < OWNER_IDLE_MS;

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
    findWindow(((await e.call("windows")).result as Win[] | undefined) ?? [], t.app, t.window);
  /** Waits while the owner's front window is the target's; false once the waits are spent. */
  const ownerAway = async (): Promise<boolean> => {
    for (;;) {
      const w = await windowNow();
      if (!ownerUsing(w, o)) return true;
      if (waited >= o.maxWaits) return false;
      waited++;
      await o.sleep(o.waitMs);
    }
  };
  let w = await windowNow();
  if (!w)
    return done(
      false,
      `${t.app} 창을 못 찾았어요 (열린 창이 하나도 없으면 단축키·메뉴도 못 보내요: 앱을 다시 열고, 열기 창이 뜨면 그 안의 버튼을 쓰세요)`,
    );
  if (!(await ownerAway())) return done(false, `지브가 ${t.app}을(를) 쓰는 중이라 멈췄어요`, [], w.id);
  if (o.photos) before = await photo(e, w.id);
  for (const step of t.steps) {
    if (o.stopped()) return done(false, `도리방 "멈춰"로 멈췄어요 (${step} 전에)`, [], w.id);
    if (!(await ownerAway())) return done(false, `지브가 ${t.app}을(를) 쓰는 중이라 멈췄어요`, [], w.id);
    // A menu or shortcut may have opened a new window of the app: each step works in the app's current window.
    w = (await windowNow()) ?? w;
    const st = parseStep(step);
    const ref =
      st.kind === "press" ? (findRef(await snapshotOf(e, w.id), step) ?? (await frameRef(e, w.id, step))) : undefined;
    if (st.kind === "press" && !ref) return done(false, `"${step}" 버튼을 못 찾았어요`, [], w.id);
    for (;;) {
      const r =
        st.kind === "menu"
          ? await e.call("menus.select", { windowId: w.id, path: st.path })
          : st.kind === "key"
            ? await e.call("keyChord", { target: w.id, keys: st.keys })
            : await e.call("ax.perform", { ref, action: "AXPress" });
      if (!r.error) break;
      if (severalWindows(r)) {
        // The window's own close button lands where a chord or a menu cannot (see mac-frame.ts).
        const close = closesWindow(st) ? await frameRef(e, w.id, "창 닫기") : undefined;
        if (close && !(await e.call("ax.perform", { ref: close, action: "AXPress" })).error) break;
        return done(false, `"${step}" 못 했어요: ${SEVERAL_WINDOWS_NOTE}`, [], w.id);
      }
      if (!heldForOwner(r) || waited >= o.maxWaits)
        return done(
          false,
          `"${step}" 못 했어요: ${
            (r.error.data as { reason?: string } | undefined)?.reason === "occluded"
              ? "다른 것에 가려졌다며 엔진이 안 눌렀어요. 같은 걸 다시 누르지 말고 앱의 검색·단축키로 가세요"
              : r.error.message
          }`,
          [],
          w.id,
        );
      waited++;
      await o.sleep(o.waitMs);
    }
    // A menu or a shortcut can open a window or a sheet: the next step reads the screen after it has settled.
    if (st.kind !== "press") await o.sleep(Math.min(o.waitMs, 800));
  }
  const after = await snapshotOf(e, w.id);
  const ok = t.expect === undefined || showsValue(after, t.expect);
  return done(ok, ok ? "" : "결과가 기대와 달라요", shownValues(after), w.id);
};
