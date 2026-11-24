/**
 * 도리방: the owner's own Telegram chat with Dori (a bot of its own, apart from the cat bot). A backlog item waiting
 * for the owner's yes comes with buttons; a press is one of three answers, and only the owner's presses count.
 * Text the owner types goes to the lead's inbox, so the chat is also a way to give the lead work.
 */

export type Action = "go" | "hold" | "drop";
export type Press = { readonly action: Action; readonly id: string };

const LABELS: Readonly<Record<Action, string>> = { go: "진행", hold: "보류", drop: "버리기" };
/** Telegram's limit for callback_data is 64 bytes; a backlog id longer than this cannot be a button. */
const DATA_MAX = 64;
const ID = /^[A-Za-z0-9._-]+$/;

export const callbackData = (action: Action, id: string): string => `bl:${action}:${id}`;

export const parsePress = (data: string | undefined): Press | undefined => {
  const m = /^bl:(go|hold|drop):(.+)$/.exec(data ?? "");
  return m?.[1] && m[2] && ID.test(m[2]) ? { action: m[1] as Action, id: m[2] } : undefined;
};

export type Approval = { readonly id: string; readonly label: string };

/** One row per item: its label on a button that does nothing, then 진행 · 보류 · 버리기. */
export const approvalKeyboard = (
  items: readonly Approval[],
): { inline_keyboard: { text: string; callback_data: string }[][] } => ({
  inline_keyboard: items
    .filter((i) => ID.test(i.id) && callbackData("hold", i.id).length <= DATA_MAX)
    .map((i) =>
      (["go", "hold", "drop"] as const).map((a) => ({
        text: `${LABELS[a]} ${i.label}`,
        callback_data: callbackData(a, i.id),
      })),
    ),
});

/** What the lead is told for a press: only 진행 is work for the lead; 버리기 drops the item itself, 보류 tells nobody. */
export const leadText = (p: Press): string | undefined =>
  p.action === "go"
    ? `[도리방] 지브가 버튼으로 승인했어: backlog ${p.id} 진행해. 끝나면 도리방에 한 줄로 알려줘.`
    : undefined;

/** The short answer shown on the owner's phone right after the press. */
export const pressAnswer = (p: Press, ok: boolean): string =>
  !ok
    ? `${p.id}: 처리 못 했어요. 다시 눌러 주세요`
    : `${p.id}: ${LABELS[p.action]}${p.action === "go" ? " — 리드에게 넘겼어요" : ""}`;

/** The lead's inbox line for text the owner typed in 도리방, with how to answer there. */
export const forwardText = (text: string, replyArgv: readonly string[]): string =>
  [`[도리방] 지브: ${text}`, `답은 도리방으로 보내: ${replyArgv.join(" ")} "<답>"`].join("\n");
