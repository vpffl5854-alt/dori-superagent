/**
 * The Cue relay: the owner's Discord messages go to the Cue task on Manus, and Cue's replies come back to the channel.
 *
 * Discord is read over REST (`after=<last seen id>`), so a reply this bridge posts can never be read back and sent
 * out again: it is skipped by the bot's own author id. A message is sent to Cue before the Discord cursor moves past
 * it, so a crash in between repeats the send instead of dropping the message. Cue is polled with task.listMessages
 * until it answers, and the poll is keyed on the id of the message just sent, so a stale reply cannot be posted.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { ManusClient, ManusMessage, RateLimiter } from "./manus.ts";
import { parseMessages, repliesAfter } from "./manus.ts";

export type RelayConfig = {
  readonly channel: string;
  readonly owner: string;
  readonly botId: string;
  readonly taskId: string;
  readonly pollMs: number;
  readonly replyTimeoutMs: number;
};

export type RelayState = {
  readonly discordAfter: string;
  readonly awaiting: { readonly sentId: string; readonly sinceMs: number } | null;
  readonly lastPosted: string;
};

export const emptyState: RelayState = { discordAfter: "0", awaiting: null, lastPosted: "" };

export const readState = (file: string): RelayState => {
  if (!existsSync(file)) return emptyState;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<RelayState>;
    const awaiting = raw.awaiting;
    return {
      discordAfter: typeof raw.discordAfter === "string" ? raw.discordAfter : "0",
      awaiting:
        awaiting && typeof awaiting.sentId === "string" && typeof awaiting.sinceMs === "number"
          ? { sentId: awaiting.sentId, sinceMs: awaiting.sinceMs }
          : null,
      lastPosted: typeof raw.lastPosted === "string" ? raw.lastPosted : "",
    };
  } catch {
    return emptyState;
  }
};

export const writeState = (file: string, state: RelayState): void => {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, file);
};

export type DiscordMessage = {
  readonly id: string;
  readonly author: { readonly id: string; readonly bot?: boolean };
  readonly content: string;
};

export const ownerTexts = (
  page: readonly unknown[],
  owner: string,
): { readonly texts: readonly { readonly id: string; readonly text: string }[]; readonly newest?: string } => {
  const texts: { id: string; text: string }[] = [];
  let newest: string | undefined;
  for (const raw of page) {
    const m = raw as Partial<DiscordMessage>;
    if (typeof m.id !== "string") continue;
    if (newest === undefined || BigInt(m.id) > BigInt(newest)) newest = m.id;
    if (m.author?.id !== owner || m.author.bot === true) continue;
    const text = typeof m.content === "string" ? m.content.trim() : "";
    if (text) texts.push({ id: m.id, text });
  }
  return { texts, ...(newest === undefined ? {} : { newest }) };
};

export const formatForCue = (text: string): string => `[디코→큐] ${text.trim()}`;
export const formatFromCue = (text: string): string => `큐: ${text.trim()}`;

export type RelayDeps = {
  readonly discord: {
    readonly history: (channel: string, after: string, limit: number) => Promise<readonly unknown[]>;
    readonly send: (channel: string, content: string) => Promise<unknown>;
  };
  readonly manus: Pick<ManusClient, "sendMessage" | "listMessages">;
  readonly limiter: RateLimiter;
  readonly save: (state: RelayState) => void;
  readonly log: (line: string) => void;
  readonly now: () => number;
};

export const forwardDiscord = async (deps: RelayDeps, config: RelayConfig, state: RelayState): Promise<RelayState> => {
  let current = state;
  const page = await deps.discord.history(config.channel, current.discordAfter, 50);
  const { texts, newest } = ownerTexts(page, config.owner);
  for (const { id, text } of texts) {
    if (current.awaiting) {
      deps.log(`SKIPPED discord ${id}: Cue has not answered the message sent before it`);
      current = { ...current, discordAfter: id };
      deps.save(current);
      continue;
    }
    await deps.limiter.take();
    const sent = await deps.manus.sendMessage(config.taskId, formatForCue(text));
    current = {
      discordAfter: id,
      awaiting: { sentId: sentMessageId(sent), sinceMs: deps.now() },
      lastPosted: current.lastPosted,
    };
    deps.save(current);
    deps.log(`SENT discord ${id} -> cue (${text.length} chars)`);
  }
  if (!texts.length && newest !== undefined && newest !== current.discordAfter) {
    current = { ...current, discordAfter: newest };
    deps.save(current);
  }
  return current;
};

/** The id of the message just sent, so the reply poll can start after it; an empty id falls back to the whole tail. */
export const sentMessageId = (raw: unknown): string => {
  const seen = new Set<unknown>();
  const find = (v: unknown): string | undefined => {
    if (!v || typeof v !== "object" || seen.has(v)) return undefined;
    seen.add(v);
    if (Array.isArray(v)) return undefined;
    const r = v as Record<string, unknown>;
    for (const key of ["message_id", "id"]) if (typeof r[key] === "string" && r[key]) return r[key] as string;
    for (const key of ["message", "data", "result"]) {
      const hit = find(r[key]);
      if (hit) return hit;
    }
    return undefined;
  };
  return find(raw) ?? `sent-${Date.now()}`;
};

export const relayReplies = async (deps: RelayDeps, config: RelayConfig, state: RelayState): Promise<RelayState> => {
  const awaiting = state.awaiting;
  if (!awaiting) return state;
  if (deps.now() - awaiting.sinceMs > config.replyTimeoutMs) {
    deps.log("TIMEOUT Cue did not answer within the reply window; the next Discord message is sent anyway");
    const next = { ...state, awaiting: null };
    deps.save(next);
    return next;
  }
  const replies = repliesAfter(parseMessages(await deps.manus.listMessages(config.taskId)), awaiting.sentId).filter(
    (m: ManusMessage) => m.id !== state.lastPosted,
  );
  const last = replies.at(-1);
  if (!last) return state;
  await deps.discord.send(config.channel, formatFromCue(last.content));
  const next = { ...state, awaiting: null, lastPosted: last.id };
  deps.save(next);
  deps.log(`POSTED cue ${last.id} -> discord`);
  return next;
};

export const runRelay = async (deps: RelayDeps, config: RelayConfig, state: RelayState): Promise<never> => {
  let current = state;
  for (;;) {
    try {
      current = await forwardDiscord(deps, config, current);
    } catch (e) {
      deps.log(`ERROR discord pass: ${e instanceof Error ? e.message : String(e)}`);
    }
    try {
      current = await relayReplies(deps, config, current);
    } catch (e) {
      deps.log(`ERROR cue pass: ${e instanceof Error ? e.message : String(e)}`);
    }
    await Bun.sleep(config.pollMs);
  }
};
