/**
 * A Discord message as it arrives on the gateway: the media it carries, its snowflake id, and the one line the
 * inbound log prints. The socket and its backfill live in `discord-inbound.ts`; this is what both of them read.
 */
import type { Inbound, MediaRef } from "./discord-gateway.ts";

export type MessageCreate = {
  readonly id?: string;
  readonly channel_id?: string;
  readonly guild_id?: string;
  readonly content?: string;
  readonly author?: { readonly id?: string; readonly username?: string; readonly bot?: boolean };
  readonly attachments?: readonly unknown[];
  readonly embeds?: readonly unknown[];
  readonly message_reference?: { readonly message_id?: string };
  readonly mentions?: readonly { readonly id?: string; readonly username?: string }[];
  readonly referenced_message?: MessageCreate | null;
};

export const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;

const MEDIA_LIMIT = 6;
const MAX_INBOUND_TEXT = 1500;

const cdnUrl = (value: unknown): string | null => {
  const r = asRecord(value);
  const url = r?.["proxy_url"] ?? r?.["url"];
  return typeof url === "string" && url ? url : null;
};

/** Every image or video a message carries, in the order a reader wants them: the file itself,
 * then what an embed shows (its image, its thumbnail, then a gifv's video). Discord's own
 * `proxy_url` wins over the origin URL, so an expiring signature never breaks a download. */
export const mediaRefs = (data: unknown): readonly MediaRef[] => {
  const m = asRecord(data) as MessageCreate | null;
  if (!m) return [];
  const out: MediaRef[] = [];
  for (const attachment of Array.isArray(m.attachments) ? m.attachments : []) {
    const r = asRecord(attachment);
    const url = cdnUrl(r);
    if (!url) continue;
    const name =
      typeof r?.["filename"] === "string"
        ? r["filename"]
        : typeof r?.["content_type"] === "string"
          ? r["content_type"]
          : "file";
    out.push({ url, name });
  }
  for (const embed of Array.isArray(m.embeds) ? m.embeds : []) {
    const r = asRecord(embed);
    if (!r) continue;
    for (const key of ["image", "thumbnail", "video"] as const) {
      const url = cdnUrl(r[key]);
      if (url) out.push({ url, name: key === "video" ? "video.mp4" : `${key}.png` });
    }
  }
  const seen = new Set<string>();
  return out.filter((ref) => (seen.has(ref.url) ? false : (seen.add(ref.url), true))).slice(0, MEDIA_LIMIT);
};

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
    ...(Array.isArray(m.mentions) && m.mentions.length > 0
      ? { mentions: m.mentions.map((u) => String(u?.username ?? u?.id ?? "")).filter(Boolean) }
      : {}),
    ...(ref
      ? {
          replyToId: ref,
          ...(replied?.author?.username ? { replyToAuthor: replied.author.username } : {}),
          ...((replied?.content ?? "").trim()
            ? { replyToText: (replied?.content ?? "").trim().slice(0, MAX_INBOUND_TEXT) }
            : {}),
          ...(replied ? { replyTo: replied } : {}),
        }
      : {}),
  };
};

export const formatInbound = (i: Inbound): string =>
  `INBOUND discord ${i.source} ${i.channel} ${i.guild} ${i.messageId} ${i.author} ${JSON.stringify(i.text.slice(0, MAX_INBOUND_TEXT))}` +
  (i.mentions && i.mentions.length > 0 ? ` mentions=${i.mentions.join(",")}` : "") +
  (i.media && i.media.length > 0 ? ` media=${i.media.join(",")}` : "") +
  (i.replyToId
    ? ` reply_to=${i.replyToId}${i.replyToAuthor ? ` reply_author=${JSON.stringify(i.replyToAuthor)}` : ""}${
        i.replyToText ? ` reply_text=${JSON.stringify(i.replyToText)}` : ""
      }`
    : "");
