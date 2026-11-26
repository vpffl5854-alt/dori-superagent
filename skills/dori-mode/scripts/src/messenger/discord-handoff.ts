/**
 * Putting room text into the lane's pane (discord-answers.ts): a message to answer, or the talk the room had while
 * Dori was not listening, which the lane reads for the flow and does not answer.
 */
import type { SessionRef } from "../../../../../src/runtime/types.ts";
import type { runtimesOf } from "../run.ts";
import { agentStatus, readScreen, sendVerified } from "../sessions.ts";
import type { Inbound } from "./discord-gateway.ts";

const clock = { now: () => Date.now(), sleep: (ms: number): Promise<void> => Bun.sleep(ms) };

/** True when the pane's input box already holds unsent text: typing then would append to it, not send. */
const draftPresent = async (rts: ReturnType<typeof runtimesOf>, ref: SessionRef): Promise<boolean> => {
  let screen: string;
  try {
    screen = await readScreen(rts, ref, 40);
  } catch {
    return true;
  }
  const lines = screen.split("\n").map((line) => line.replace(/\s+$/, ""));
  const at = lines.findLastIndex((line) => line.trimStart().startsWith("❯"));
  if (at < 0) return false;
  const box = lines.slice(at + 1);
  const end = box.findIndex((line) => /^[─━]{10,}/.test(line.trim()));
  return box.slice(0, end < 0 ? box.length : end).some((line) => line.trim() !== "");
};

/**
 * Room text is typed into the pane, and the pane refuses a backtick or `$(` (typed into a bare shell they would run).
 * A message carrying either never reached the lane and was dropped without a word (11/23–11/25, mostly bot posts that
 * quote code). The lane only reads the text, so look-alikes keep it readable: ˋcodeˋ, $ (…).
 */
export const forPane = (text: string): string => text.replace(/`/g, "ˋ").replace(/\$\(/g, "$ (");

export const handOff = async (
  rts: ReturnType<typeof runtimesOf>,
  ref: SessionRef,
  sessionPath: string,
  channel: string,
  messageId: string,
  author?: string,
  text?: string,
  signal?: { readonly mentions?: readonly string[]; readonly replyToAuthor?: string },
): Promise<boolean> => {
  const status = await agentStatus(rts, ref);
  if (status === undefined || status === "shell" || status === "gone") return false;
  if (await draftPresent(rts, ref)) return false;
  const body = text?.trim() ? `\n본문: ${forPane(text.trim())}` : `\n원문은 위 세션기록에서 읽으세요: ${sessionPath}`;
  // The lane answers differently depending on how the message reached it: a reply or a mention is a direct call to
  // answer, plain room text is not. The distinction is carried here, not inferred from the text body, so a mention
  // that names the bot by its display name still reads as a call.
  const signalLine = signal?.replyToAuthor
    ? `\n형식: 답장(${JSON.stringify(signal.replyToAuthor)}의 글에 대한 답장)`
    : signal?.mentions?.length
      ? `\n형식: 맨션(${signal.mentions.join(", ")}을 맨션)`
      : "\n형식: 방 잡담(직접 호출 아님)";
  const prompt =
    `디코 수신 · 채널=${channel} msg=${messageId}${author === undefined ? "" : ` [수신 | ${forPane(author)}]`}${body}${forPane(signalLine)}\n` +
    "이 메시지에 답하면 그 답이 디코로 올라갑니다. 답은 이 메시지에 대한 답 하나로만 쓰세요.";
  return (await sendVerified(rts, clock, ref, prompt)) !== "failed";
};

/** How much of each missed message the lane is shown: enough to follow the talk, not a wall to answer. */
const MISSED_LINE = 200;

export const missedPrompt = (missed: readonly Inbound[]): string =>
  [
    `디코 수신 · 놓친 대화 (연결이 끊긴 동안 채널=${missed[0]?.channel ?? "?"}에 올라온 글 ${missed.length}개, 오래된 것부터)`,
    ...missed.map(
      (m) => `- ${forPane(m.author)}: ${forPane(m.text.replace(/\s+/g, " ").trim().slice(0, MISSED_LINE))}`,
    ),
    "이건 지난 대화라 답해도 디코로 올라가지 않습니다. 답하지 말고 흐름만 알아 두세요. 필요하면 지브가 다시 부릅니다.",
  ].join("\n");

/** The missed talk goes to the pane once, as context: none of it is waiting for an answer. */
export const handOffMissed = async (
  rts: ReturnType<typeof runtimesOf>,
  ref: SessionRef,
  missed: readonly Inbound[],
): Promise<boolean> => {
  if (missed.length === 0) return true;
  const status = await agentStatus(rts, ref);
  if (status === undefined || status === "shell" || status === "gone") return false;
  if (await draftPresent(rts, ref)) return false;
  return (await sendVerified(rts, clock, ref, missedPrompt(missed))) !== "failed";
};
