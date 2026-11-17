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
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { SessionRef } from "../../../../../src/runtime/types.ts";
import type { DoriConfig } from "../config.ts";
import { type ChosenRuntimes, run, runtimesOf } from "../run.ts";
import { agentStatus, readScreen, sendVerified, statusLookup } from "../sessions.ts";
import { botAnswerer } from "./discord-bot-replies.ts";
import type { Discord } from "./discord.ts";
import type { Inbound } from "./discord-gateway.ts";
import { lastAnswer, postAnswer, sessionSize } from "./discord-reply.ts";
import { newestSessionLog } from "./session-log.ts";

const POLL_MS = 1_500;
const MAX_WAIT_MS = 20 * 60 * 1000;

type Pending = {
  channel: string;
  messageId: string;
  sessionPath: string;
  offset: number;
  /** Where this message's own turn started, when the pane was idle at the hand-off: an answer before it is not this one's. */
  ownFrom?: number;
};

export type ReplyLoop = { readonly stop: () => void };

const pendingPath = (stateDir: string): string => join(stateDir, "discord-reply-pending.json");
const logPath = (stateDir: string): string => join(stateDir, "discord-replies.log");

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);
const clock = { now: () => Date.now(), sleep };

const readPending = (path: string): Pending[] => {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return Array.isArray(parsed) ? (parsed as Pending[]) : [];
  } catch {
    return [];
  }
};

const writePending = (path: string, pending: readonly Pending[]): void => {
  try {
    writeFileSync(path, JSON.stringify(pending, null, 1));
  } catch {}
};

const note = (stateDir: string, line: string): void => {
  try {
    appendFileSync(logPath(stateDir), `[${new Date().toISOString()}] ${line}\n`);
  } catch {}
};

/** The lead pane the config names (`hc:t1t`, `herdr:w1:p3`), or undefined when it names none. */
const leadRef = (config: Pick<DoriConfig, "leadPane">): SessionRef | undefined => {
  const raw = config.leadPane.trim();
  if (!raw) return undefined;
  const [kind, ...rest] = raw.split(":");
  const id = rest.join(":");
  if (!id) return undefined;
  if (kind === "hc") return { runtime: "hc", id };
  if (kind === "herdr") return { runtime: "herdr", id };
  return undefined;
};

/** The session log the pane's agent writes: the newest file for the pane's working directory. */
export const sessionPathFor = (sessionsDir: string, cwd: string): Promise<string | undefined> =>
  newestSessionLog(run, sessionsDir, cwd);

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

const handOff = async (
  rts: ReturnType<typeof runtimesOf>,
  ref: SessionRef,
  sessionPath: string,
  channel: string,
  messageId: string,
): Promise<boolean> => {
  const status = await agentStatus(rts, ref);
  if (status === undefined || status === "shell" || status === "gone") return false;
  if (await draftPresent(rts, ref)) return false;
  const prompt =
    `디코 수신 · 채널=${channel} msg=${messageId} · 세션기록=${sessionPath}\n` +
    "이 메시지에 답하면 그 답이 디코로 올라갑니다. 답은 이 메시지에 대한 답 하나로만 쓰고, 원문은 위 세션기록에서 읽으세요.";
  return (await sendVerified(rts, clock, ref, prompt)) !== "failed";
};

export const startDiscordReplies = (
  discord: Discord,
  stateDir: string,
  config: DoriConfig,
  sessionPath: () => Promise<string | undefined> = () => sessionPathFor(config.sessionsDir, config.defaultCwd),
  rts: ChosenRuntimes = runtimesOf({ run, clock, config }),
): ReplyLoop & {
  readonly enqueue: (item: Omit<Pending, "offset">) => Promise<boolean>;
  readonly enqueueBot: (inbound: Inbound) => Promise<boolean>;
} => {
  const path = pendingPath(stateDir);
  const ref = leadRef(config);
  let stopped = false;
  const posted = new Set<string>();

  const enqueue = async (item: Omit<Pending, "offset">): Promise<boolean> => {
    if (!ref) return false;
    // Read before the hand-off: a working pane answers the next prompt in the turn it is already running, so the
    // answer can land before the hand-off returns. A size read after it would start past that answer, and the next
    // answer written for a later message would be posted as this one's.
    const size = sessionSize(item.sessionPath);
    // The status is read through the hand-off's own lookup, so the test double and a real pane agree on where it comes
    // from: a working pane answers inside the turn it is already running, an idle one starts a turn for this message.
    const before = (await statusLookup(rts, ref)).status;
    if (!(await handOff(rts, ref, item.sessionPath, item.channel, item.messageId))) return false;
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
    if (!ref) return undefined;
    const sessionLog = await sessionPath();
    if (!sessionLog) return undefined;
    const size = sessionSize(sessionLog);
    if (!(await handOff(rts, ref, sessionLog, inbound.channel, inbound.messageId))) return undefined;
    const started = Date.now();
    while (!stopped && Date.now() - started < MAX_WAIT_MS) {
      await sleep(POLL_MS);
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
    while (!stopped && Date.now() - started < MAX_WAIT_MS) {
      await sleep(POLL_MS);
      // A pane that is still working is writing this message's answer; one that has gone idle has finished the turn, and
      // its last answer is the one for this message. Without a lead ref there is no pane to read, and only the log counts.
      const status = ref === undefined ? undefined : (await statusLookup(rts, ref)).status;
      if (status === "working") working = true;
      // A working pane's turn may still be writing an earlier message's answer: only an answer written while it is
      // working, or after it has gone idle, is this message's.
      if (item.ownFrom === undefined && status === "working") continue;
      const text = lastAnswer(item.sessionPath, item.ownFrom ?? item.offset);
      if (!text) {
        if (working && status !== "working") return true;
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
      await sleep(POLL_MS);
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
