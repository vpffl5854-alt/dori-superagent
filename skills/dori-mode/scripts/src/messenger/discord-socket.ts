/** The socket lifecycle: open, route frames to handle, and reconnect (or stop) on close. */
import { FATAL_CLOSE_CODES } from "./discord-gateway.ts";
import type { GatewaySocket } from "./discord-types.ts";

/** What connect needs from the receiver. */
export type ConnectDeps = {
  readonly stopped: () => boolean;
  readonly open: () => GatewaySocket;
  readonly socket: () => GatewaySocket | null;
  readonly setSocket: (s: GatewaySocket | null) => void;
  readonly handle: (raw: string) => void;
  readonly onEvent: (line: string) => void;
  readonly stop: () => void;
  readonly reconnect: () => void;
  readonly armHelloWait: (socket: GatewaySocket) => void;
};

export const connect = (d: ConnectDeps): void => {
  if (d.stopped()) return;
  const socket = d.open();
  d.setSocket(socket);
  socket.onMessage((raw) => {
    if (d.stopped() || d.socket() !== socket) return;
    d.handle(raw);
  });
  socket.onClose?.((code, reason) => {
    if (d.stopped() || d.socket() !== socket) return;
    if (FATAL_CLOSE_CODES.has(code)) {
      d.onEvent(`gateway closed with ${code} (${reason || "no reason"}); not reconnecting`);
      d.stop();
      return;
    }
    d.onEvent(`gateway closed with ${code} (${reason || "no reason"}); reconnecting`);
    d.reconnect();
  });
  d.armHelloWait(socket);
};
