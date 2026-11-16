/** What a Discord message carries as images or videos: the attachment itself, then what an embed shows. */
/** A MESSAGE_CREATE payload, or a REST message row: only the fields the receiver reads. */
export type MessageCreate = {
  readonly id?: string;
  readonly channel_id?: string;
  readonly guild_id?: string;
  readonly content?: string;
  readonly author?: { readonly id?: string; readonly username?: string; readonly bot?: boolean };
  readonly attachments?: readonly unknown[];
  readonly embeds?: readonly unknown[];
  readonly message_reference?: { readonly message_id?: string };
  readonly referenced_message?: MessageCreate | null;
  readonly mentions?: readonly { readonly id?: string }[];
};

export type MediaRef = {
  readonly url: string;
  readonly name: string;
};

const MEDIA_LIMIT = 6;

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

export const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
