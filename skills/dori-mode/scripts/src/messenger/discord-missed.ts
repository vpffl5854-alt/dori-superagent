/**
 * The backfill hands over, one by one, every message the room had while the gateway was down. They are gathered per
 * channel and given to the lane together once the backfill has gone quiet, oldest first: one look at the talk so far.
 */
import type { Inbound } from "./discord-gateway.ts";

/** The backfill reports a channel's pages back to back: this long without a new one means it is done. */
export const MISSED_QUIET_MS = 3_000;

export const missedTalk = (
  show: (talk: readonly Inbound[]) => void,
  quietMs = MISSED_QUIET_MS,
): { add: (i: Inbound) => void } => {
  const byChannel = new Map<string, Inbound[]>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  return {
    add: (i) => {
      byChannel.set(i.channel, [...(byChannel.get(i.channel) ?? []), i]);
      clearTimeout(timers.get(i.channel));
      timers.set(
        i.channel,
        setTimeout(() => {
          const talk = byChannel.get(i.channel) ?? [];
          byChannel.delete(i.channel);
          timers.delete(i.channel);
          if (talk.length > 0) show(talk);
        }, quietMs),
      );
    },
  };
};
