/** The one path a message takes: filter, dedupe, deliver, then move the cursor; and the restart backfill that feeds it. */
import { MAX_SEEN } from "./discord-gateway.ts";
import { mediaRefs, toInbound } from "./discord-record.ts";
import type { ChannelHistory, CursorStore, Inbound, InboundCursors, MediaRef } from "./discord-types.ts";

/** What a report needs from the receiver. */
export type ReportDeps = {
  readonly selfId: string;
  readonly seen: Set<string>;
  readonly caughtUp: Set<string>;
  readonly deliver: (inbound: Inbound, refs: readonly MediaRef[]) => Promise<void>;
  readonly noteCursor: (channel: string, messageId: string) => void;
  readonly onEvent: (line: string) => void;
};

/** What a restart backfill needs: the stored cursors, and the receiver it feeds. */
export type BackfillDeps = ReportDeps & {
  readonly cursors: CursorStore | null;
  readonly history: ChannelHistory | null;
  readonly cursorMap: () => Record<string, string>;
  readonly setCursorMap: (map: Record<string, string>) => void;
  readonly chain: () => Promise<void>;
  readonly setChain: (p: Promise<void>) => void;
  readonly catchUp: (channel: string, after: string) => Promise<void>;
};

/** The one path a message takes, whether it arrived on the socket or from a backfill page.
 * Resolves true once the line is out and the channel cursor has moved past it, false when the
 * line could not be printed (the cursor stays behind, so a restart replays it); null when there
 * is no line at all — filtered, a duplicate, or nothing to report. */
export const report = (d: ReportDeps, data: unknown, guildHint?: string | null): Promise<boolean> | null => {
  const inbound = toInbound(data, d.selfId, guildHint);
  if (!inbound) return null;
  if (d.seen.has(inbound.messageId)) return null;
  d.seen.add(inbound.messageId);
  if (d.seen.size > MAX_SEEN) {
    const oldest = d.seen.values().next().value;
    if (oldest !== undefined) d.seen.delete(oldest);
  }
  return d.deliver(inbound, mediaRefs(data)).then(
    () => {
      if (d.caughtUp.has(inbound.channel)) d.noteCursor(inbound.channel, inbound.messageId);
      return true;
    },
    (e) => {
      d.seen.delete(inbound.messageId);
      d.onEvent(`delivery failed: ${(e as Error).message}`);
      return false;
    },
  );
};

/** A restart identifies from scratch, so Discord replays nothing: whatever arrived while the
 * process was down is only reachable through the REST history, channel by channel. */
export const backfill = (d: BackfillDeps): void => {
  const store = d.cursors;
  const history = d.history;
  if (!store || !history) return;
  const next = d
    .chain()
    .then(async () => {
      let stored: InboundCursors;
      try {
        stored = await store.read();
      } catch (e) {
        d.onEvent(`cursor read failed: ${(e as Error).message}`);
        return;
      }
      d.setCursorMap({ ...stored, ...d.cursorMap() });
      for (const [channel, after] of Object.entries(d.cursorMap())) {
        if (!channel || !after) continue;
        await d.catchUp(channel, after);
      }
    })
    .catch((e) => d.onEvent(`backfill failed: ${(e as Error).message}`));
  d.setChain(next);
};
