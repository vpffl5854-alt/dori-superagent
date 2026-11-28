import { expect, test } from "bun:test";

import { batches } from "../src/messenger/discord-answers-batch.ts";
import type { Inbound } from "../src/messenger/discord-gateway.ts";
import { missedPrompt } from "../src/messenger/discord-handoff.ts";
import { missedTalk } from "../src/messenger/discord-missed.ts";

const msg = (id: string, author: string, text: string, channel = "c1"): Inbound => ({
  source: "guild",
  channel,
  guild: "g1",
  messageId: id,
  author,
  authorIsBot: author !== "sseritwo_51107",
  text,
  missed: true,
});

test("missed messages are gathered per channel and shown once, after the backfill goes quiet", async () => {
  const shown: string[][] = [];
  const waiters: (() => void)[] = [];
  const m = missedTalk((talk) => {
    shown.push(talk.map((t) => t.messageId));
    waiters.shift()?.();
  }, 20);
  const nextShow = () => new Promise<void>((resolve) => waiters.push(resolve));
  const both = Promise.all([nextShow(), nextShow()]);
  m.add(msg("1", "상디", "a"));
  m.add(msg("2", "sseritwo_51107", "b"));
  m.add(msg("9", "초파", "x", "c2"));
  m.add(msg("3", "instinct", "c"));
  expect(shown).toEqual([]);
  await both;
  expect(shown.sort()).toEqual([["1", "2", "3"], ["9"]]);
});

test("the lane is told the talk is past and not to answer it, each line short and pane-safe", () => {
  const p = missedPrompt([
    msg("1", "상디", `코드 \`rm\` $(x) ${"길다".repeat(200)}`),
    msg("2", "sseritwo_51107", "ㅋㅋ"),
  ]);
  expect(p).toContain("놓친 대화");
  expect(p).toContain("글 2개");
  expect(p).toContain("답하지 말고 흐름만 알아 두세요");
  expect(p).not.toContain("`");
  expect(p).not.toContain("$(");
  expect(p.split("\n")[1]?.length).toBeLessThan(220);
});

test("messages waiting at once in one channel and log are one batch: the answer goes to the newest, read from the earliest", () => {
  const b = batches([
    { channel: "c1", messageId: "1575506964832583764", sessionPath: "/s", offset: 300 },
    { channel: "c1", messageId: "1575454007911129139", sessionPath: "/s", offset: 100, ownFrom: 90 },
    { channel: "c1", messageId: "1575506117683847210", sessionPath: "/s", offset: 200 },
    { channel: "c2", messageId: "5", sessionPath: "/s", offset: 150 },
  ]);
  expect(b).toHaveLength(2);
  const c1 = b.find((x) => x.channel === "c1");
  expect(c1?.replyTo).toBe("1575506964832583764");
  expect(c1?.from).toBe(90);
  expect(c1?.items.map((i) => i.offset)).toEqual([100, 200, 300]);
});

test("what the backfill fetches is marked missed; what arrives on the socket is not", async () => {
  const { DiscordInbound } = await import("../src/messenger/discord-inbound.ts");
  const got: { id: string; missed: boolean }[] = [];
  const row = (id: string) => ({
    id,
    channel_id: "c1",
    author: { id: "u1", username: "sseritwo_51107" },
    content: `글 ${id}`,
  });
  const inbound = new DiscordInbound(
    () => ({ send: () => {}, close: () => {}, onMessage: () => {} }),
    "t",
    { setInterval: () => 1, clearInterval: () => {}, setTimeout: () => 1, clearTimeout: () => {} },
    "self",
    (i) => got.push({ id: i.messageId, missed: i.missed === true }),
    () => {},
    null,
    { read: async () => ({ c1: "100" }), write: async () => {} },
    async (_c, after) => (after === "100" ? [row("102"), row("101")] : []),
    async () => "g1",
  );
  inbound.start();
  await inbound.idle();
  inbound.handle(JSON.stringify({ op: 0, t: "MESSAGE_CREATE", s: 1, d: { ...row("103"), guild_id: "g1" } }));
  await inbound.idle();
  inbound.stop();
  expect(got).toEqual([
    { id: "101", missed: true },
    { id: "102", missed: true },
    { id: "103", missed: false },
  ]);
});
