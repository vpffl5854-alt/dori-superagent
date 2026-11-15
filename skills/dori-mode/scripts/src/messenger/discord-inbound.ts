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

const OP_DISPATCH = 0;
const OP_HEARTBEAT = 1;
const OP_IDENTIFY = 2;
const OP_RESUME = 6;
const OP_RECONNECT = 7;
const OP_INVALID_SESSION = 9;
const OP_HELLO = 10;
const OP_HEARTBEAT_ACK = 11;

const EVENT_READY = "READY";
const EVENT_MESSAGE_CREATE = "MESSAGE_CREATE";

const DEFAULT_HEARTBEAT_MS = 41_250;
const MAX_SEEN = 500;

/** Discord's gateway rules, from its docs ("Rate Limiting" / "Gateway"): a client should wait
 * 1-5s (random) when told to reconnect, back off on repeated failures, and must not exceed 1000
 * RESUME/IDENTIFY attempts in 24h or the token is reset. Without this the bridge reconnected in a
 * tight loop and Discord reset the bot token (2026-11-08, robin). */
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 60_000;
const SESSION_START_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Stop well below Discord's ceiling so a burst can never reach it. */
const SESSION_START_LIMIT = 900;
/** A connection that lived at least this long counts as healthy and resets the backoff. */
const HEALTHY_SESSION_MS = 60_000;

/** Discord caps a messages page at 100; a long outage needs several of them. */
const BACKFILL_PAGE = 100;
/** 2,000 messages is a long outage; past that the run stops and says so rather than paging forever. */
const BACKFILL_MAX_PAGES = 20;

type GatewayPayload = {
  readonly op: number;
  readonly s?: number | null;
  readonly t?: string | null;
  readonly d?: Record<string, unknown> | null;
};

type MessageCreate = {
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

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;

/** Discord ids are snowflakes: a longer id is newer, and equal lengths compare as text. */
export const newerId = (a: string, b: string): string => {
  if (!a) return b;
  if (!b) return a;
  if (a.length !== b.length) return a.length > b.length ? a : b;
  return a >= b ? a : b;
};

const idOf = (data: unknown): string => {
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

const MAX_INBOUND_TEXT = 1500;

export const formatInbound = (i: Inbound): string =>
  `INBOUND discord ${i.source} ${i.channel} ${i.guild} ${i.messageId} ${i.author} ${JSON.stringify(i.text.slice(0, MAX_INBOUND_TEXT))}` +
  (i.mentions && i.mentions.length > 0 ? ` mentions=${i.mentions.join(",")}` : "") +
  (i.media && i.media.length > 0 ? ` media=${i.media.join(",")}` : "") +
  (i.replyToId
    ? ` reply_to=${i.replyToId}${i.replyToAuthor ? ` reply_author=${JSON.stringify(i.replyToAuthor)}` : ""}${
        i.replyToText ? ` reply_text=${JSON.stringify(i.replyToText)}` : ""
      }`
    : "");

export class DiscordInbound {
  private socket: GatewaySocket | null = null;
  private beat: unknown;
  private sequence: number | null = null;
  private sessionId: string | null = null;
  private acked = true;
  private stopped = false;
  /** Consecutive failed connects; drives the exponential backoff and resets on a healthy session. */
  private attempts = 0;
  /** When the current socket opened, so a long-lived session can reset the backoff. */
  private connectedAt = 0;
  /** Timestamps of RESUME/IDENTIFY sends, pruned to the trailing 24h window. */
  private sessionStarts: number[] = [];
  private restartTimer: unknown;
  private readonly seen = new Set<string>();
  private chain: Promise<void> = Promise.resolve();
  private cursorMap: Record<string, string> = {};
  private cursorWrite: Promise<void> = Promise.resolve();

  constructor(
    private readonly open: () => GatewaySocket,
    private readonly token: string,
    private readonly clock: Clock,
    private readonly selfId: string,
    private readonly onInbound: (i: Inbound) => void,
    private readonly onEvent: (line: string) => void = () => {},
    private readonly store: MediaStore | null = null,
    private readonly cursors: CursorStore | null = null,
    private readonly history: ChannelHistory | null = null,
    private readonly guildOf: ChannelGuild | null = null,
  ) {}

  start(): void {
    this.stopped = false;
    this.connect();
    this.backfill();
  }

  /** Resolves once every message dispatched so far has been reported, media and all, and the
   * cursor file has caught up — tests await this instead of sleeping. */
  async idle(): Promise<void> {
    for (;;) {
      const chain = this.chain;
      const write = this.cursorWrite;
      await Promise.all([chain, write]);
      if (chain === this.chain && write === this.cursorWrite) return;
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.beat !== undefined) this.clock.clearInterval(this.beat);
    this.beat = undefined;
    if (this.restartTimer !== undefined) {
      if (this.clock.clearTimeout) this.clock.clearTimeout(this.restartTimer);
      else clearTimeout(this.restartTimer as ReturnType<typeof setTimeout>);
      this.restartTimer = undefined;
    }
    this.socket?.close();
    this.socket = null;
  }

  private connect(): void {
    if (this.stopped) return;
    if (this.restartTimer !== undefined) {
      if (this.clock.clearTimeout) this.clock.clearTimeout(this.restartTimer);
      else clearTimeout(this.restartTimer as ReturnType<typeof setTimeout>);
      this.restartTimer = undefined;
    }
    this.connectedAt = this.tick();
    const socket = this.open();
    this.socket = socket;
    socket.onMessage((raw) => {
      if (this.stopped || this.socket !== socket) return;
      this.handle(raw);
    });
  }

  handle(raw: string): void {
    let payload: GatewayPayload;
    try {
      payload = JSON.parse(raw) as GatewayPayload;
    } catch {
      return;
    }
    if (typeof payload.s === "number") this.sequence = payload.s;

    if (payload.op === OP_HELLO) {
      this.startHeartbeat(payload.d);
      return;
    }
    if (payload.op === OP_HEARTBEAT_ACK) {
      this.acked = true;
      return;
    }
    if (payload.op === OP_HEARTBEAT) {
      this.send({ op: OP_HEARTBEAT, d: this.sequence });
      return;
    }
    if (payload.op === OP_RECONNECT) {
      this.onEvent("gateway asked to reconnect");
      this.reconnect();
      return;
    }
    if (payload.op === OP_INVALID_SESSION) {
      this.sessionId = null;
      this.sequence = null;
      this.onEvent("gateway invalidated the session");
      this.reconnect();
      return;
    }
    if (payload.op === OP_DISPATCH) this.handleDispatch(payload);
  }

  private handleDispatch(payload: GatewayPayload): void {
    if (payload.t === EVENT_READY) {
      const d = asRecord(payload.d);
      this.sessionId = typeof d?.["session_id"] === "string" ? d["session_id"] : null;
      this.onEvent("gateway ready");
      return;
    }
    if (payload.t !== EVENT_MESSAGE_CREATE) return;
    this.report(payload.d);
  }

  /** The one path a message takes, whether it arrived on the socket or from a backfill page.
   * Returns true when the message reached the caller. */
  private report(data: unknown, guildHint?: string | null): boolean {
    const inbound = toInbound(data, this.selfId, guildHint);
    if (!inbound) return false;
    if (this.seen.has(inbound.messageId)) return false;
    this.seen.add(inbound.messageId);
    if (this.seen.size > MAX_SEEN) {
      const oldest = this.seen.values().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    this.noteCursor(inbound.channel, inbound.messageId);
    this.deliver(inbound, mediaRefs(data));
    return true;
  }

  /** A restart identifies from scratch, so Discord replays nothing: whatever arrived while the
   * process was down is only reachable through the REST history, channel by channel. */
  private backfill(): void {
    const store = this.cursors;
    const history = this.history;
    if (!store || !history) return;
    this.chain = this.chain
      .then(async () => {
        let stored: InboundCursors;
        try {
          stored = await store.read();
        } catch (e) {
          this.onEvent(`cursor read failed: ${(e as Error).message}`);
          return;
        }
        this.cursorMap = { ...stored, ...this.cursorMap };
        for (const [channel, after] of Object.entries(this.cursorMap)) {
          if (!channel || !after) continue;
          await this.catchUp(channel, after);
        }
      })
      .catch((e) => this.onEvent(`backfill failed: ${(e as Error).message}`));
  }

  private async catchUp(channel: string, after: string): Promise<void> {
    const history = this.history;
    if (!history) return;
    let cursor = after;
    let fetched = 0;
    let delivered = 0;
    let truncated = false;
    let guild: string | null = null;
    try {
      guild = this.guildOf ? await this.guildOf(channel) : null;
    } catch (e) {
      this.onEvent(`guild lookup failed for ${channel}: ${(e as Error).message}`);
    }
    for (let page = 0; page < BACKFILL_MAX_PAGES; page++) {
      let rows: readonly unknown[];
      try {
        rows = await history(channel, cursor, BACKFILL_PAGE);
      } catch (e) {
        this.onEvent(`backfill stopped for ${channel}: ${(e as Error).message}`);
        break;
      }
      if (!Array.isArray(rows) || rows.length === 0) break;
      const ordered = [...rows].sort((a, b) => {
        const left = idOf(a);
        const right = idOf(b);
        if (!left || !right || left === right) return 0;
        return newerId(left, right) === left ? 1 : -1;
      });
      for (const row of ordered) {
        cursor = newerId(cursor, idOf(row));
        if (this.report(row, guild)) delivered++;
      }
      // The cursor means "everything up to here is handled", including the bot's own messages and
      // anything this run filtered, so the next restart does not fetch them again.
      this.noteCursor(channel, cursor);
      fetched += rows.length;
      if (rows.length < BACKFILL_PAGE) break;
      if (page === BACKFILL_MAX_PAGES - 1) truncated = true;
    }
    if (fetched > 0) {
      this.onEvent(
        `backfill fetched ${fetched} message(s) in ${channel}, delivered ${delivered}${truncated ? " (stopped at the page limit)" : ""}`,
      );
    }
  }

  /** Persisted per channel: a single global id would skip a quiet channel whose messages are older
   * than the busiest channel's newest one, and the skip is silent. */
  private noteCursor(channel: string, messageId: string): void {
    const store = this.cursors;
    if (!store || !channel || !messageId) return;
    const current = this.cursorMap[channel];
    const next = current === undefined ? messageId : newerId(current, messageId);
    if (next === current) return;
    this.cursorMap = { ...this.cursorMap, [channel]: next };
    const snapshot = this.cursorMap;
    this.cursorWrite = this.cursorWrite
      .then(() => store.write(snapshot))
      .catch((e) => this.onEvent(`cursor write failed: ${(e as Error).message}`));
  }

  /** Media is fetched off the socket's critical path, but one message at a time, so the lane sees
   * every image cache-warm and in the order the messages arrived. */
  private deliver(inbound: Inbound, refs: readonly MediaRef[]): void {
    const store = this.store;
    if (!store || refs.length === 0) {
      this.onInbound(inbound);
      return;
    }
    this.chain = this.chain
      .then(async () => {
        const media: string[] = [];
        for (const [index, ref] of refs.entries()) {
          try {
            media.push(...(await store.save(inbound.messageId, index, ref)));
          } catch (e) {
            this.onEvent(`media download failed: ${(e as Error).message}`);
          }
        }
        this.onInbound(media.length > 0 ? { ...inbound, media } : inbound);
      })
      .catch((e) => this.onEvent(`media queue failed: ${(e as Error).message}`));
  }

  private startHeartbeat(d: Record<string, unknown> | null | undefined): void {
    const interval = typeof d?.["heartbeat_interval"] === "number" ? d["heartbeat_interval"] : DEFAULT_HEARTBEAT_MS;
    if (this.beat !== undefined) this.clock.clearInterval(this.beat);
    this.acked = true;
    this.beat = this.clock.setInterval(() => {
      if (!this.acked) {
        this.onEvent("gateway missed a heartbeat ack; reconnecting");
        this.reconnect();
        return;
      }
      this.acked = false;
      this.send({ op: OP_HEARTBEAT, d: this.sequence });
    }, interval);
    this.send({ op: OP_HEARTBEAT, d: this.sequence });
    this.acked = false;
    this.identify();
  }

  private identify(): void {
    if (!this.allowSessionStart()) return;
    if (this.sessionId !== null && this.sequence !== null) {
      this.send({
        op: OP_RESUME,
        d: { token: this.token, session_id: this.sessionId, seq: this.sequence },
      });
      return;
    }
    this.send({
      op: OP_IDENTIFY,
      d: {
        token: this.token,
        intents: DISCORD_INBOUND_INTENTS,
        properties: { os: process.platform, browser: "dori", device: "dori" },
      },
    });
  }

  /** Wall clock in ms; falls back to Date.now so a test clock without `now` still works. */
  private tick(): number {
    return this.clock.now ? this.clock.now() : Date.now();
  }

  /** Record a session start (RESUME or IDENTIFY) and refuse once the 24h budget is spent. */
  private allowSessionStart(): boolean {
    const now = this.tick();
    const cutoff = now - SESSION_START_WINDOW_MS;
    this.sessionStarts = this.sessionStarts.filter((t) => t > cutoff);
    if (this.sessionStarts.length >= SESSION_START_LIMIT) {
      this.onEvent(
        `gateway session-start budget spent (${this.sessionStarts.length}/${SESSION_START_LIMIT} in 24h); stopping instead of risking a token reset`,
      );
      this.stop();
      return false;
    }
    this.sessionStarts.push(now);
    return true;
  }

  /** Exponential backoff: 1s, 2s, 4s … capped at 60s, with jitter so restarts never sync up.
   * A session that stayed up for HEALTHY_SESSION_MS resets the count. */
  private nextDelayMs(): number {
    const lived = this.connectedAt === 0 ? 0 : this.tick() - this.connectedAt;
    if (lived >= HEALTHY_SESSION_MS) this.attempts = 0;
    const base = Math.min(RECONNECT_BASE_MS * 2 ** Math.min(this.attempts, 6), RECONNECT_MAX_MS);
    this.attempts += 1;
    const jitter = base * 0.2 * Math.random();
    return Math.round(base + jitter);
  }

  private reconnect(): void {
    if (this.stopped) return;
    if (this.beat !== undefined) this.clock.clearInterval(this.beat);
    this.beat = undefined;
    this.socket?.close();
    this.socket = null;
    if (this.restartTimer !== undefined) return;
    const delay = this.nextDelayMs();
    if (this.attempts > 1) this.onEvent(`gateway reconnect in ${delay}ms (attempt ${this.attempts})`);
    const fire = () => {
      this.restartTimer = undefined;
      if (this.stopped) return;
      this.connect();
    };
    this.restartTimer = this.clock.setTimeout ? this.clock.setTimeout(fire, delay) : setTimeout(fire, delay);
  }

  private send(payload: Record<string, unknown>): void {
    try {
      this.socket?.send(JSON.stringify(payload));
    } catch (e) {
      this.onEvent(`gateway send failed: ${(e as Error).message}`);
    }
  }
}
