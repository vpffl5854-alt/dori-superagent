/**
 * The room's lane: a Discord channel is answered in the lane that watches it (`leadPane` names the lane), and its
 * answer goes back to the room through `hooks.discordReply`. The lane runs `dori send` itself, or whatever the hook
 * names; without a hook the bridge posts the answer.
 *
 * The lane is told where to read the message (its session log, from the offset the message is logged at) so the answer
 * can be found without guessing which assistant text belongs to which message. The answer is read from that log, not
 * the screen, so a long answer arrives whole.
 *
 * The prompt is typed into a pane that is watching a room, so it is the room's own name for the message and nothing
 * more: a line that reads like a standing order ("답은 …만 쓰고") is taken as a command and repeated by a lane that
 * answers in prose, and the watchdog then sees one command run over and over.
 */
import { appendFileSync } from "node:fs";
import { join } from "node:path";

import type { SessionRef } from "../../../../../src/runtime/types.ts";
import { type DoriConfig, fill } from "../config.ts";
import { type ChosenRuntimes, type Runner, run as realRun, runtimesOf } from "../run.ts";
import { readScreen, sendVerified, statusLookup } from "../sessions.ts";
import type { Discord } from "./discord.ts";
import type { Inbound } from "./discord-gateway.ts";
import { laneAnswerer } from "./discord-lane-answer.ts";
import { resolveLeadRef, sessionPathForPane } from "./discord-pane.ts";
import { lastAnswer, postAnswer, sessionSize } from "./discord-reply.ts";

export type LaneAnswer = { readonly stop: () => void; readonly enqueue: (inbound: Inbound) => Promise<boolean> };

const POLL_MS = 1_500;
const MAX_WAIT_MS = 20 * 60 * 1000;
const clock = { now: () => Date.now(), sleep: (ms: number) => Bun.sleep(ms) };

/** True when the lane's input box already holds unsent text: typing then would append to it, not send. */
const draftPresent = async (rts: ChosenRuntimes, ref: SessionRef): Promise<boolean> => {
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

/** Hands one room message to the lane and reads its answer from the lane's log, or undefined when the lane cannot take it. */
const askLane = async (
  config: DoriConfig,
  rts: ChosenRuntimes,
  sessionPath: () => Promise<string | undefined>,
  inbound: Inbound,
): Promise<string | undefined> => {
  const ref = await resolveLeadRef(config, rts).catch(() => undefined);
  if (!ref) return undefined;
  const sessionLog = await sessionPath();
  if (!sessionLog) return undefined;
  const status = await statusLookup(rts, ref);
  if (status.status === undefined || status.status === "shell" || status.status === "gone") return undefined;
  if (await draftPresent(rts, ref)) return undefined;
  const size = sessionSize(sessionLog);
  const prompt = `디코 수신 · 채널=${inbound.channel} msg=${inbound.messageId} · 세션기록=${sessionLog}`;
  if ((await sendVerified(rts, clock, ref, prompt)) === "failed") return undefined;
  const started = Date.now();
  // The lane starts a turn for this message; the answer is read once that turn has ended, because a working lane may
  // still be writing it. A lane that never starts working (a refused prompt) is read on the next pass anyway.
  while (Date.now() - started < MAX_WAIT_MS) {
    await Bun.sleep(POLL_MS);
    const now = (await statusLookup(rts, ref)).status;
    if (now === "working") continue;
    const text = lastAnswer(sessionLog, size);
    if (text) return text;
  }
  return undefined;
};

const note = (config: DoriConfig, line: string): void => {
  try {
    appendFileSync(join(config.stateDir, "discord-replies.log"), `[${new Date().toISOString()}] ${line}\n`);
  } catch {}
};

export const startLaneAnswers = (
  discord: Discord,
  config: DoriConfig,
  rts: ChosenRuntimes = runtimesOf({ run: realRun, clock, config }),
  run: Runner = realRun,
  sessionPath: () => Promise<string | undefined> = () => sessionPathForPane(config, rts),
): LaneAnswer => {
  const answer = laneAnswerer({
    stateDir: config.stateDir,
    selfId: config.discordSelfId ?? "",
    answer: async (inbound) => await askLane(config, rts, sessionPath, inbound),
    reply: async (inbound, text) => {
      const hook = config.hooks.discordReply;
      if (hook?.length) {
        const r = await run(fill(hook, { channel: inbound.channel, message: inbound.messageId, text }));
        if (r.code === 0) return true;
        note(config, `lane reply hook failed for ${inbound.messageId}: ${r.err.slice(0, 160)}`);
      }
      await postAnswer(discord, inbound.channel, inbound.messageId, text);
      return true;
    },
    note: (line) => note(config, line),
  });
  return { stop: () => {}, enqueue: answer };
};
