/**
 * Answers on Discord: a message handed to the lead pane is answered there, and the answer is posted back to the
 * channel it came from as a reply to the message that asked.
 *
 * The pane is told where to read the message (its session log, from the offset the message is logged at) so the
 * answer can be found without guessing which assistant text belongs to which message. The answer is read from that
 * log, not the screen, so a long answer arrives whole.
 *
 * The human's messages are answered by the lead pane. A bot post that called Dori is answered in the room by
 * `discord-bot-replies.ts`, with the lead's answer when it has one; other bot chatter is logged and left alone.
 */

import type { SessionRef } from "../../../../../src/runtime/types.ts";
import type { DoriConfig } from "../config.ts";
import { type ChosenRuntimes, run, runtimesOf } from "../run.ts";
import { agentStatus, readScreen, sendVerified, statusLookup } from "../sessions.ts";
import { botAnswerer } from "./discord-bot-replies.ts";
import type { Discord } from "./discord.ts";
import type { Inbound } from "./discord-gateway.ts";
import { lastAnswer, postAnswer, sessionSize } from "./discord-reply.ts";
import { resolveLeadRef, sessionPathFor } from "./discord-pane.ts";
import { note, type Pending, pendingPath, readPending, writePending } from "./discord-answers-state.ts";

const POLL_MS = 1_500;
const MAX_WAIT_MS = 20 * 60 * 1000;
/** Idle reads in a row (one poll apart) before a turn counts as finished. */
const IDLE_READS = 2;

export type ReplyLoop = { readonly stop: () => void };

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);
const clock = { now: () => Date.now(), sleep };

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

const handOff = async (
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

export const startDiscordReplies = (
  discord: Discord,
  stateDir: string,
  config: DoriConfig,
  sessionPath: () => Promise<string | undefined> = () => sessionPathFor(config.sessionsDir, config.defaultCwd),
  rts: ChosenRuntimes = runtimesOf({ run, clock, config }),
  pollMs = POLL_MS,
): ReplyLoop & {
  readonly enqueue: (item: Omit<Pending, "offset">) => Promise<boolean>;
  readonly enqueueBot: (inbound: Inbound) => Promise<boolean>;
} => {
  const path = pendingPath(stateDir);
  // The named pane is looked up again whenever the reply loop needs it: a lane renamed or reopened gets a new address,
  // and the name is what stays the same.
  const target = async (): Promise<SessionRef | undefined> => await resolveLeadRef(config, rts).catch(() => undefined);
  let stopped = false;
  const posted = new Set<string>();

  const enqueue = async (item: Omit<Pending, "offset">): Promise<boolean> => {
    const ref = await target();
    if (!ref) return false;
    // Read before the hand-off: a working pane answers the next prompt in the turn it is already running, so the
    // answer can land before the hand-off returns. A size read after it would start past that answer, and the next
    // answer written for a later message would be posted as this one's.
    const size = sessionSize(item.sessionPath);
    // The status is read through the hand-off's own lookup, so the test double and a real pane agree on where it comes
    // from: a working pane answers inside the turn it is already running, an idle one starts a turn for this message.
    const before = (await statusLookup(rts, ref)).status;
    if (
      !(await handOff(
        rts,
        ref,
        item.sessionPath,
        item.channel,
        item.messageId,
        item.author,
        item.text,
        item.mentions?.length || item.replyToAuthor
          ? {
              ...(item.mentions ? { mentions: item.mentions } : {}),
              ...(item.replyToAuthor ? { replyToAuthor: item.replyToAuthor } : {}),
            }
          : undefined,
      ))
    )
      return false;
    const pending = readPending(path);
    // An idle pane starts a turn for this message, so its first answer is this message's. A working pane answers inside
    // the turn it is already running, and the text it writes there may be for an earlier message: only an answer that
    // lands while the pane is still working, or after it has gone idle, can be told apart from that one.
    const own = before === "idle" ? size : undefined;
    writePending(path, [
      ...pending.filter((p) => p.messageId !== item.messageId),
      { ...item, offset: size, ...(own === undefined ? {} : { ownFrom: own }) },
    ]);
    return true;
  };

  /** The lead's answer to a bot that called Dori: handed over like a human's message, then read from its log. */
  const askLead = async (inbound: Inbound): Promise<string | undefined> => {
    const ref = await target();
    if (!ref) return undefined;
    const sessionLog = await sessionPath();
    if (!sessionLog) return undefined;
    const size = sessionSize(sessionLog);
    if (!(await handOff(rts, ref, sessionLog, inbound.channel, inbound.messageId, inbound.author, inbound.text)))
      return undefined;
    const started = Date.now();
    while (!stopped && Date.now() - started < MAX_WAIT_MS) {
      await sleep(pollMs);
      const text = lastAnswer(sessionLog, size);
      if (text) return text;
    }
    return undefined;
  };

  const enqueueBot = botAnswerer({
    discord,
    stateDir,
    selfId: config.discordSelfId ?? "",
    note: (line) => note(stateDir, line),
    answer: async (inbound) => {
      const answered = await askLead(inbound);
      if (answered) return answered;
      const sessionLog = await sessionPath();
      return sessionLog ? lastAnswer(sessionLog, 0) : undefined;
    },
  });

  const answer = async (item: Pending): Promise<boolean> => {
    const started = Date.now();
    let working = false;
    let idleReads = 0;
    const ref = await target();
    while (!stopped && Date.now() - started < MAX_WAIT_MS) {
      await sleep(pollMs);
      // A pane that is still working is writing this message's answer; one that has gone idle has finished the turn, and
      // its last answer is the one for this message. Without a lead ref there is no pane to read, and only the log counts.
      const status = ref === undefined ? undefined : (await statusLookup(rts, ref)).status;
      // Nothing is posted while the turn runs: the pane writes a line first ("본문 확인하고 바로 답할게"), goes on with
      // its tools, and writes the real answer last. Posting the first line marked the message done, so the answer
      // stayed in the pane and never reached the room. Two idle reads in a row end the turn, so a pane that blinks
      // idle between two tool calls is not taken for done.
      if (status === "working") {
        working = true;
        idleReads = 0;
        continue;
      }
      if (ref !== undefined && status !== undefined && ++idleReads < IDLE_READS) continue;
      const text = lastAnswer(item.sessionPath, item.ownFrom ?? item.offset);
      if (!text) {
        if (working) {
          // Dropped without a word before: the pane finished its turn but no answer was found where it was looked for.
          note(stateDir, `no answer found for ${item.messageId} in ${item.sessionPath}`);
          return true;
        }
        continue;
      }
      // The same answer is never posted twice for one message: a retry after a failed post, or a second pass over the
      // same entry, would put the same words in the room again.
      if (posted.has(item.messageId)) return true;
      try {
        const ids = await postAnswer(discord, item.channel, item.messageId, text);
        posted.add(item.messageId);
        note(stateDir, `posted ${ids.length} message(s) for ${item.messageId}`);
      } catch (e) {
        note(stateDir, `post failed for ${item.messageId}: ${(e as Error).message}`);
      }
      return true;
    }
    return false;
  };

  const loop = async (): Promise<void> => {
    while (!stopped) {
      await sleep(pollMs);
      const pending = readPending(path);
      if (pending.length === 0) continue;
      const keep: Pending[] = [];
      for (const item of pending) {
        if (!(await answer(item))) keep.push(item);
      }
      writePending(path, keep);
    }
  };

  void loop();
  return {
    stop: () => {
      stopped = true;
    },
    enqueue,
    enqueueBot,
  };
};
