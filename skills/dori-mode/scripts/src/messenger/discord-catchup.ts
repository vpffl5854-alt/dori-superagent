/** A restart identifies from scratch, so whatever arrived while the process was down is only reachable through the REST history, channel by channel. */
import { BACKFILL_MAX_PAGES, BACKFILL_PAGE } from "./discord-gateway.ts";
import { idOf, newerId } from "./discord-record.ts";
import type { ChannelGuild, ChannelHistory } from "./discord-types.ts";

/** What a catch-up needs from the receiver: history, the report path, and the cursor it moves. */
export type CatchUpDeps = {
  readonly history: ChannelHistory | null;
  readonly guildOf: ChannelGuild | null;
  readonly report: (data: unknown, guildHint?: string | null) => Promise<boolean> | null;
  readonly noteCursor: (channel: string, messageId: string) => void;
  readonly onEvent: (line: string) => void;
  readonly caughtUp: Set<string>;
};

export const catchUp = async (d: CatchUpDeps, channel: string, after: string): Promise<void> => {
  const history = d.history;
  if (!history) return;
  let cursor = after;
  let fetched = 0;
  let delivered = 0;
  let truncated = false;
  let clean = true;
  let guild: string | null = null;
  try {
    guild = d.guildOf ? await d.guildOf(channel) : null;
  } catch (e) {
    d.onEvent(`guild lookup failed for ${channel}: ${(e as Error).message}`);
  }
  for (let page = 0; page < BACKFILL_MAX_PAGES; page++) {
    let rows: readonly unknown[];
    try {
      rows = await history(channel, cursor, BACKFILL_PAGE);
    } catch (e) {
      d.onEvent(`backfill stopped for ${channel}: ${(e as Error).message}`);
      clean = false;
      break;
    }
    if (!Array.isArray(rows) || rows.length === 0) break;
    const ordered = [...rows].sort((a, b) => {
      const left = idOf(a);
      const right = idOf(b);
      if (!left || !right || left === right) return 0;
      return newerId(left, right) === left ? 1 : -1;
    });
    for (const row of ordered) {
      const sent = d.report(row, guild);
      if (sent !== null && !(await sent)) {
        // The line never came out. Leave the cursor on the last row that did, so the next
        // restart fetches this message again instead of skipping past it.
        d.onEvent(`backfill stopped for ${channel}: delivery failed`);
        return;
      }
      if (sent !== null) delivered++;
      // The cursor means "everything up to here is handled", including the bot's own messages and
      // anything this run filtered, so the next restart does not fetch them again. It moves one
      // row at a time and only after that row's line, so a page as a whole can never overtake a
      // message whose download is still running.
      d.noteCursor(channel, idOf(row));
      cursor = newerId(cursor, idOf(row));
    }
    fetched += rows.length;
    if (rows.length < BACKFILL_PAGE) break;
    if (page === BACKFILL_MAX_PAGES - 1) truncated = true;
  }
  if (fetched > 0) {
    d.onEvent(
      `backfill fetched ${fetched} message(s) in ${channel}, delivered ${delivered}${truncated ? " (stopped at the page limit)" : ""}`,
    );
  }
  if (clean && !truncated) d.caughtUp.add(channel);
};
