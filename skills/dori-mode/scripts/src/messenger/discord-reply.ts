/**
 * The answer to an inbound Discord message, posted back to the channel it came from.
 *
 * The answer is read from the lead's session log rather than its screen: the message reaches the pane as a queued
 * prompt, so the answer is the next assistant text after the hand-off, and a long answer must arrive whole instead of
 * as the part that still fits on screen.
 */
import { closeSync, openSync, readSync, statSync } from "node:fs";

import type { Discord } from "./discord.ts";

/** Discord refuses a message past 2000 characters; the room is kept for the continuation marker. */
export const MAX_DISCORD_CHARS = 2000;
const MARK = "…(이어서)";
const SLICE = MAX_DISCORD_CHARS - MARK.length;

/**
 * One message body, split on Discord's limit. A cut lands on a line break or a space when there is one in the last
 * quarter of the slice, so a sentence is not split mid-word; the hard cut is the fallback for text with neither.
 */
export const splitForDiscord = (text: string): string[] => {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > MAX_DISCORD_CHARS) {
    let at = Math.max(rest.lastIndexOf("\n", SLICE), rest.lastIndexOf(" ", SLICE));
    if (at < SLICE * 0.75) at = SLICE;
    out.push(`${rest.slice(0, at).trimEnd()}${MARK}`);
    rest = rest.slice(at).trimStart();
  }
  if (rest) out.push(rest);
  return out;
};

/**
 * Lines the pane writes for itself, never for the person in Discord: its routing line and its hand-off block. A slot
 * label only counts with the colon that makes it a label, so a real Korean answer that happens to start with `Now` is
 * left alone.
 */
const META_LINE = /^\s*(I read this as\b|Ask:|wanted:|For you:|Now:|Next:|HANDOFF\b)/i;

/**
 * The answer text of one assistant message, or undefined for a message that carries none (a tool call only).
 * Leading lines the pane writes for itself are dropped; a message that is nothing but those lines is no answer, and
 * posting it would put an English sentence in a Korean room.
 */
export const answerText = (message: unknown): string | undefined => {
  const parts = (message as { content?: unknown } | null)?.content;
  if (!Array.isArray(parts)) return undefined;
  const text = parts
    .filter((p): p is { type: string; text: string } => {
      const part = p as { type?: unknown; text?: unknown } | null;
      return part?.type === "text" && typeof part.text === "string";
    })
    .map((p) => p.text)
    .join("\n")
    .trim();
  if (!text) return undefined;
  const lines = text.split("\n");
  let first = 0;
  while (first < lines.length && META_LINE.test(lines[first] ?? "")) first += 1;
  return lines.slice(first).join("\n").trim() || undefined;
};

/** The last assistant answer in a session log written after `fromOffset`, or undefined when there is none yet. */
export const lastAnswer = (sessionPath: string, fromOffset: number): string | undefined => {
  let size = 0;
  try {
    size = statSync(sessionPath).size;
  } catch {
    return undefined;
  }
  if (size <= fromOffset) return undefined;
  const buf = Buffer.alloc(size - fromOffset);
  const fd = openSync(sessionPath, "r");
  try {
    readSync(fd, buf, 0, buf.length, fromOffset);
  } finally {
    closeSync(fd);
  }
  let last: string | undefined;
  for (const line of buf.toString("utf8").split("\n")) {
    if (!line.trim()) continue;
    let entry: { message?: { role?: unknown; content?: unknown } };
    try {
      entry = JSON.parse(line) as typeof entry;
    } catch {
      continue;
    }
    if (entry.message?.role !== "assistant") continue;
    const text = answerText(entry.message);
    if (text) last = text;
  }
  return last;
};

export const sessionSize = (sessionPath: string): number => {
  try {
    return statSync(sessionPath).size;
  } catch {
    return 0;
  }
};

/** Posts the answer as a Discord reply to the message that asked, split across messages when it is too long. */
export const postAnswer = async (
  discord: Discord,
  channel: string,
  replyTo: string,
  text: string,
): Promise<string[]> => {
  const ids: string[] = [];
  for (const [index, part] of splitForDiscord(text).entries()) {
    ids.push(await discord.send(channel, part, index === 0 ? replyTo : undefined));
  }
  return ids;
};
