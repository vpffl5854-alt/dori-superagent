/**
 * 도리방 quick Mac commands that need no model: "맥 화면 보여줘", "맥 볼륨 30", "맥 소리 줄여", "맥 음소거",
 * "맥 사파리 열어". They run in 맥손 like any Mac task (the screen capture needs Herdr's grant) and answer in seconds.
 * Anything else goes to the head (mac-do.ts).
 */
export type Quick =
  | { readonly kind: "screen" }
  | { readonly kind: "volume"; readonly set?: number; readonly by?: number }
  | { readonly kind: "mute"; readonly on: boolean }
  | { readonly kind: "open"; readonly app: string };

const STEP = 15;

export const parseQuick = (goal: string): Quick | undefined => {
  const g = goal
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!?~]+$/u, "");
  if (/(화면|스크린샷|스샷|캡처)/.test(g) && /(보여|찍어|캡처|스샷|보내)/.test(g)) return { kind: "screen" };
  if (/음소거\s*(해제|풀어|꺼)/.test(g)) return { kind: "mute", on: false };
  if (/음소거|소리\s*(꺼|끄)/.test(g)) return { kind: "mute", on: true };
  if (/(볼륨|소리|음량)/.test(g)) {
    const n = /(\d{1,3})\s*%?/.exec(g)?.[1];
    if (n !== undefined) return { kind: "volume", set: Math.min(100, Number(n)) };
    if (/(올려|키워|크게|높여)/.test(g)) return { kind: "volume", by: STEP };
    if (/(내려|줄여|작게|낮춰)/.test(g)) return { kind: "volume", by: -STEP };
    return undefined;
  }
  const open = /^(.{1,30}?)\s*(?:앱|어플)?\s*(?:을|를)?\s*(?:열어|켜|실행해)\s*(?:줘|주세요)?$/u.exec(g);
  if (open?.[1] && !/[,.]|하고|에서/.test(open[1])) return { kind: "open", app: open[1].trim() };
  return undefined;
};

/** The AppleScript for a volume or mute change; StandardAdditions, so no automation grant is asked for. */
export const volumeScript = (q: Extract<Quick, { kind: "volume" | "mute" }>, current: number): string =>
  q.kind === "mute"
    ? `set volume output muted ${q.on}`
    : `set volume output volume ${Math.max(0, Math.min(100, q.set ?? current + (q.by ?? 0)))}`;
