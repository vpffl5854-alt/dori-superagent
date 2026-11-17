/**
 * A room post answered in the lane that watches the room: the lane writes the answer, and the room gets it once.
 *
 * A person's post is always offered to the lane, which says nothing when there is nothing to say. A bot's post is
 * offered when it called Dori, and otherwise only as room talk — and room talk is bounded, because a bot that answers
 * every post gets answered by every other bot that does the same, and the room loops (2026-11-17, 상디). The bound is
 * per channel and survives a restart, so a bot that talks every second is read a few times and then left alone.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { botCall, hasContent } from "./discord-bot-replies.ts";
import type { Inbound } from "./discord-gateway.ts";

/** How many of one bot's room-talk posts in one channel are offered to the lane before it is left alone. */
export const ROOM_TALK_BUDGET = 2;

type Budget = Readonly<Record<string, Readonly<Record<string, number>>>>;

const readBudget = (path: string): Budget => {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, Record<string, number>> = {};
    for (const [channel, bots] of Object.entries(parsed as Record<string, unknown>)) {
      if (!bots || typeof bots !== "object" || Array.isArray(bots)) continue;
      const kept: Record<string, number> = {};
      for (const [bot, count] of Object.entries(bots as Record<string, unknown>)) {
        if (typeof count === "number" && Number.isFinite(count)) kept[bot] = count;
      }
      out[channel] = kept;
    }
    return out;
  } catch {
    return {};
  }
};

const writeBudget = (path: string, budget: Budget): void => {
  try {
    writeFileSync(path, JSON.stringify(budget, null, 1));
  } catch {}
};

export const laneAnswerer = (deps: {
  readonly answer: (inbound: Inbound) => Promise<string | undefined>;
  readonly reply: (inbound: Inbound, text: string) => Promise<boolean>;
  readonly note: (line: string) => void;
  readonly stateDir: string;
  readonly selfId: string;
}): ((inbound: Inbound) => Promise<boolean>) => {
  const path = join(deps.stateDir, "discord-bot-replies.json");
  return async (inbound) => {
    const why = inbound.authorIsBot ? botCall(inbound, deps.selfId) : "a person";
    if (!why) {
      deps.note(`bot ${inbound.author} in ${inbound.channel} left alone: bot-to-bot chatter, nothing posted`);
      return false;
    }
    const counts = readBudget(path);
    const spent = counts[inbound.channel]?.[inbound.author] ?? 0;
    const roomTalk = why === "room talk";
    if (roomTalk && spent >= ROOM_TALK_BUDGET) {
      deps.note(`bot ${inbound.author} in ${inbound.channel} room talk, but its budget is spent: nothing posted`);
      return false;
    }
    let text: string | undefined;
    try {
      text = await deps.answer(inbound);
    } catch (e) {
      deps.note(`lane answer failed for ${inbound.messageId}: ${(e as Error).message}`);
      return false;
    }
    if (text === undefined || !hasContent(text)) {
      deps.note(`lane had nothing to add to ${inbound.messageId} (${why}): nothing posted`);
      return false;
    }
    let posted: boolean;
    try {
      posted = await deps.reply(inbound, text);
    } catch (e) {
      deps.note(`lane reply failed for ${inbound.messageId}: ${(e as Error).message}`);
      return false;
    }
    if (!posted) return false;
    if (roomTalk)
      writeBudget(path, { ...counts, [inbound.channel]: { ...counts[inbound.channel], [inbound.author]: spent + 1 } });
    deps.note(`answered ${inbound.author} in ${inbound.channel} (${why})`);
    return true;
  };
};
