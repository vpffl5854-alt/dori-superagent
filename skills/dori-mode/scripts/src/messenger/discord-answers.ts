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
import { statusLookup } from "../sessions.ts";
import { botAnswerer } from "./discord-bot-replies.ts";
import type { Discord } from "./discord.ts";
import type { Inbound } from "./discord-gateway.ts";
import { lastAnswer, postAnswer, sessionSize } from "./discord-reply.ts";
import { resolveLeadRef, sessionPathFor } from "./discord-pane.ts";
import { note, type Pending, pendingPath, readPending, writePending } from "./discord-answers-state.ts";
import { type Batch, batches } from "./discord-answers-batch.ts";
import { handOff, handOffMissed } from "./discord-handoff.ts";

const POLL_MS = 1_500;
const MAX_WAIT_MS = 20 * 60 * 1000;
/** Idle reads in a row (one poll apart) before a turn counts as finished. */
const IDLE_READS = 2;

export type ReplyLoop = { readonly stop: () => void };

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);
const clock = { now: () => Date.now(), sleep };

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
  /** The talk the room had while the gateway was down: shown to the lane once, never answered (no pending entry). */
  readonly remember: (missed: readonly Inbound[]) => Promise<boolean>;
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

  const answerBot = botAnswerer({
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

  /**
   * One turn answers every message handed over while it ran: the batch waits for the turn to end, reads its last
   * answer from where the earliest message's turn began, and posts it once, as a reply to the newest message. Each
   * message read that same answer before, so a burst of four got it four times (2026-11-26).
   */
  const answer = async (b: Batch): Promise<boolean> => {
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
      const text = lastAnswer(b.sessionPath, b.from);
      if (!text) {
        if (working) {
          // Dropped without a word before: the pane finished its turn but no answer was found where it was looked for.
          note(stateDir, `no answer found for ${b.replyTo} in ${b.sessionPath}`);
          return true;
        }
        continue;
      }
      // The same answer is never posted twice for one message: a retry after a failed post, or a second pass over the
      // same entry, would put the same words in the room again.
      if (posted.has(b.replyTo)) return true;
      const others = b.items.map((i) => i.messageId).filter((id) => id !== b.replyTo);
      try {
        const ids = await postAnswer(discord, b.channel, b.replyTo, text);
        for (const i of b.items) posted.add(i.messageId);
        note(
          stateDir,
          `posted ${ids.length} message(s) for ${b.replyTo}${others.length ? ` (with ${others.join(", ")})` : ""}`,
        );
      } catch (e) {
        note(stateDir, `post failed for ${b.replyTo}: ${(e as Error).message}`);
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
      const done = new Set<string>();
      for (const b of batches(pending)) if (await answer(b)) for (const i of b.items) done.add(i.messageId);
      // Read again before writing: a message handed over while this pass waited is in the file, not in `pending`.
      writePending(
        path,
        readPending(path).filter((p) => !done.has(p.messageId)),
      );
    }
  };

  void loop();
  return {
    stop: () => {
      stopped = true;
    },
    enqueue,
    enqueueBot: answerBot,
    remember: async (missed) => {
      const ref = await target();
      const ok = ref !== undefined && (await handOffMissed(rts, ref, missed));
      note(
        stateDir,
        `missed talk (${missed.length} message(s)) ${ok ? "shown to" : "not handed to"} the lane, unanswered`,
      );
      return ok;
    },
  };
};
