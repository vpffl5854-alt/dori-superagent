/**
 * 도리방 quick Mac commands that need no model: "맥 화면 보여줘", "맥 볼륨 30", "맥 소리 줄여", "맥 음소거",
 * "맥 사파리 열어". They run in 맥손 like any Mac task (the screen capture needs Herdr's grant) and answer in seconds.
 * Anything else goes to the head (mac-do.ts).
 */
export type Quick =
  | { readonly kind: "screen" }
  | { readonly kind: "explain"; readonly question: string }
  | { readonly kind: "volume"; readonly set?: number; readonly by?: number }
  | { readonly kind: "mute"; readonly on: boolean }
  | { readonly kind: "open"; readonly app: string };

const STEP = 15;

export const parseQuick = (goal: string): Quick | undefined => {
  const g = goal
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!?~]+$/u, "");
  // "화면에 뭐 떠 있어?", "이 에러 뭐야?": the screen photo goes to a model that reads pictures, with the question.
  if (/(화면|창|에러|오류|경고|팝업)/.test(g) && /(뭐|무슨|무엇|설명|알려|읽어|왜|어떻게)/.test(g))
    return { kind: "explain", question: g };
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

export const explainPrompt = (question: string): string =>
  [
    "이 사진은 지금 지브의 맥 화면이다. 지브의 질문에 한국어로, 쉬운 말로, 3~6줄로 답한다.",
    `질문: ${question}`,
    "에러나 경고 창이면: 무슨 뜻인지, 왜 떴을 것 같은지, 지브가 누르면 되는 버튼이나 할 일을 말한다.",
    "권한·암호 창이면 무엇을 허락하는 창인지 말하고, 허용 여부는 지브가 정하게 둔다.",
    "화면에 비밀번호·키·토큰처럼 보이는 글이 있으면 그대로 옮겨 적지 않는다.",
  ].join("\n");
