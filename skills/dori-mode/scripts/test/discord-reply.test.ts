import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { formatInbound, toInbound } from "../src/messenger/discord-message.ts";
import { answerText, lastAnswer, MAX_DISCORD_CHARS, splitForDiscord } from "../src/messenger/discord-reply.ts";

const message = (extra: Record<string, unknown>) => ({
  id: "2",
  channel_id: "c1",
  guild_id: "g1",
  author: { id: "u1", username: "지브" },
  content: "이것도 보이는거니?",
  ...extra,
});

test("a reply carries the whole replied-to text, past the old 300-character preview", () => {
  const long = "가".repeat(1200);
  const inbound = toInbound(
    message({
      message_reference: { message_id: "1" },
      referenced_message: { id: "1", author: { username: "초파" }, content: long },
    }),
    "bot",
  );
  expect(inbound?.replyToText).toBe(long);
  expect(inbound?.replyTo?.content).toBe(long);
  expect(formatInbound(inbound!)).toContain(`reply_text=${JSON.stringify(long)}`);
});

test("splitForDiscord keeps every character and marks each continuation", () => {
  const text = `${"문장이다. ".repeat(400)}끝`;
  const parts = splitForDiscord(text);
  expect(parts.length).toBeGreaterThan(1);
  for (const part of parts) expect(part.length).toBeLessThanOrEqual(MAX_DISCORD_CHARS);
  expect(parts.slice(0, -1).every((part) => part.endsWith("…(이어서)"))).toBe(true);
  expect(parts.join("").replaceAll("…(이어서)", "").replaceAll(" ", "")).toBe(text.replaceAll(" ", ""));
});

test("splitForDiscord leaves a message under the limit whole", () => {
  expect(splitForDiscord("  짧은 답  ")).toEqual(["짧은 답"]);
});

test("answerText never posts the routing line, and needs an answer after it", () => {
  const content = (text: string) => ({ content: [{ type: "text", text }] });
  expect(answerText(content("I read this as a test - answer it.\n\n답입니다."))).toBe("답입니다.");
  // The routing line alone is the pane's own note: posting it puts English in a Korean room.
  expect(answerText(content("I read this as a test - answer it."))).toBeUndefined();
  expect(answerText({ content: [{ type: "tool_use", id: "t" }] })).toBeUndefined();
});

test("lastAnswer reads only what was written after the offset", () => {
  const dir = mkdtempSync(join(tmpdir(), "discord-reply-"));
  try {
    const path = join(dir, "session.jsonl");
    const line = (role: string, text: string) =>
      `${JSON.stringify({ message: { role, content: [{ type: "text", text }] } })}\n`;
    writeFileSync(path, line("user", "older"));
    const offset = Buffer.byteLength(line("user", "older"));
    writeFileSync(path, line("assistant", "새 답"), { flag: "a" });
    expect(lastAnswer(path, offset)).toBe("새 답");
    expect(lastAnswer(path, 0)).toBe("새 답");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
