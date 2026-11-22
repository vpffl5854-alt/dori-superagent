/**
 * One inbound shape for every messenger: `{ userId, channel, text }`. Each platform keeps its own
 * inbound type (TgInbound, discord-gateway's Inbound, slack-inbound's Inbound) because their polling
 * loops need platform fields; the adapter strips those down for anything that only wants to know who
 * said what, and remembers just enough to answer on the same messenger later — the origin of the
 * first message is where a done notification goes.
 */
import type { Inbound as DiscordInbound } from "./discord-gateway.ts";
import type { Inbound as SlackInbound } from "./slack-inbound.ts";
import type { TgInbound } from "./telegram-inbound.ts";
import type { TgTarget } from "./telegram.ts";

export type Platform = "telegram" | "discord" | "slack";

/** The common inbound shape: who wrote it, where it landed, what it said. */
export type UnifiedMessage = {
  readonly platform: Platform;
  readonly userId: string;
  readonly channel: string;
  readonly text: string;
};

/** Everything a reply needs that UnifiedMessage deliberately drops. */
export type ReplyTarget =
  | { readonly platform: "telegram"; readonly target: TgTarget }
  | { readonly platform: "discord"; readonly channelId: string }
  | { readonly platform: "slack"; readonly channel: string; readonly threadTs?: string };

export type Adapted = { readonly message: UnifiedMessage; readonly reply: ReplyTarget };

export const adaptTelegram = (i: TgInbound): Adapted => ({
  message: {
    platform: "telegram",
    userId: String(i.from),
    channel: String(i.chat),
    text: i.text ?? (i.media === undefined ? "" : `[${i.media.kind}]`),
  },
  reply: {
    platform: "telegram",
    target: { chatId: i.chat, ...(i.thread === undefined ? {} : { threadId: i.thread }) },
  },
});

export const adaptDiscord = (i: DiscordInbound): Adapted => ({
  message: { platform: "discord", userId: i.author, channel: i.channel, text: i.text },
  reply: { platform: "discord", channelId: i.channel },
});

export const adaptSlack = (i: SlackInbound): Adapted => ({
  message: { platform: "slack", userId: i.user ?? "", channel: i.channel, text: i.text ?? "" },
  reply: {
    platform: "slack",
    channel: i.channel,
    ...(i.threadTs === undefined ? {} : { threadTs: i.threadTs }),
  },
});

/** One send per platform, injected so tests never touch the network. */
export type Senders = {
  readonly telegram: (target: TgTarget, text: string) => Promise<unknown>;
  readonly discord: (channelId: string, text: string) => Promise<unknown>;
  readonly slack: (channel: string, text: string, threadTs?: string) => Promise<unknown>;
};

export const sendReply = async (senders: Senders, reply: ReplyTarget, text: string): Promise<void> => {
  if (reply.platform === "telegram") await senders.telegram(reply.target, text);
  else if (reply.platform === "discord") await senders.discord(reply.channelId, text);
  else await senders.slack(reply.channel, text, reply.threadTs);
};

/**
 * Remembers where the first inbound message arrived and answers there. A task can hear from
 * several messengers while it runs; the completion notice still goes to the one that asked.
 */
export class OriginNotifier {
  private first: ReplyTarget | undefined;

  constructor(private readonly senders: Senders) {}

  /** Feed every inbound message through here; only the first one's origin is kept. */
  observe(a: Adapted): UnifiedMessage {
    this.first ??= a.reply;
    return a.message;
  }

  /** Sends `text` to the first message's messenger. Returns false when nothing has arrived yet. */
  async notifyDone(text: string): Promise<boolean> {
    if (this.first === undefined) return false;
    await sendReply(this.senders, this.first, text);
    return true;
  }
}
