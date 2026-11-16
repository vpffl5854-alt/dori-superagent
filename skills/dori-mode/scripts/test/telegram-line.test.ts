import { expect, test } from "bun:test";
import type { TgInbound } from "../src/messenger/telegram-inbound.ts";
import { formatTelegramInbound } from "../src/messenger/telegram-line.ts";

const base: TgInbound = { kind: "message", source: "dm", chat: 5250, updateId: 90, from: 5250, text: "hi" };

test.each([
  ["a message with its id", { ...base, messageId: 7 }, 'INBOUND dm 5250 - 90 mid=7 5250 "hi"'],
  ["no message_id: mid=- keeps every later field in place", base, 'INBOUND dm 5250 - 90 mid=- 5250 "hi"'],
  [
    "an edit in a topic, pointing at the message it replaces",
    { ...base, kind: "edit", source: "topic", chat: -1004, thread: 3, messageId: 1, text: "fixed typo" },
    'INBOUND edit:topic -1004 3 90 mid=1 5250 "fixed typo"',
  ],
  [
    "media appends file=, text JSON-escaped on one line",
    { ...base, messageId: 8, text: 'a "b"\nc', media: { kind: "photo", fileId: "F1" } },
    'INBOUND dm 5250 - 90 mid=8 5250 "a \\"b\\"\\nc" file=photo:F1',
  ],
] as const)("%s", (_, inbound, line) => {
  expect(formatTelegramInbound(inbound)).toBe(line);
});
