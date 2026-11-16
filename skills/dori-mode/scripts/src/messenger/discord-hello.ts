/** Discord sends HELLO as the first frame on every connection. Without this timer a socket that
 * connects and then goes silent is indistinguishable from a quiet channel: no heartbeat, no ack
 * watch, no reconnect, forever. */
import { HELLO_WAIT_MS } from "./discord-gateway.ts";
import type { Clock, GatewaySocket } from "./discord-types.ts";

/** The fields the HELLO watch reads and writes on the receiver. */
export type HelloDeps = {
  readonly clock: Clock;
  readonly stopped: () => boolean;
  readonly socket: () => GatewaySocket | null;
  readonly helloWait: () => number;
  readonly bumpHelloWait: () => void;
  readonly hello: () => unknown;
  readonly setHello: (h: unknown) => void;
  readonly onEvent: (line: string) => void;
  readonly reconnect: () => void;
  readonly clearHelloWait: () => void;
};

export const armHelloWait = (d: HelloDeps, socket: GatewaySocket): void => {
  d.clearHelloWait();
  const wait = d.helloWait();
  d.setHello(
    d.clock.setInterval(() => {
      if (d.stopped() || d.socket() !== socket || wait !== d.helloWait()) return;
      d.clearHelloWait();
      d.onEvent(`gateway sent no HELLO within ${HELLO_WAIT_MS / 1000}s; reconnecting`);
      d.reconnect();
    }, HELLO_WAIT_MS),
  );
};

export const clearHelloWait = (d: HelloDeps): void => {
  d.bumpHelloWait();
  const h = d.hello();
  if (h !== undefined) d.clock.clearInterval(h);
  d.setHello(undefined);
};
