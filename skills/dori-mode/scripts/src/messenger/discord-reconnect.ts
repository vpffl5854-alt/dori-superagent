/** Reconnect policy: how long to wait after a close, and how a payload goes out. */
import type { Clock, GatewaySocket } from "./discord-types.ts";

/** The fields the reconnect schedule and the send path read and write on the receiver. */
export type ReconnectDeps = {
  readonly clock: Clock;
  readonly stopped: () => boolean;
  readonly socket: () => GatewaySocket | null;
  readonly setSocket: (s: GatewaySocket | null) => void;
  readonly reconnects: () => number;
  readonly setReconnects: (n: number) => void;
  readonly pendingReconnect: () => unknown;
  readonly setPendingReconnect: (h: unknown) => void;
  readonly clearHelloWait: () => void;
  readonly clearBeat: () => void;
  readonly connect: () => void;
  readonly onEvent: (line: string) => void;
  readonly scheduleReconnect: () => void;
};

export const reconnectDelay = (reconnects: number, minMs: number, maxMs: number, capMs: number): number => {
  const span = maxMs - minMs;
  const base = minMs + Math.floor(Math.random() * (span + 1));
  return Math.min(base * 2 ** Math.min(reconnects, 6), capMs);
};

export const reconnect = (d: ReconnectDeps): void => {
  if (d.stopped()) return;
  d.clearHelloWait();
  d.clearBeat();
  d.socket()?.close();
  d.setSocket(null);
  d.scheduleReconnect();
};

export const scheduleReconnect = (d: ReconnectDeps, minMs: number, maxMs: number, capMs: number): void => {
  if (d.stopped()) return;
  clearPendingReconnect(d);
  const delay = reconnectDelay(d.reconnects(), minMs, maxMs, capMs);
  d.setReconnects(d.reconnects() + 1);
  const fire = () => {
    d.setPendingReconnect(undefined);
    d.connect();
  };
  if (d.clock.setTimeout) d.setPendingReconnect(d.clock.setTimeout(fire, delay));
  else fire();
};

export const clearPendingReconnect = (d: ReconnectDeps): void => {
  const pending = d.pendingReconnect();
  if (pending === undefined) return;
  d.clock.clearTimeout?.(pending);
  d.setPendingReconnect(undefined);
};

export const sendPayload = (d: ReconnectDeps, payload: Record<string, unknown>): void => {
  try {
    d.socket()?.send(JSON.stringify(payload));
  } catch (e) {
    d.onEvent(`gateway send failed: ${(e as Error).message}`);
  }
};
