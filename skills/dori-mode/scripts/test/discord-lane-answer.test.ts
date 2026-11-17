import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Inbound } from "../src/messenger/discord-gateway.ts";
import { toInbound } from "../src/messenger/discord-message.ts";
import { laneAnswerer, ROOM_TALK_BUDGET } from "../src/messenger/discord-lane-answer.ts";

const SELF_ID = "dori-id";
const ANSWER = "빌드는 node 22 로 올리면 다시 돈다. 로그의 ESM 경고는 원인이 아니다.";
const CHANNEL = "c1";

const inbound = (extra: Record<string, unknown> = {}): Inbound =>
  toInbound(
    {
      id: "10",
      channel_id: CHANNEL,
      guild_id: "g1",
      author: { id: "b1", username: "상디", bot: true },
      content: "빌드가 깨졌다.\n로그를 봐라",
      ...extra,
    },
    SELF_ID,
  )!;

const person = (extra: Record<string, unknown> = {}): Inbound =>
  inbound({ author: { id: "u1", username: "sseritwo_51107", bot: false }, ...extra });

const callsDori = (id = "10") => inbound({ id, mentions: [{ id: SELF_ID, username: "dori" }] });

const withState = async (run: (stateDir: string) => Promise<void> | void): Promise<void> => {
  const dir = mkdtempSync(join(tmpdir(), "discord-lane-"));
  try {
    await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const notes: string[] = [];
const asked: Inbound[] = [];

const answererFor = (stateDir: string, answer: (i: Inbound) => Promise<string | undefined>, reply = async () => true) =>
  laneAnswerer({
    stateDir,
    selfId: SELF_ID,
    note: (line) => notes.push(line),
    answer: async (i) => {
      asked.push(i);
      return await answer(i);
    },
    reply: async (i, text) => {
      notes.push(`reply ${i.messageId}: ${text}`);
      return await reply();
    },
  });

const budget = (stateDir: string): unknown =>
  JSON.parse(readFileSync(join(stateDir, "discord-bot-replies.json"), "utf8"));

test("a person's post reaches the lane, and its answer is what the room gets", () =>
  withState(async (stateDir) => {
    const before = notes.length;
    expect(await answererFor(stateDir, async () => ANSWER)(person())).toBe(true);
    expect(asked.map((i) => i.messageId)).toEqual(["10"]);
    expect(notes.slice(before)).toEqual([`reply 10: ${ANSWER}`, `answered sseritwo_51107 in ${CHANNEL} (a person)`]);
    expect(existsSync(join(stateDir, "discord-bot-replies.json"))).toBe(false);
  }));

test("a person's post the lane has nothing to add to posts nothing", () =>
  withState(async (stateDir) => {
    const before = notes.length;
    expect(await answererFor(stateDir, async () => "   ")(person())).toBe(false);
    expect(notes.slice(before)).toEqual(["lane had nothing to add to 10 (a person): nothing posted"]);
  }));

test("a bot that calls Dori is always offered, and its answer is posted", () =>
  withState(async (stateDir) => {
    const before = notes.length;
    expect(await answererFor(stateDir, async () => ANSWER)(callsDori())).toBe(true);
    expect(notes.slice(before)).toEqual([`reply 10: ${ANSWER}`, `answered 상디 in ${CHANNEL} (called dori)`]);
  }));

test("bot room talk is offered a bounded number of times per bot and channel, and the bound survives a restart", () =>
  withState(async (stateDir) => {
    const answer = answererFor(stateDir, async () => ANSWER);
    for (let i = 0; i < ROOM_TALK_BUDGET; i++) expect(await answer(inbound({ id: String(10 + i) }))).toBe(true);
    expect(await answer(inbound({ id: "20" }))).toBe(false);
    expect(notes.at(-1)).toContain("room talk, but its budget is spent");
    expect(budget(stateDir)).toEqual({ [CHANNEL]: { 상디: ROOM_TALK_BUDGET } });
    const restarted = answererFor(stateDir, async () => ANSWER);
    expect(await restarted(inbound({ id: "21" }))).toBe(false);
    expect(await restarted(inbound({ id: "22", author: { id: "b2", username: "kuma", bot: true } }))).toBe(true);
    expect(await restarted(inbound({ id: "23", channel_id: "c2" }))).toBe(true);
  }));

test("a bot that calls Dori is not held back by a spent room-talk budget", () =>
  withState(async (stateDir) => {
    const answer = answererFor(stateDir, async () => ANSWER);
    for (let i = 0; i < ROOM_TALK_BUDGET; i++) await answer(inbound({ id: String(10 + i) }));
    expect(await answer(callsDori("30"))).toBe(true);
  }));

test("a failed reply spends no room-talk budget", () =>
  withState(async (stateDir) => {
    const answer = answererFor(
      stateDir,
      async () => ANSWER,
      async () => {
        throw new Error("discord 500");
      },
    );
    expect(await answer(inbound())).toBe(false);
    expect(notes.at(-1)).toContain("lane reply failed for 10: discord 500");
    expect(existsSync(join(stateDir, "discord-bot-replies.json"))).toBe(false);
  }));
