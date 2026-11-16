/** Per-channel cursors: the newest id printed in each channel, written in print order. */
import { newerId } from "./discord-record.ts";
import type { CursorStore } from "./discord-types.ts";

/** Persisted per channel: a single global id would skip a quiet channel whose messages are older
 * than the busiest channel's newest one, and the skip is silent. Each write is chained behind the
 * previous one, so the file never goes backwards. */
export const noteCursor = (
  store: CursorStore | null,
  cursorMap: Record<string, string>,
  cursorWrite: Promise<void>,
  channel: string,
  messageId: string,
  onEvent: (line: string) => void,
): { cursorMap: Record<string, string>; cursorWrite: Promise<void> } => {
  if (!store || !channel || !messageId) return { cursorMap, cursorWrite };
  const current = cursorMap[channel];
  const next = current === undefined ? messageId : newerId(current, messageId);
  if (next === current) return { cursorMap, cursorWrite };
  const map = { ...cursorMap, [channel]: next };
  return {
    cursorMap: map,
    cursorWrite: cursorWrite
      .then(() => store.write(map))
      .catch((e) => onEvent(`cursor write failed: ${(e as Error).message}`)),
  };
};
