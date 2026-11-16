/** Turning a Discord payload into the line a lane reads: ids, the inbound record, and its one-line format. */
import { asRecord, type MessageCreate, mediaRefs } from "./discord-media.ts";
import type { Inbound } from "./discord-types.ts";
export { asRecord, mediaRefs } from "./discord-media.ts";

/** Discord ids are snowflakes: a longer id is newer, and equal lengths compare as text. */
export const newerId = (a: string, b: string): string => {
  if (!a) return b;
  if (!b) return a;
  if (a.length !== b.length) return a.length > b.length ? a : b;
  return a >= b ? a : b;
};

export const idOf = (data: unknown): string => {
  const id = asRecord(data)?.["id"];
  return typeof id === "string" ? id : "";
};

export const toInbound = (data: unknown, selfId: string, guildHint?: string | null): Inbound | null => {
  const m = asRecord(data) as MessageCreate | null;
  if (!m) return null;
  const id = m.id ?? "";
  const channel = m.channel_id ?? "";
  const authorId = m.author?.id ?? "";
  if (!id || !channel || !authorId) return null;
  if (authorId === selfId) return null;
  const text = (m.content ?? "").trim();
  const attachmentCount = Array.isArray(m.attachments) ? m.attachments.length : 0;
  const media = mediaRefs(data);
  if (!text && attachmentCount === 0 && media.length === 0) return null;
  const guild = m.guild_id ?? guildHint ?? undefined;
  const ref = m.message_reference?.message_id;
  const replied = (m.referenced_message ?? null) as MessageCreate | null;
  return {
    source: guild ? "guild" : "dm",
    channel,
    guild: guild ?? "-",
    messageId: id,
    author: m.author?.username ?? authorId,
    authorIsBot: m.author?.bot === true,
    text: text || (attachmentCount > 0 ? `[${attachmentCount} attachment(s)]` : "[media]"),
    ...(ref
      ? {
          replyToId: ref,
          ...(replied?.author?.username ? { replyToAuthor: replied.author.username } : {}),
          ...((replied?.content ?? "").trim().slice(0, REPLY_PREVIEW)
            ? { replyToText: (replied?.content ?? "").trim().slice(0, REPLY_PREVIEW) }
            : {}),
        }
      : {}),
    ...(Array.isArray(m.mentions) && m.mentions.length > 0
      ? { mentions: m.mentions.map((u) => u?.id ?? "").filter((id) => id.length > 0) }
      : {}),
  };
};

/** A replaced message is quoted as a preview; the quoted message normally has its own line. */
const REPLY_PREVIEW = 300;

/** The message text goes out whole: JSON.stringify keeps it on one line, and cutting it would
 * leave the monitor with no way to tell a short message from a long one. */
export const formatInbound = (i: Inbound): string =>
  `INBOUND discord ${i.source} ${i.channel} ${i.guild} ${i.messageId} ${i.author} ${JSON.stringify(i.text)}` +
  (i.mentions && i.mentions.length > 0 ? ` mentions=${i.mentions.join(",")}` : "") +
  (i.media && i.media.length > 0 ? ` media=${i.media.join(",")}` : "") +
  (i.replyToId
    ? ` reply_to=${i.replyToId}${i.replyToAuthor ? ` reply_author=${JSON.stringify(i.replyToAuthor)}` : ""}${
        i.replyToText ? ` reply_text=${JSON.stringify(i.replyToText)}` : ""
      }`
    : "");
