import type { TgInbound } from "./telegram-inbound.ts";

/**
 * The `INBOUND` line `dori inbound telegram` prints for one message (format in references/scripts.md). Full text,
 * JSON-escaped on one line, because getUpdates cannot fetch a message twice; `mid=` is always present, `-` when
 * Telegram gave no message_id, so the fields after it never shift.
 */
export const formatTelegramInbound = (i: TgInbound): string =>
  `INBOUND ${i.kind === "edit" ? "edit:" : ""}${i.source} ${i.chat} ${i.thread ?? "-"} ${i.updateId} mid=${i.messageId ?? "-"} ${i.from} ${JSON.stringify(i.text ?? "")}` +
  (i.media === undefined ? "" : ` file=${i.media.kind}:${i.media.fileId}`);
