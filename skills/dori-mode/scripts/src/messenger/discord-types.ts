/** What a Discord inbound receiver hands out, and what it needs back from its surroundings. */
export type Inbound = {
  readonly source: "guild" | "dm";
  readonly channel: string;
  readonly guild: string;
  readonly messageId: string;
  readonly author: string;
  readonly authorIsBot: boolean;
  readonly text: string;
  readonly media?: readonly string[];
  readonly replyToId?: string;
  readonly replyToAuthor?: string;
  readonly replyToText?: string;
  /** User ids this message @-mentions, so a consumer can tell whose message it is without re-parsing text. */
  readonly mentions?: readonly string[];
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
  onClose?(cb: (code: number, reason: string) => void): void;
};

export type Clock = {
  setInterval: (cb: () => void, ms: number) => unknown;
  clearInterval: (h: unknown) => void;
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
