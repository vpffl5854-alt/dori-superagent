/**
 * A bot's post that called Dori, answered in the room: the lead pane is for the human, and a bot that mentions Dori
 * or replies to Dori's own post gets its answer where it asked, without spending a lead turn.
 *
 * Only that bot is answered. Anything else a bot says is bot-to-bot chatter: it is logged and left alone, because a
 * bot that answers every post gets answered by every other bot that does the same, and the room loops (2026-11-17,
 * 상디). The budget is per channel and per bot and survives a restart, so a bot that calls Dori every second is
 * answered a few times and then left to the lead.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Discord } from "./discord.ts";
import type { Inbound } from "./discord-gateway.ts";
import { splitForDiscord } from "./discord-reply.ts";

/** The name Dori answers to when a bot calls it in the room. */
export const DORI_NAME = "dori";

/** A mention row counts as Dori when its name or id says so: the bot's username is "Dori Dori", and a mention row
 * carries either the username or the numeric id, so a plain equality against "dori" misses both. */
export const isDoriMention = (mention: { readonly id?: string; readonly username?: string } | string): boolean => {
  const id = typeof mention === "string" ? mention : (mention.username ?? mention.id ?? "");
  const lowered = id.toLowerCase();
  return lowered === DORI_NAME || lowered === "dori dori" || lowered === "1560538193735188561";
};

/** How many of one bot's calls in one channel are answered in the room before it is left to the lead. */
export const BOT_REPLY_BUDGET = 6;

/** The answer that has no content, which the room must never receive. */
export const EMPTY_BOT_REPLY = /^\s*>\s[^\n]*\n+\s*\S+\s*말에 답한다\.?\s*$/;

/** Lines that are the lane's own bookkeeping, not an answer: they describe the lane's waiting state instead of
 * replying to the message. The room saw one of these verbatim (2026-11-21 14:59, "(봇 리액션이라 답·메모 없이 대기)"),
 * which read as the lane calling a person a bot. Any parenthesised self-note or a bare waiting line is dropped. */
export const INTERNAL_NOTE =
  /^\s*\(?[^()\n]{0,40}(봇 리액션|답·메모 없이|메모 없이 대기|대기 중|조용히 기다|원문은 위 세션기록)[^()\n]{0,40}\)?\s*[.。]?\s*$/;

/** True when `text` is something a person would read: not blank, not the quote-only "말에 답한다" line, and not one of
 * the lane's own bookkeeping notes. */
export const hasContent = (text: string): boolean =>
  text.trim() !== "" &&
  !EMPTY_BOT_REPLY.test(text) &&
  !text.split("\n").every((l) => l.trim() === "" || INTERNAL_NOTE.test(l));

/**
 * Why this bot post deserves an answer, or null when it is bot-to-bot chatter that only gets logged.
 * `selfId` is Dori's own Discord user id, so a reply to Dori's post is recognised by id, not by name.
 */
export const botCall = (
  inbound: Pick<Inbound, "author" | "text" | "mentions" | "replyToAuthor">,
  selfId: string,
): string | null => {
  const named = inbound.mentions?.some(isDoriMention) ?? false;
  const called =
    named ||
    inbound.text.toLowerCase().includes(`@${DORI_NAME}`) ||
    // A raw id mention (`<@1560538193735188561>`) carries no `@dori` text, so match the id form too.
    /<@!?1560538193735188561>/.test(inbound.text);
  const replied =
    selfId !== "" && (inbound.replyToAuthor === selfId || inbound.replyToAuthor?.toLowerCase() === DORI_NAME);
  if (replied) return `replied to ${DORI_NAME}`;
  if (called) return `called ${DORI_NAME}`;
  // Any other bot post is still offered to the answerer: a person reads the room and speaks when there is something to
  // add or push back on, and says nothing when there is not. `hasContent` below drops an empty answer.
  return "room talk";
};

/** Per channel and per bot, so a restart does not reset the count and two bots cannot spend each other's. */
type BotBudget = Readonly<Record<string, Readonly<Record<string, number>>>>;

const readBudget = (path: string): BotBudget => {
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

const writeBudget = (path: string, budget: BotBudget): void => {
  try {
    writeFileSync(path, JSON.stringify(budget, null, 1));
  } catch {}
};

/**
 * Answers a bot post that called Dori in the room, as a reply to it, with `answer`'s text. The text is the lead's
 * answer when it has one; a quote-only line is never posted. One answer spends one of that bot's budget for the
 * channel, and a failed post spends nothing.
 */
export const botAnswerer = (deps: {
  readonly discord: Discord;
  readonly stateDir: string;
  readonly selfId: string;
  readonly note: (line: string) => void;
  readonly answer: (inbound: Inbound) => Promise<string | undefined>;
}): ((inbound: Inbound) => Promise<boolean>) => {
  const path = join(deps.stateDir, "discord-bot-replies.json");
  return async (inbound) => {
    const why = botCall(inbound, deps.selfId);
    if (!why) {
      deps.note(`bot ${inbound.author} in ${inbound.channel} left alone: bot-to-bot chatter, nothing posted`);
      return false;
    }
    const counts = readBudget(path);
    const spent = counts[inbound.channel]?.[inbound.author] ?? 0;
    if (spent >= BOT_REPLY_BUDGET) {
      deps.note(`bot ${inbound.author} in ${inbound.channel} ${why}, but its budget is spent: nothing posted`);
      return false;
    }
    let text: string | undefined;
    try {
      text = await deps.answer(inbound);
    } catch (e) {
      deps.note(`bot answer failed for ${inbound.messageId}: ${(e as Error).message}`);
      return false;
    }
    if (text === undefined || !hasContent(text)) {
      deps.note(
        `bot ${inbound.author} in ${inbound.channel} ${why}, but there was no answer with content: nothing posted`,
      );
      return false;
    }
    try {
      const ids: string[] = [];
      for (const [index, part] of splitForDiscord(text).entries()) {
        ids.push(await deps.discord.send(inbound.channel, part, index === 0 ? inbound.messageId : undefined));
      }
      writeBudget(path, { ...counts, [inbound.channel]: { ...counts[inbound.channel], [inbound.author]: spent + 1 } });
      deps.note(`answered bot ${inbound.author} in ${inbound.channel} ${why}: ${ids.join(",")}`);
      return true;
    } catch (e) {
      deps.note(`bot answer failed for ${inbound.messageId}: ${(e as Error).message}`);
      return false;
    }
  };
};
