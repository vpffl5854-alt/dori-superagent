/** The gateway loop's state and what it is wired to (discord-gateway-socket.ts). */
import type { Clock, GatewaySocket } from "./discord-gateway.ts";

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
  /** Set while a new socket waits for its hello; a socket that never says hello is replaced. */
  helloTimer?: unknown;
};

export type GatewayWiring = {
  readonly open: () => GatewaySocket;
  readonly token: string;
  readonly clock: Clock;
  readonly onEvent: (line: string) => void;
};

export type GatewayHost = GatewayState & GatewayWiring & { report(data: unknown): boolean };
