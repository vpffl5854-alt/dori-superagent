/**
 * Doing one action the head chose, and showing it the menu bar. A press, a menu or a key chord goes through runTask,
 * so the stop switch, the owner-in-front wait and the danger hold apply to each of them alike.
 */
import type { Act } from "./mac-brain.ts";
import {
  dangerousSteps,
  findRef,
  isConsentApp,
  findWindow,
  keyStep,
  type MacTask,
  menuStep,
  nameOf,
  type Win,
} from "./mac.ts";
import type { Engine } from "./mac-engine.ts";
import { ownerUsing, type RunOpts, runTask } from "./mac-run.ts";

type MenuItem = {
  readonly title: string;
  readonly path: string[];
  readonly enabled: boolean;
  readonly hasSubmenu: boolean;
  readonly shortcut?: string | null;
};

/** The app's menu bar as text, one line per menu ("파일 > 신규(Cmd+N), 닫기[x], …"); Apple's own menu is left out. */
export const menuView = async (e: Engine, windowId: string): Promise<string> => {
  const items = async (path: string[]): Promise<MenuItem[]> =>
    ((await e.call("menus.items", { windowId, path })).result as MenuItem[] | undefined) ?? [];
  const lines: string[] = [];
  for (const top of (await items([])).slice(1, 9)) {
    const sub = (await items(top.path))
      .filter((m) => m.title.trim())
      .slice(0, 25)
      .map(
        (m) => `${m.title}${m.shortcut ? `(${m.shortcut})` : ""}${m.hasSubmenu ? "▸" : ""}${m.enabled ? "" : "[x]"}`,
      );
    if (sub.length) lines.push(`${top.title} > ${sub.join(", ")}`);
  }
  return lines.join("\n");
};

export type ActCtx = RunOpts & {
  readonly openApp: (app: string) => Promise<void>;
  readonly hold: (task: MacTask) => Promise<void>;
  /** The windows and the reading of the app the model was shown this turn. */
  readonly wins: readonly Win[];
  readonly shown?: Win;
  readonly snapshot: string;
  readonly windows: () => Promise<Win[]>;
};
/** What an action came to; `end` stops the whole task (held for 도리방, the owner in front, the stop switch). */
export type ActResult = {
  readonly ok: boolean;
  readonly result: string;
  readonly step?: string;
  readonly end?: { text: string; held: boolean };
};

export const doAct = async (e: Engine, act: Exclude<Act, { do: "done" | "fail" }>, c: ActCtx): Promise<ActResult> => {
  if (act.do === "open") {
    await c.openApp(act.app);
    // An app started cold can take seconds to show its first window (TextEdit's open panel does).
    let ok = false;
    for (let i = 0; i < 8 && !ok; i++) {
      await c.sleep(1_500);
      ok = Boolean(findWindow(await c.windows(), act.app));
    }
    return { ok, result: ok ? "열었음" : "창이 안 보임" };
  }
  if (act.do === "look") {
    const w = findWindow(c.wins, act.app, act.window);
    const ok = Boolean(w) && (!act.window || w?.title.normalize("NFC").trim() === act.window.normalize("NFC").trim());
    return { ok, result: ok ? "봤음" : w ? `"${act.window}" 창이 없음` : "그 앱 창이 없음" };
  }
  if (act.do === "type") {
    const tw = findWindow(c.wins, act.app, c.shown?.title);
    // Refs belong to one reading of the screen: the model's ref is looked up in the snapshot it was shown.
    const snap = tw && tw.id === c.shown?.id ? c.snapshot : "";
    const ref = findRef(snap, act.field);
    // The owner's own writing is never typed over: a field that already shows text is refused, whatever the model says.
    const filled = ref ? new RegExp(`\\[ref=${ref}\\][^\\n]*: "[^"]+`).test(snap) : false;
    const r = ref && !filled ? await e.call("ax.typeText", { ref, text: act.text }) : undefined;
    const ok = Boolean(r && !r.error);
    const result = ok
      ? "입력함"
      : filled
        ? "이미 글이 있는 칸이라 안 건드림"
        : ref
          ? `입력 못 함: ${r?.error?.message}`
          : `"${act.field}" 칸을 못 찾음`;
    return { ok, result };
  }
  // A ref is judged by the name its control carries, so a ref cannot slip past the danger check.
  const step =
    act.do === "menu"
      ? menuStep(act.path)
      : act.do === "key"
        ? keyStep(act.keys)
        : /^e\d+$/.test(act.step)
          ? (nameOf(c.snapshot, act.step) ?? act.step)
          : act.step;
  if (dangerousSteps([step]).length || isConsentApp(act.app)) {
    await c.hold({ app: act.app, steps: [step] });
    return {
      ok: false,
      result: "승인 대기",
      end: { text: `"${step}"은(는) 되돌리기 어려운 동작이라 도리방 승인을 기다려요`, held: true },
    };
  }
  // A control with no name is pressed right away by the ref the model saw (refs change with every reading).
  if (/^e\d+$/.test(step)) {
    if (c.shown?.app !== findWindow(c.wins, act.app)?.app)
      return { ok: false, result: `"${step}"는 지금 보는 앱의 것이 아니에요` };
    if (ownerUsing(c.shown, c))
      return { ok: false, result: "", end: { text: `지브가 ${act.app}을(를) 쓰는 중이라 멈췄어요`, held: false } };
    if (c.stopped()) return { ok: false, result: "", end: { text: '도리방 "멈춰"로 멈췄어요', held: false } };
    const r = await e.call("ax.perform", { ref: step, action: "AXPress" });
    return r.error
      ? { ok: false, result: `"${step}" 못 눌렀어요: ${r.error.message}` }
      : { ok: true, result: "눌렀음" };
  }
  const window = c.shown && c.shown.app === findWindow(c.wins, act.app)?.app ? c.shown.title : undefined;
  const r = await runTask(e, { app: act.app, steps: [step], ...(window ? { window } : {}) }, { ...c, photos: false });
  if (!r.ok && (r.note.includes("쓰는 중") || r.note.includes("멈춰")))
    return { ok: false, result: "", end: { text: r.note, held: false } };
  const shown = r.shown.length ? `, 보이는 값: ${r.shown.slice(0, 3).join(", ")}` : "";
  return r.ok
    ? { ok: true, result: `${act.do === "press" ? "눌렀음" : "했음"}${shown}`, step }
    : { ok: false, result: r.note };
};
