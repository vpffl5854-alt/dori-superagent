/** The adapters from the receiver's fields to the protocol modules' dependency objects. */
import type { GatewayPayload } from "./discord-gateway.ts";
import type { CatchUpDeps } from "./discord-catchup.ts";
import type { BackfillDeps, ReportDeps } from "./discord-report.ts";
import type { ConnectDeps } from "./discord-socket.ts";
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
import type { FrameDeps } from "./discord-frames.ts";
import type { HeartbeatDeps } from "./discord-heartbeat.ts";
import type { HelloDeps } from "./discord-hello.ts";
import type { LifecycleDeps } from "./discord-lifecycle.ts";
import type { ReconnectDeps } from "./discord-reconnect.ts";

/** The mutable state the adapters read and write; the receiver owns it. */
export type ReceiverState = {
  socket: GatewaySocket | null;
  beat: unknown;
  hello: unknown;
  helloWait: number;
  sequence: number | null;
  sessionId: string | null;
  acked: boolean;
  stopped: boolean;
  seen: Set<string>;
  chain: Promise<void>;
  deliveries: Promise<void>;
  cursorMap: Record<string, string>;
  cursorWrite: Promise<void>;
  caughtUp: Set<string>;
  reconnects: number;
  pendingReconnect: unknown;
  open: () => GatewaySocket;
  token: string;
  clock: Clock;
  selfId: string;
  onInbound: (i: Inbound) => void;
  onEvent: (line: string) => void;
  store: MediaStore | null;
  cursors: CursorStore | null;
  history: ChannelHistory | null;
  guildOf: ChannelGuild | null;
  handle: (raw: string) => void;
  stop: () => void;
  connect: () => void;
  backfill: () => void;
  clearHelloWait: () => void;
  clearPendingReconnect: () => void;
  clearBeat: () => void;
  armHelloWait: (socket: GatewaySocket) => void;
  reconnect: () => void;
  scheduleReconnect: () => void;
  send: (payload: Record<string, unknown>) => void;
  startHeartbeat: (payload: Record<string, unknown> | null | undefined) => void;
  identify: () => void;
  handleDispatch: (payload: GatewayPayload) => void;
  report: (data: unknown, guildHint?: string | null) => Promise<boolean> | null;
  deliver: (inbound: Inbound, refs: readonly MediaRef[]) => Promise<void>;
  noteCursor: (channel: string, messageId: string) => void;
  catchUp: (channel: string, after: string) => Promise<void>;
  start: () => void;
  idle: () => Promise<void>;
};

export const lifecycleDeps = (state: ReceiverState): LifecycleDeps => {
  return {
    setStopped: (v) => {
      state.stopped = v;
    },
    caughtUp: state.caughtUp,
    connect: () => state.connect(),
    backfill: () => state.backfill(),
    clearHelloWait: () => state.clearHelloWait(),
    clearPendingReconnect: () => state.clearPendingReconnect(),
    clearBeat: () => state.clearBeat(),
    socket: () => state.socket,
    setSocket: (s) => {
      state.socket = s;
    },
    chain: () => state.chain,
    deliveries: () => state.deliveries,
    cursorWrite: () => state.cursorWrite,
  };
};

export const helloDeps = (state: ReceiverState): HelloDeps => {
  return {
    clock: state.clock,
    stopped: () => state.stopped,
    socket: () => state.socket,
    helloWait: () => state.helloWait,
    bumpHelloWait: () => {
      state.helloWait++;
    },
    hello: () => state.hello,
    setHello: (h) => {
      state.hello = h;
    },
    onEvent: state.onEvent,
    reconnect: () => state.reconnect(),
    clearHelloWait: () => state.clearHelloWait(),
  };
};

export const frameDeps = (state: ReceiverState): FrameDeps => {
  return {
    sequence: () => state.sequence,
    setSequence: (s) => {
      state.sequence = s;
    },
    sessionId: () => state.sessionId,
    setSessionId: (s) => {
      state.sessionId = s;
    },
    acked: () => state.acked,
    setAcked: (v) => {
      state.acked = v;
    },
    reconnects: () => state.reconnects,
    setReconnects: (n) => {
      state.reconnects = n;
    },
    clearHelloWait: () => state.clearHelloWait(),
    startHeartbeat: (payload) => state.startHeartbeat(payload),
    send: (payload) => state.send(payload),
    onEvent: state.onEvent,
    reconnect: () => state.reconnect(),
    handleDispatch: (payload) => state.handleDispatch(payload),
    backfill: () => state.backfill(),
    report: (data) => state.report(data),
  };
};

export const heartbeatDeps = (state: ReceiverState): HeartbeatDeps => {
  return {
    clock: state.clock,
    beat: () => state.beat,
    setBeat: (h) => {
      state.beat = h;
    },
    acked: () => state.acked,
    setAcked: (v) => {
      state.acked = v;
    },
    sequence: () => state.sequence,
    sessionId: () => state.sessionId,
    token: state.token,
    send: (payload) => state.send(payload),
    onEvent: state.onEvent,
    reconnect: () => state.reconnect(),
    identify: () => state.identify(),
  };
};

export const reportDeps = (state: ReceiverState): ReportDeps => {
  return {
    selfId: state.selfId,
    seen: state.seen,
    caughtUp: state.caughtUp,
    deliver: (inbound, refs) => state.deliver(inbound, refs),
    noteCursor: (channel, messageId) => state.noteCursor(channel, messageId),
    onEvent: state.onEvent,
  };
};

export const reconnectDeps = (state: ReceiverState): ReconnectDeps => {
  return {
    clock: state.clock,
    stopped: () => state.stopped,
    socket: () => state.socket,
    setSocket: (s) => {
      state.socket = s;
    },
    reconnects: () => state.reconnects,
    setReconnects: (n) => {
      state.reconnects = n;
    },
    pendingReconnect: () => state.pendingReconnect,
    setPendingReconnect: (h) => {
      state.pendingReconnect = h;
    },
    clearHelloWait: () => state.clearHelloWait(),
    clearBeat: () => state.clearBeat(),
    connect: () => state.connect(),
    onEvent: state.onEvent,
    scheduleReconnect: () => state.scheduleReconnect(),
  };
};

export const connectDeps = (state: ReceiverState): ConnectDeps => {
  return {
    stopped: () => state.stopped,
    open: state.open,
    socket: () => state.socket,
    setSocket: (s) => {
      state.socket = s;
    },
    handle: (raw) => state.handle(raw),
    onEvent: state.onEvent,
    stop: () => state.stop(),
    reconnect: () => state.reconnect(),
    armHelloWait: (socket) => state.armHelloWait(socket),
  };
};

export const backfillDeps = (state: ReceiverState): BackfillDeps => {
  return {
    ...reportDeps(state),
    cursors: state.cursors,
    history: state.history,
    cursorMap: () => state.cursorMap,
    setCursorMap: (map) => {
      state.cursorMap = map;
    },
    chain: () => state.chain,
    setChain: (p) => {
      state.chain = p;
    },
    catchUp: (channel, after) => state.catchUp(channel, after),
  };
};

export const catchUpDeps = (state: ReceiverState): CatchUpDeps => {
  return {
    history: state.history,
    guildOf: state.guildOf,
    report: (data, hint) => state.report(data, hint),
    noteCursor: (channel, messageId) => state.noteCursor(channel, messageId),
    onEvent: state.onEvent,
    caughtUp: state.caughtUp,
  };
};
