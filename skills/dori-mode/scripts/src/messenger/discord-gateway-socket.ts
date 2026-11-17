/**
 * The gateway socket's own work, as a mixin: connecting, reading the payloads, heartbeats, identify/resume and the
 * reconnect backoff. `DiscordInbound` adds the backfill and media; this file only knows the socket.
 */
import type { Clock, GatewayPayload, GatewaySocket } from "./discord-gateway.ts";
import {
  DEFAULT_HEARTBEAT_MS,
  DISCORD_INBOUND_INTENTS,
  EVENT_MESSAGE_CREATE,
  EVENT_READY,
  HEALTHY_SESSION_MS,
  OP_DISPATCH,
  OP_HEARTBEAT,
  OP_HEARTBEAT_ACK,
  OP_HELLO,
  OP_IDENTIFY,
  OP_INVALID_SESSION,
  OP_RECONNECT,
  OP_RESUME,
  RECONNECT_BASE_MS,
  RECONNECT_MAX_MS,
  SESSION_START_LIMIT,
  SESSION_START_WINDOW_MS,
} from "./discord-gateway.ts";
import { asRecord } from "./discord-message.ts";

export type GatewayState = {
  socket: GatewaySocket | null;
  beat: unknown;
  sequence: number | null;
  sessionId: string | null;
  acked: boolean;
  stopped: boolean;
  attempts: number;
  connectedAt: number;
  sessionStarts: number[];
  restartTimer: unknown;
};

export type GatewayWiring = {
  readonly open: () => GatewaySocket;
  readonly token: string;
  readonly clock: Clock;
  readonly onEvent: (line: string) => void;
};

export type GatewayHost = GatewayState & GatewayWiring & { report(data: unknown): boolean };

export const gatewaySocketLoop = (host: GatewayHost): GatewaySocketLoop =>
  new GatewaySocketLoop(host, host, (d) => host.report(d));

export class GatewaySocketLoop {
  constructor(
    readonly state: GatewayState,
    readonly wiring: GatewayWiring,
    readonly onMessage: (data: unknown) => boolean,
  ) {}

  start(): void {
    this.state.stopped = false;
    this.connect();
  }

  stop(): void {
    const s = this.state;
    s.stopped = true;
    if (s.beat !== undefined) this.wiring.clock.clearInterval(s.beat);
    s.beat = undefined;
    if (s.restartTimer !== undefined) {
      if (this.wiring.clock.clearTimeout) this.wiring.clock.clearTimeout(s.restartTimer);
      else clearTimeout(s.restartTimer as ReturnType<typeof setTimeout>);
      s.restartTimer = undefined;
    }
    s.socket?.close();
    s.socket = null;
  }

  handle(raw: string): void {
    let payload: GatewayPayload;
    try {
      payload = JSON.parse(raw) as GatewayPayload;
    } catch {
      return;
    }
    if (typeof payload.s === "number") this.state.sequence = payload.s;

    if (payload.op === OP_HELLO) {
      this.startHeartbeat(payload.d);
      return;
    }
    if (payload.op === OP_HEARTBEAT_ACK) {
      this.state.acked = true;
      return;
    }
    if (payload.op === OP_HEARTBEAT) {
      this.send({ op: OP_HEARTBEAT, d: this.state.sequence });
      return;
    }
    if (payload.op === OP_RECONNECT) {
      this.wiring.onEvent("gateway asked to reconnect");
      this.reconnect();
      return;
    }
    if (payload.op === OP_INVALID_SESSION) {
      this.state.sessionId = null;
      this.state.sequence = null;
      this.wiring.onEvent("gateway invalidated the session");
      this.reconnect();
      return;
    }
    if (payload.op === OP_DISPATCH) this.handleDispatch(payload);
  }

  private handleDispatch(payload: GatewayPayload): void {
    if (payload.t === EVENT_READY) {
      const d = asRecord(payload.d);
      this.state.sessionId = typeof d?.["session_id"] === "string" ? d["session_id"] : null;
      this.wiring.onEvent("gateway ready");
      return;
    }
    if (payload.t !== EVENT_MESSAGE_CREATE) return;
    this.onMessage(payload.d);
  }

  private connect(): void {
    const s = this.state;
    if (s.stopped) return;
    if (s.restartTimer !== undefined) {
      if (this.wiring.clock.clearTimeout) this.wiring.clock.clearTimeout(s.restartTimer);
      else clearTimeout(s.restartTimer as ReturnType<typeof setTimeout>);
      s.restartTimer = undefined;
    }
    s.connectedAt = this.tick();
    const socket = this.wiring.open();
    s.socket = socket;
    socket.onMessage((raw) => {
      if (s.stopped || s.socket !== socket) return;
      this.handle(raw);
    });
  }

  private startHeartbeat(d: Record<string, unknown> | null | undefined): void {
    const s = this.state;
    const interval = typeof d?.["heartbeat_interval"] === "number" ? d["heartbeat_interval"] : DEFAULT_HEARTBEAT_MS;
    if (s.beat !== undefined) this.wiring.clock.clearInterval(s.beat);
    s.acked = true;
    s.beat = this.wiring.clock.setInterval(() => {
      if (!s.acked) {
        this.wiring.onEvent("gateway missed a heartbeat ack; reconnecting");
        this.reconnect();
        return;
      }
      s.acked = false;
      this.send({ op: OP_HEARTBEAT, d: s.sequence });
    }, interval);
    this.send({ op: OP_HEARTBEAT, d: s.sequence });
    s.acked = false;
    this.identify();
  }

  private identify(): void {
    const s = this.state;
    if (!this.allowSessionStart()) return;
    if (s.sessionId !== null && s.sequence !== null) {
      this.send({ op: OP_RESUME, d: { token: this.wiring.token, session_id: s.sessionId, seq: s.sequence } });
      return;
    }
    this.send({
      op: OP_IDENTIFY,
      d: {
        token: this.wiring.token,
        intents: DISCORD_INBOUND_INTENTS,
        properties: { os: process.platform, browser: "dori", device: "dori" },
      },
    });
  }

  private tick(): number {
    return this.wiring.clock.now ? this.wiring.clock.now() : Date.now();
  }

  private allowSessionStart(): boolean {
    const s = this.state;
    const now = this.tick();
    const cutoff = now - SESSION_START_WINDOW_MS;
    s.sessionStarts = s.sessionStarts.filter((t) => t > cutoff);
    if (s.sessionStarts.length >= SESSION_START_LIMIT) {
      this.wiring.onEvent(
        `gateway session-start budget spent (${s.sessionStarts.length}/${SESSION_START_LIMIT} in 24h); stopping instead of risking a token reset`,
      );
      this.stop();
      return false;
    }
    s.sessionStarts.push(now);
    return true;
  }

  private nextDelayMs(): number {
    const s = this.state;
    const lived = s.connectedAt === 0 ? 0 : this.tick() - s.connectedAt;
    if (lived >= HEALTHY_SESSION_MS) s.attempts = 0;
    const base = Math.min(RECONNECT_BASE_MS * 2 ** Math.min(s.attempts, 6), RECONNECT_MAX_MS);
    s.attempts += 1;
    const jitter = base * 0.2 * Math.random();
    return Math.round(base + jitter);
  }

  private reconnect(): void {
    const s = this.state;
    if (s.stopped) return;
    if (s.beat !== undefined) this.wiring.clock.clearInterval(s.beat);
    s.beat = undefined;
    s.socket?.close();
    s.socket = null;
    if (s.restartTimer !== undefined) return;
    const delay = this.nextDelayMs();
    if (s.attempts > 1) this.wiring.onEvent(`gateway reconnect in ${delay}ms (attempt ${s.attempts})`);
    const fire = () => {
      s.restartTimer = undefined;
      if (s.stopped) return;
      this.connect();
    };
    s.restartTimer = this.wiring.clock.setTimeout ? this.wiring.clock.setTimeout(fire, delay) : setTimeout(fire, delay);
  }

  private send(payload: Record<string, unknown>): void {
    try {
      this.state.socket?.send(JSON.stringify(payload));
    } catch (e) {
      this.wiring.onEvent(`gateway send failed: ${(e as Error).message}`);
    }
  }
}
