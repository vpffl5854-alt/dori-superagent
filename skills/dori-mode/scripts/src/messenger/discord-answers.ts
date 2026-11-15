/**
 * Answers on Discord: a message handed to the lead pane is answered there, and the answer is posted back to the
 * channel it came from as a reply to the message that asked.
 *
 * The pane is told where to read the message (its session log, from the offset the message is logged at) so the
 * answer can be found without guessing which assistant text belongs to which message. The answer is read from that
 * log, not the screen, so a long answer arrives whole.
 */
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { SessionRef } from "../../../../../src/runtime/types.ts";
import type { DoriConfig } from "../config.ts";
import { run, runtimesOf } from "../run.ts";
import { agentStatus, readScreen, sendVerified } from "../sessions.ts";
import type { Discord } from "./discord.ts";
import { lastAnswer, postAnswer, sessionSize } from "./discord-reply.ts";

const POLL_MS = 1_500;
const MAX_WAIT_MS = 20 * 60 * 1000;

type Pending = {
  channel: string;
  messageId: string;
  sessionPath: string;
  offset: number;
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
export const sessionPathFor = async (sessionsDir: string, cwd: string): Promise<string | undefined> => {
  const dir = join(sessionsDir, `--${cwd.replace(/^\//, "").replace(/\//g, "-")}--`);
  const list = await run(["ls", "-t", dir]);
  if (list.code !== 0) return undefined;
  const newest = list.out
    .split("\n")
    .map((name) => name.trim())
    .find((name) => /^\d{4}-\d\d-\d\dT[\d-]+Z_[0-9a-f-]{36}\.jsonl$/.test(name));
  return newest ? join(dir, newest) : undefined;
};

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
): ReplyLoop & {
  readonly enqueue: (item: Omit<Pending, "offset">) => Promise<boolean>;
} => {
  const path = pendingPath(stateDir);
  const rts = runtimesOf({ run, clock, config });
  const ref = leadRef(config);
  let stopped = false;

  const enqueue = async (item: Omit<Pending, "offset">): Promise<boolean> => {
    if (!ref) return false;
    const size = sessionSize(item.sessionPath);
    if (!(await handOff(rts, ref, item.sessionPath, item.channel, item.messageId))) return false;
    const pending = readPending(path);
    writePending(path, [...pending.filter((p) => p.messageId !== item.messageId), { ...item, offset: size }]);
    return true;
  };

  const answer = async (item: Pending): Promise<boolean> => {
    const started = Date.now();
    while (!stopped && Date.now() - started < MAX_WAIT_MS) {
      await sleep(POLL_MS);
      const text = lastAnswer(item.sessionPath, item.offset);
      if (!text) continue;
      try {
        const ids = await postAnswer(discord, item.channel, item.messageId, text);
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
  };
};
