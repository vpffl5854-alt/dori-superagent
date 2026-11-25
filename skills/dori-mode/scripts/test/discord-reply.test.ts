import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { formatInbound, toInbound } from "../src/messenger/discord-message.ts";
import { answerText, lastAnswer, linkify, MAX_DISCORD_CHARS, splitForDiscord } from "../src/messenger/discord-reply.ts";

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
  expect(answerText(content("Ask: 방 질문에 답하기\nwanted: 답 하나\n\n80%는 좀 낮게 잡으셨어요."))).toBe(
    "80%는 좀 낮게 잡으셨어요.",
  );
  expect(answerText(content("Now: 확인\n"))).toBeUndefined();
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

test("a link written without https:// becomes one Discord opens; real links, code, mail and prose stay", () => {
  expect(linkify("링크: tokenharbor.ai/models/deepseek-v4.1-flash:free · orcarouter.ai/models/x")).toBe(
    "링크: https://tokenharbor.ai/models/deepseek-v4.1-flash:free · https://orcarouter.ai/models/x",
  );
  expect(linkify("www.sume.com 참고")).toBe("https://www.sume.com 참고");
  expect(linkify("이미 https://openrouter.ai/deepseek 링크")).toBe("이미 https://openrouter.ai/deepseek 링크");
  expect(linkify("base `api.orcarouter.ai/v1` 그대로")).toBe("base `api.orcarouter.ai/v1` 그대로");
  expect(linkify("메일 a@b.com, 파일 config.json, 버전 v4.1, 1.5배")).toBe(
    "메일 a@b.com, 파일 config.json, 버전 v4.1, 1.5배",
  );
  expect(linkify("tokenrouter.com 은 게이트웨이")).toBe("tokenrouter.com 은 게이트웨이");
});
