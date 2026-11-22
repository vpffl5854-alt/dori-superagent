import { expect, test } from "bun:test";

import type { Inbound as DiscordInbound } from "../src/messenger/discord-gateway.ts";
import type { Inbound as SlackInbound } from "../src/messenger/slack-inbound.ts";
import type { TgInbound } from "../src/messenger/telegram-inbound.ts";
import type { TgTarget } from "../src/messenger/telegram.ts";
import { adaptDiscord, adaptSlack, adaptTelegram, OriginNotifier, type Senders } from "../src/messenger/unified.ts";

const recording = () => {
  const sent: { platform: string; where: unknown; text: string }[] = [];
  const senders: Senders = {
    telegram: async (target: TgTarget, text: string) => void sent.push({ platform: "telegram", where: target, text }),
    discord: async (channelId: string, text: string) => void sent.push({ platform: "discord", where: channelId, text }),
    slack: async (channel: string, text: string, threadTs?: string) =>
      void sent.push({ platform: "slack", where: { channel, threadTs }, text }),
  };
  return { senders, sent };
};

test("a telegram DM adapts to the common shape and replies to the same chat", async () => {
  const inbound: TgInbound = { kind: "message", source: "dm", chat: 42, updateId: 7, from: 4242, text: "hi" };
  const { message, reply } = adaptTelegram(inbound);
  expect(message).toEqual({ platform: "telegram", userId: "4242", channel: "42", text: "hi" });
  expect(reply).toEqual({ platform: "telegram", target: { chatId: 42 } });
});

test("a telegram topic message keeps its thread so the answer lands back in the topic", () => {
  const inbound: TgInbound = {
    kind: "message",
    source: "topic",
    chat: -100,
    thread: 5,
    updateId: 8,
    from: 9,
    username: "owner",
    text: "do the thing",
  };
  const { reply } = adaptTelegram(inbound);
  expect(reply).toEqual({ platform: "telegram", target: { chatId: -100, threadId: 5 } });
});

test("a telegram media-only message still carries a readable text marker", () => {
  const inbound: TgInbound = {
    kind: "message",
    source: "dm",
    chat: 42,
    updateId: 9,
    from: 4242,
    media: { kind: "photo", fileId: "F" },
  };
  expect(adaptTelegram(inbound).message.text).toBe("[photo]");
});

test("a discord guild message adapts and replies to its channel", () => {
  const inbound: DiscordInbound = {
    source: "guild",
    channel: "C1",
    guild: "G1",
    messageId: "M1",
    author: "jib",
    authorIsBot: false,
    text: "run the job",
  };
  const { message, reply } = adaptDiscord(inbound);
  expect(message).toEqual({ platform: "discord", userId: "jib", channel: "C1", text: "run the job" });
  expect(reply).toEqual({ platform: "discord", channelId: "C1" });
});

test("a slack thread reply adapts and answers inside the same thread", () => {
  const inbound: SlackInbound = {
    source: "own-thread",
    channel: "C2",
    ts: "3000.000100",
    threadTs: "500.000100",
    user: "U_OWNER",
    text: "status?",
  };
  const { message, reply } = adaptSlack(inbound);
  expect(message).toEqual({
    platform: "slack",
    userId: "U_OWNER",
    channel: "C2",
    text: "status?",
  });
  expect(reply).toEqual({ platform: "slack", channel: "C2", threadTs: "500.000100" });
});

test("a slack unread line without a user still adapts instead of crashing", () => {
  const inbound: SlackInbound = { source: "unread", channel: "D1", ts: "", text: "1 mention(s), unread" };
  expect(adaptSlack(inbound).message).toEqual({
    platform: "slack",
    userId: "",
    channel: "D1",
    text: "1 mention(s), unread",
  });
});

test("the done notification goes to the messenger the first message came from", async () => {
  const { senders, sent } = recording();
  const notifier = new OriginNotifier(senders);
  notifier.observe(
    adaptDiscord({
      source: "dm",
      channel: "C9",
      guild: "-",
      messageId: "1",
      author: "jib",
      authorIsBot: false,
      text: "first",
    }),
  );
  notifier.observe(
    adaptSlack({ source: "own-thread", channel: "C2", ts: "1", threadTs: "1", user: "U", text: "later" }),
  );
  expect(await notifier.notifyDone("작업 완료")).toBe(true);
  expect(sent).toEqual([{ platform: "discord", where: "C9", text: "작업 완료" }]);
});

test("notifyDone reports false before any message arrives", async () => {
  const { senders, sent } = recording();
  expect(await new OriginNotifier(senders).notifyDone("done")).toBe(false);
  expect(sent).toEqual([]);
});

test("a telegram-origin task is answered through the telegram sender with its thread", async () => {
  const { senders, sent } = recording();
  const notifier = new OriginNotifier(senders);
  notifier.observe(
    adaptTelegram({ kind: "message", source: "topic", chat: -100, thread: 3, updateId: 1, from: 7, text: "go" }),
  );
  expect(await notifier.notifyDone("done")).toBe(true);
  expect(sent).toEqual([{ platform: "telegram", where: { chatId: -100, threadId: 3 }, text: "done" }]);
});
