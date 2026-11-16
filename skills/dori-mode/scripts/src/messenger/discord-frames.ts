/** Gateway frames: the opcode switch, and the dispatch of READY and MESSAGE_CREATE. */
import {
  EVENT_MESSAGE_CREATE,
  EVENT_READY,
  OP_DISPATCH,
  OP_HEARTBEAT,
  OP_HEARTBEAT_ACK,
  OP_HELLO,
  OP_INVALID_SESSION,
  OP_RECONNECT,
  type GatewayPayload,
} from "./discord-gateway.ts";
import { asRecord } from "./discord-record.ts";

/** The fields the frame switch reads and writes on the receiver. */
export type FrameDeps = {
  readonly sequence: () => number | null;
  readonly setSequence: (s: number | null) => void;
  readonly sessionId: () => string | null;
  readonly setSessionId: (s: string | null) => void;
  readonly acked: () => boolean;
  readonly setAcked: (v: boolean) => void;
  readonly reconnects: () => number;
  readonly setReconnects: (n: number) => void;
  readonly clearHelloWait: () => void;
  readonly startHeartbeat: (payload: Record<string, unknown> | null | undefined) => void;
  readonly send: (payload: Record<string, unknown>) => void;
  readonly onEvent: (line: string) => void;
  readonly reconnect: () => void;
  readonly handleDispatch: (payload: GatewayPayload) => void;
  readonly backfill: () => void;
  readonly report: (data: unknown) => Promise<boolean> | null;
};

export const handle = (d: FrameDeps, raw: string): void => {
  let payload: GatewayPayload;
  try {
    payload = JSON.parse(raw) as GatewayPayload;
  } catch {
    return;
  }
  if (typeof payload.s === "number") d.setSequence(payload.s);

  if (payload.op === OP_HELLO) {
    d.clearHelloWait();
    d.startHeartbeat(payload.d);
    return;
  }
  if (payload.op === OP_HEARTBEAT_ACK) {
    d.setAcked(true);
    return;
  }
  if (payload.op === OP_HEARTBEAT) {
    d.send({ op: OP_HEARTBEAT, d: d.sequence() });
    return;
  }
  if (payload.op === OP_RECONNECT) {
    d.onEvent("gateway asked to reconnect");
    d.reconnect();
    return;
  }
  if (payload.op === OP_INVALID_SESSION) {
    d.setSessionId(null);
    d.setSequence(null);
    d.onEvent("gateway invalidated the session");
    d.reconnect();
    return;
  }
  if (payload.op === OP_DISPATCH) d.handleDispatch(payload);
};

export const handleDispatch = (d: FrameDeps, payload: GatewayPayload): void => {
  if (payload.t === EVENT_READY) {
    const data = asRecord(payload.d);
    d.setSessionId(typeof data?.["session_id"] === "string" ? data["session_id"] : null);
    d.onEvent("gateway ready");
    d.setReconnects(0);
    d.backfill();
    return;
  }
  if (payload.t !== EVENT_MESSAGE_CREATE) return;
  d.report(payload.d);
};
