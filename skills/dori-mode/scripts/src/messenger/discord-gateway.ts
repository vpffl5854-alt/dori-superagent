/** The gateway protocol the receiver speaks: intents, opcodes, and the timing constants. */
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
/** A freshly opened socket that sends no HELLO within this window is dead; nothing else would ever
 * notice, because the heartbeat and its ack watch only exist once HELLO has arrived. */
export const HELLO_WAIT_MS = 15_000;
export const RECONNECT_MIN_MS = 1_000;
export const RECONNECT_MAX_MS = 5_000;
export const RECONNECT_BACKOFF_CAP_MS = 60_000;
export const FATAL_CLOSE_CODES: ReadonlySet<number> = new Set([4004, 4010, 4011, 4012, 4013, 4014]);
export const MAX_SEEN = 500;

/** Discord caps a messages page at 100; a long outage needs several of them. */
export const BACKFILL_PAGE = 100;
/** 2,000 messages is a long outage; past that the run stops and says so rather than paging forever. */
export const BACKFILL_MAX_PAGES = 20;

export type GatewayPayload = {
  readonly op: number;
  readonly s?: number | null;
  readonly t?: string | null;
  readonly d?: Record<string, unknown> | null;
};

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
