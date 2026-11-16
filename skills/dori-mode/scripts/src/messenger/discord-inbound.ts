import {
  backfillDeps,
  catchUpDeps,
  connectDeps,
  frameDeps,
  heartbeatDeps,
  helloDeps,
  lifecycleDeps,
  reconnectDeps,
  reportDeps,
  type ReceiverState,
} from "./discord-deps.ts";
import { catchUp } from "./discord-catchup.ts";
import { noteCursor } from "./discord-cursor.ts";
import { deliver } from "./discord-deliver.ts";
import { handle, handleDispatch } from "./discord-frames.ts";
import { identify, startHeartbeat } from "./discord-heartbeat.ts";
import { armHelloWait, clearHelloWait } from "./discord-hello.ts";
import { idle, start, stop } from "./discord-lifecycle.ts";
import { backfill, report } from "./discord-report.ts";
import { clearPendingReconnect, reconnect, scheduleReconnect, sendPayload } from "./discord-reconnect.ts";
import { connect } from "./discord-socket.ts";
import {
  RECONNECT_BACKOFF_CAP_MS,
  RECONNECT_MAX_MS,
  RECONNECT_MIN_MS,
  type GatewayPayload,
} from "./discord-gateway.ts";
import type { MediaRef } from "./discord-media.ts";
import type {
  ChannelGuild,
  ChannelHistory,
  Clock,
  CursorStore,
  GatewaySocket,
  Inbound,
  MediaStore,
} from "./discord-types.ts";

export { formatInbound } from "./discord-record.ts";
export { HELLO_WAIT_MS } from "./discord-gateway.ts";

export type {
  ChannelGuild,
  ChannelHistory,
  Clock,
  CursorStore,
  GatewaySocket,
  Inbound,
  InboundCursors,
  MediaRef,
  MediaStore,
} from "./discord-types.ts";

export class DiscordInbound {
  public socket: GatewaySocket | null = null;
  public beat: unknown;
  public hello: unknown;
  /** Bumped on every arm/clear so a callback already queued by the timer cannot act on a later socket. */
  public helloWait = 0;
  public sequence: number | null = null;
  public sessionId: string | null = null;
  public acked = true;
  public stopped = false;
  public readonly seen = new Set<string>();
  public chain: Promise<void> = Promise.resolve();
  /** Every line goes out through here, one at a time: arrival order, print order and cursor order
   * stay the same, which is what lets the cursor mean "everything up to this id has been printed". */
  public deliveries: Promise<void> = Promise.resolve();
  public cursorMap: Record<string, string> = {};
  public cursorWrite: Promise<void> = Promise.resolve();
  public readonly caughtUp = new Set<string>();
  public reconnects = 0;
  public pendingReconnect: unknown;

  constructor(
    public readonly open: () => GatewaySocket,
    public readonly token: string,
    public readonly clock: Clock,
    public readonly selfId: string,
    public readonly onInbound: (i: Inbound) => void,
    public readonly onEvent: (line: string) => void = () => {},
    public readonly store: MediaStore | null = null,
    public readonly cursors: CursorStore | null = null,
    public readonly history: ChannelHistory | null = null,
    public readonly guildOf: ChannelGuild | null = null,
  ) {}

  start(): void {
    start(lifecycleDeps(this.state()));
  }

  async idle(): Promise<void> {
    await idle(lifecycleDeps(this.state()));
  }

  stop(): void {
    stop(lifecycleDeps(this.state()));
  }

  handle(raw: string): void {
    handle(frameDeps(this.state()), raw);
  }

  public connect(): void {
    connect(connectDeps(this.state()));
  }

  public armHelloWait(socket: GatewaySocket): void {
    armHelloWait(helloDeps(this.state()), socket);
  }

  public clearHelloWait(): void {
    clearHelloWait(helloDeps(this.state()));
  }

  public handleDispatch(payload: GatewayPayload): void {
    handleDispatch(frameDeps(this.state()), payload);
  }

  public report(data: unknown, guildHint?: string | null): Promise<boolean> | null {
    return report(reportDeps(this.state()), data, guildHint);
  }

  public backfill(): void {
    backfill(backfillDeps(this.state()));
  }

  public catchUp(channel: string, after: string): Promise<void> {
    return catchUp(catchUpDeps(this.state()), channel, after);
  }

  public noteCursor(channel: string, messageId: string): void {
    const next = noteCursor(this.cursors, this.cursorMap, this.cursorWrite, channel, messageId, this.onEvent);
    this.cursorMap = next.cursorMap;
    this.cursorWrite = next.cursorWrite;
  }

  public deliver(inbound: Inbound, refs: readonly MediaRef[]): Promise<void> {
    const job = deliver(this.deliveries, this.store, inbound, refs, this.onInbound, this.onEvent);
    this.deliveries = job.catch(() => {});
    return job;
  }

  public startHeartbeat(payload: Record<string, unknown> | null | undefined): void {
    startHeartbeat(heartbeatDeps(this.state()), payload);
  }

  public identify(): void {
    identify(heartbeatDeps(this.state()));
  }

  public clearBeat(): void {
    if (this.beat !== undefined) this.clock.clearInterval(this.beat);
    this.beat = undefined;
  }

  public reconnect(): void {
    reconnect(reconnectDeps(this.state()));
  }

  public scheduleReconnect(): void {
    scheduleReconnect(reconnectDeps(this.state()), RECONNECT_MIN_MS, RECONNECT_MAX_MS, RECONNECT_BACKOFF_CAP_MS);
  }

  public clearPendingReconnect(): void {
    clearPendingReconnect(reconnectDeps(this.state()));
  }

  public send(payload: Record<string, unknown>): void {
    sendPayload(reconnectDeps(this.state()), payload);
  }

  private state(): ReceiverState {
    return this as unknown as ReceiverState;
  }
}
