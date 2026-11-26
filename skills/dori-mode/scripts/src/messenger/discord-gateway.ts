/**
 * The Discord gateway's shape: what a message is, what the socket hands back, and the budgets the reconnect and
 * backfill keep to. The socket itself is in `discord-inbound.ts`.
 */
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

export type GatewayPayload = {
  readonly op: number;
  readonly s?: number | null;
  readonly t?: string | null;
  readonly d?: Record<string, unknown> | null;
};

export type Inbound = {
  readonly source: "guild" | "dm";
  readonly channel: string;
  readonly guild: string;
  readonly messageId: string;
  readonly author: string;
  readonly authorIsBot: boolean;
  readonly text: string;
  readonly mentions?: readonly string[];
  readonly media?: readonly string[];
  readonly replyToId?: string;
  readonly replyToAuthor?: string;
  readonly replyToText?: string;
  /** The message this one replies to, whole, so its text is readable past what the INBOUND line carries. */
  readonly replyTo?: MessageCreate;
};

export type MediaRef = {
  readonly url: string;
  readonly name: string;
};

export type MediaStore = {
  save(messageId: string, index: number, ref: MediaRef): Promise<readonly string[]>;
};

export type GatewaySocket = {
  send(data: string): void;
  close(): void;
  onMessage(cb: (data: string) => void): void;
  /** Called once when the socket closes or fails, whoever closed it; the loop then reconnects. */
  onClose?(cb: (why: string) => void): void;
};

export type Clock = {
  setInterval: (cb: () => void, ms: number) => unknown;
  clearInterval: (h: unknown) => void;
  /** Wall clock in ms; optional so existing test clocks keep working. */
  now?: () => number;
  /** One-shot timer for the reconnect backoff; optional (falls back to global setTimeout). */
  setTimeout?: (cb: () => void, ms: number) => unknown;
  clearTimeout?: (h: unknown) => void;
};

/** The newest message id seen in each channel, so a restart can ask Discord what it missed. */
export type InboundCursors = Readonly<Record<string, string>>;

export type CursorStore = {
  read(): Promise<InboundCursors>;
  write(cursors: InboundCursors): Promise<void>;
};

/** One page of a channel's history after `after`, in Discord's order (newest first). */
export type ChannelHistory = (channel: string, after: string, limit: number) => Promise<readonly unknown[]>;

/** The guild a channel belongs to; REST message payloads carry no `guild_id`, so a backfilled
 * message would otherwise be reported as a DM. */
export type ChannelGuild = (channel: string) => Promise<string | null>;

export const DISCORD_INTENTS_GUILD_MESSAGES = 1 << 9;
export const DISCORD_INTENTS_DIRECT_MESSAGES = 1 << 12;
export const DISCORD_INTENTS_MESSAGE_CONTENT = 1 << 15;

export const DISCORD_INBOUND_INTENTS =
  DISCORD_INTENTS_GUILD_MESSAGES | DISCORD_INTENTS_DIRECT_MESSAGES | DISCORD_INTENTS_MESSAGE_CONTENT;

export const OP_DISPATCH = 0;
export const OP_HEARTBEAT = 1;
export const OP_IDENTIFY = 2;
export const OP_RESUME = 6;
export const OP_RECONNECT = 7;
export const OP_INVALID_SESSION = 9;
export const OP_HELLO = 10;
export const OP_HEARTBEAT_ACK = 11;

export const EVENT_READY = "READY";
export const EVENT_MESSAGE_CREATE = "MESSAGE_CREATE";

export const DEFAULT_HEARTBEAT_MS = 41_250;
export const MAX_SEEN = 500;

/** Discord's gateway rules, from its docs ("Rate Limiting" / "Gateway"): a client should wait
 * 1-5s (random) when told to reconnect, back off on repeated failures, and must not exceed 1000
 * RESUME/IDENTIFY attempts in 24h or the token is reset. Without this the bridge reconnected in a
 * tight loop and Discord reset the bot token (2026-11-08, robin). */
/** A socket with no hello by then is dead (a network blip mid-reconnect): it is closed and replaced. */
export const HELLO_TIMEOUT_MS = 30_000;
export const RECONNECT_BASE_MS = 1_000;
export const RECONNECT_MAX_MS = 60_000;
export const SESSION_START_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Stop well below Discord's ceiling so a burst can never reach it. */
export const SESSION_START_LIMIT = 900;
/** A connection that lived at least this long counts as healthy and resets the backoff. */
export const HEALTHY_SESSION_MS = 60_000;

/** Discord caps a messages page at 100; a long outage needs several of them. */
export const BACKFILL_PAGE = 100;
/** 2,000 messages is a long outage; past that the run stops and says so rather than paging forever. */
export const BACKFILL_MAX_PAGES = 20;
