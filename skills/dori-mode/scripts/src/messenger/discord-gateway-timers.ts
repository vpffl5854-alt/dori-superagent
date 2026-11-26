/** One-shot timers on the gateway's clock, or the global ones when the clock has none (discord-gateway-socket.ts). */
import type { Clock } from "./discord-gateway.ts";

export const later = (clock: Clock, cb: () => void, ms: number): unknown =>
  clock.setTimeout ? clock.setTimeout(cb, ms) : setTimeout(cb, ms);

export const cancel = (clock: Clock, h: unknown): void => {
  if (clock.clearTimeout) clock.clearTimeout(h);
  else clearTimeout(h as ReturnType<typeof setTimeout>);
};
