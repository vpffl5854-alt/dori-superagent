/**
 * The Discord gateway: a socket that reports every message, and a backfill that fetches what arrived while it was
 * down. The socket's own work is `discord-gateway-socket.ts`; the message shape and the inbound log line come from
 * `discord-message.ts`; the gateway's types and budgets from `discord-gateway.ts`.
 */
import type {
  ChannelGuild,
  ChannelHistory,
  Clock,
  CursorStore,
  GatewaySocket,
  Inbound,
  InboundCursors,
  MediaRef,
  MediaStore,
} from "./discord-gateway.ts";
import { BACKFILL_MAX_PAGES, BACKFILL_PAGE, MAX_SEEN } from "./discord-gateway.ts";
import { type GatewayHost, type GatewaySocketLoop, gatewaySocketLoop } from "./discord-gateway-socket.ts";
import { idOf, mediaRefs, newerId, toInbound } from "./discord-message.ts";

export class DiscordInbound implements GatewayHost {
  socket: GatewaySocket | null = null;
  beat: unknown = undefined;
  sequence: number | null = null;
  sessionId: string | null = null;
  acked = true;
  stopped = false;
  /** Consecutive failed connects; drives the exponential backoff and resets on a healthy session. */
  attempts = 0;
  /** When the current socket opened, so a long-lived session can reset the backoff. */
  connectedAt = 0;
  /** Timestamps of RESUME/IDENTIFY sends, pruned to the trailing 24h window. */
  sessionStarts: number[] = [];
  restartTimer: unknown = undefined;
  private readonly seen = new Set<string>();
  private chain: Promise<void> = Promise.resolve();
  private cursorMap: Record<string, string> = {};
  private cursorWrite: Promise<void> = Promise.resolve();
  private readonly socketLoop: GatewaySocketLoop;

  constructor(
    readonly open: () => GatewaySocket,
    readonly token: string,
    readonly clock: Clock,
    private readonly selfId: string,
    private readonly onInbound: (i: Inbound) => void,
    readonly onEvent: (line: string) => void = () => {},
    private readonly store: MediaStore | null = null,
    private readonly cursors: CursorStore | null = null,
    private readonly history: ChannelHistory | null = null,
    private readonly guildOf: ChannelGuild | null = null,
  ) {
    this.socketLoop = gatewaySocketLoop(this);
  }

  start(): void {
    this.socketLoop.start();
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
    this.socketLoop.stop();
  }

  handle(raw: string): void {
    this.socketLoop.handle(raw);
  }

  /** The one path a message takes, whether it arrived on the socket or from a backfill page.
   * Returns true when the message reached the caller. */
  report(data: unknown, guildHint?: string | null): boolean {
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
}
