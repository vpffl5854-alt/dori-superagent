/** The heartbeat after HELLO: a missed ack reconnects; the first one also identifies or resumes. */
import {
  DEFAULT_HEARTBEAT_MS,
  DISCORD_INBOUND_INTENTS,
  OP_HEARTBEAT,
  OP_IDENTIFY,
  OP_RESUME,
} from "./discord-gateway.ts";
import type { Clock } from "./discord-types.ts";

/** The fields the heartbeat reads and writes on the receiver. */
export type HeartbeatDeps = {
  readonly clock: Clock;
  readonly beat: () => unknown;
  readonly setBeat: (h: unknown) => void;
  readonly acked: () => boolean;
  readonly setAcked: (v: boolean) => void;
  readonly sequence: () => number | null;
  readonly sessionId: () => string | null;
  readonly token: string;
  readonly send: (payload: Record<string, unknown>) => void;
  readonly onEvent: (line: string) => void;
  readonly reconnect: () => void;
  readonly identify: () => void;
};

export const startHeartbeat = (d: HeartbeatDeps, payload: Record<string, unknown> | null | undefined): void => {
  const interval =
    typeof payload?.["heartbeat_interval"] === "number" ? payload["heartbeat_interval"] : DEFAULT_HEARTBEAT_MS;
  if (d.beat() !== undefined) d.clock.clearInterval(d.beat());
  d.setAcked(true);
  d.setBeat(
    d.clock.setInterval(() => {
      if (!d.acked()) {
        d.onEvent("gateway missed a heartbeat ack; reconnecting");
        d.reconnect();
        return;
      }
      d.setAcked(false);
      d.send({ op: OP_HEARTBEAT, d: d.sequence() });
    }, interval),
  );
  d.send({ op: OP_HEARTBEAT, d: d.sequence() });
  d.setAcked(false);
  d.identify();
};

/** Resume when the session can be resumed; otherwise a fresh identify with the inbound intents. */
export const identify = (d: HeartbeatDeps): void => {
  if (d.sessionId() !== null && d.sequence() !== null) {
    d.send({
      op: OP_RESUME,
      d: { token: d.token, session_id: d.sessionId(), seq: d.sequence() },
    });
    return;
  }
  d.send({
    op: OP_IDENTIFY,
    d: {
      token: d.token,
      intents: DISCORD_INBOUND_INTENTS,
      properties: { os: process.platform, browser: "dori", device: "dori" },
    },
  });
};
