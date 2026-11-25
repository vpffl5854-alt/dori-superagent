/**
 * A window's own buttons: close, minimize and zoom at its top-left carry no name in the accessibility tree, so they
 * are named here ("창 닫기", "창 최소화", "창 확대") and found by place: the top row of small unnamed buttons, left to
 * right. When an app has several windows the engine sends no key chord or menu command to a window behind (it would
 * land in the app's key window), but a press on the window's own button does land: so "cmd+w" or a 닫기 menu falls
 * back to "창 닫기".
 */
import type { Engine, Reply } from "./mac-engine.ts";
import type { Step } from "./mac.ts";

export const FRAME_BUTTONS = ["창 닫기", "창 최소화", "창 확대"] as const;

type Node = {
  readonly ref: string;
  readonly title: string | null;
  readonly description: string | null;
  readonly x: number;
  readonly y: number;
  readonly width: number;
};

/** The ref of one of the window's own buttons, from a fresh reading of the window. */
export const frameRef = async (e: Engine, windowId: string, name: string): Promise<string | undefined> => {
  const i = FRAME_BUTTONS.indexOf(name as (typeof FRAME_BUTTONS)[number]);
  if (i < 0) return undefined;
  const nodes = ((await e.call("ax.query", { target: windowId, query: { role: "button" } })).result as Node[]) ?? [];
  const small = nodes.filter((n) => !n.title && !n.description && n.width <= 24);
  const top = Math.min(...small.map((n) => n.y));
  return small.filter((n) => n.y - top <= 4).sort((a, b) => a.x - b.x)[i]?.ref;
};

/** The engine refused a chord or a menu because the app has several windows (nothing was sent). */
export const severalWindows = (r: Reply): boolean =>
  (r.error?.data as { code?: string } | undefined)?.code === "BackgroundUnavailable" ||
  /several windows|is one of \d+ windows/.test(r.error?.message ?? "");

/** A chord or a menu item that closes the window: it can be done with the window's own close button instead. */
export const closesWindow = (st: Step): boolean =>
  st.kind === "key"
    ? st.keys.join("+") === "cmd+w"
    : st.kind === "menu" && /^(닫기|close)$/i.test(st.path.at(-1) ?? "");

export const SEVERAL_WINDOWS_NOTE =
  "이 앱은 창이 여러 개라 뒤에 있는 창에는 단축키·메뉴가 안 먹어요. 창 안 버튼(이름이나 ref)이나 '창 닫기'·'창 최소화'를 쓰세요";
