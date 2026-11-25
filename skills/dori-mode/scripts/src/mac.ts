/**
 * 슈퍼도리 컴퓨터 유즈, the pure part: a step is a control's name (alternatives split by `|`, since a control's name
 * changes with its state: AC "모두 지우기" becomes C "지우기"), found in the engine's accessibility snapshot. A step
 * whose name pays, deletes, sends or posts is dangerous and waits for the owner's button press in 도리방.
 */

export type MacTask = { readonly app: string; readonly steps: readonly string[]; readonly expect?: string };

/** Words on a control whose press cannot be taken back. "지우기" (clear) is not one: it only clears a field. */
const DANGER =
  /결제|구매|주문|송금|이체|삭제|휴지통|보내기|전송|게시|공유|업로드|탈퇴|해지|\b(pay|buy|purchase|order|delete|remove|trash|send|post|publish|submit|share|upload)\b/i;

export const dangerousSteps = (steps: readonly string[]): string[] => steps.filter((s) => DANGER.test(s));

/** "6, 곱하기 ,7" -> ["6", "곱하기", "7"]. */
export const parseSteps = (text: string): string[] =>
  text
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const reEscape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The ref of the first control named like the step (any alternative), buttons before other roles. */
export const findRef = (snapshot: string, step: string): string | undefined => {
  const names = step.split("|").map((n) => n.trim());
  for (const role of ["button", "[a-z]+"])
    for (const n of names) {
      const m = new RegExp(`^\\s*- ${role} "${reEscape(n)}" \\[ref=(e\\d+)\\]`, "m").exec(snapshot);
      if (m?.[1]) return m[1];
    }
  return undefined;
};

/** Whether some control in the snapshot shows the expected value (`…: "42"`). */
export const showsValue = (snapshot: string, value: string): boolean =>
  new RegExp(`: "${reEscape(value)}"`).test(snapshot);

/** The values the snapshot's text fields show, for the report line. */
export const shownValues = (snapshot: string): string[] =>
  [...snapshot.matchAll(/- (?:statictext|textfield|textarea)[^\n]*?: "([^"\n]*)"/g)].map((m) => m[1] ?? "");

export type Win = { readonly id: string; readonly app: string; readonly title: string; readonly focused: boolean };

/** The app's window; an app name matches its Korean or English name loosely ("계산기" or "Calculator"). */
export const findWindow = (wins: readonly Win[], app: string): Win | undefined => {
  const a = app.toLowerCase();
  return wins.find((w) => w.app.toLowerCase() === a) ?? wins.find((w) => w.app.toLowerCase().includes(a));
};

/** 도리방 words for the stop switch: "멈춰" stops every Mac action, "재개" lets them run again. */
export const stopWord = (text: string): "stop" | "resume" | undefined => {
  const t = text.trim().replace(/[!.~\s]+$/u, "");
  return t === "멈춰" ? "stop" : t === "재개" ? "resume" : undefined;
};

export type MacPress = { readonly action: "go" | "drop"; readonly id: string };
export const macCallback = (action: MacPress["action"], id: string): string => `mac:${action}:${id}`;
export const parseMacPress = (data: string | undefined): MacPress | undefined => {
  const m = /^mac:(go|drop):([A-Za-z0-9-]+)$/.exec(data ?? "");
  return m?.[1] && m[2] ? { action: m[1] as MacPress["action"], id: m[2] } : undefined;
};

export const approvalText = (id: string, t: MacTask, danger: readonly string[]): string =>
  [
    `맥 조작 승인 필요 (${id})`,
    `앱: ${t.app}`,
    `누를 순서: ${t.steps.join(" → ")}`,
    `되돌릴 수 없는 버튼: ${danger.join(", ")}`,
  ].join("\n");

export const reportText = (t: MacTask, ok: boolean, shown: readonly string[], note = ""): string =>
  [
    `${ok ? "맥 작업 끝" : "맥 작업 실패"}: ${t.app}`,
    `누른 순서: ${t.steps.join(" → ")}`,
    ...(t.expect ? [`기대한 값: ${t.expect} → ${ok ? "맞음" : "다름"}`] : []),
    ...(shown.length ? [`지금 보이는 값: ${shown.slice(0, 3).join(", ")}`] : []),
    ...(note ? [note] : []),
  ].join("\n");

/** The self-test: 6 × 7 on Calculator must read 42. */
export const SELFTEST: MacTask = {
  app: "계산기",
  steps: ["모두 지우기|지우기|AC|C", "6", "곱하기|Multiply", "7", "등호|Equals"],
  expect: "42",
};
