import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Http, HttpRequest, HttpResponse } from "../src/messenger/http.ts";
import type { TgInbound } from "../src/messenger/telegram-inbound.ts";
import { Telegram } from "../src/messenger/telegram.ts";
import {
  envInt,
  fileTgInboundStore,
  pollTelegramInbound,
  telegramInboundLoop,
} from "../src/messenger/telegram-inbound.ts";
import { fakeClock, withState } from "./fakes.ts";

const OWNER = 5250;

const state = withState();

// The store's dir is shared across tests; recreate it fresh for each so the
// previous test's offset never bleeds in, and remove it so nothing leaks.
beforeEach(() => mkdirSync(state.dir, { recursive: true }));

afterEach(() => state.done());

type U = { update_id: number; message?: unknown; edited_message?: unknown };

const msg = (from: number, chatId: number, type: string, text: string, thread?: number, isTopicMessage?: boolean) => ({
  message_id: 1,
  from: { id: from, is_bot: false, username: from === OWNER ? "owner" : "someone" },
  chat: { id: chatId, type },
  ...(thread === undefined ? {} : { message_thread_id: thread }),
  ...(isTopicMessage === undefined ? {} : { is_topic_message: isTopicMessage }),
  text,
});

const telegramFake = (batches: U[][]) => {
  const bodies: Record<string, unknown>[] = [];
  const http: Http = async (req: HttpRequest): Promise<HttpResponse> => {
    bodies.push(JSON.parse(String(req.body ?? "{}")) as Record<string, unknown>);
    const batch = batches.shift() ?? [];
    return { status: 200, headers: {}, body: JSON.stringify({ ok: true, result: batch }) };
  };
  return { http, bodies };
};

const mk = (http: Http): Telegram => new Telegram(http, fakeClock(0), "T");

test("the store creates its state dir on first save", async () => {
  const { http } = telegramFake([[{ update_id: 80, message: msg(OWNER, OWNER, "private", "fresh install") }]]);
  const store = fileTgInboundStore(join(state.dir, "nested", "deeper", "tg-off-8"));
  const { inbound: out } = await pollTelegramInbound(mk(http), store, { ownerId: OWNER });
  expect(out.length).toBe(1);
  expect(store.load()).toBe(81);
});

test("edited messages arrive as their own edit kind with the edited text", async () => {
  const { http, bodies } = telegramFake([
    [{ update_id: 90, edited_message: { ...msg(OWNER, OWNER, "private", "fixed typo"), edit_date: 1730 } }],
    [{ update_id: 91, message: msg(OWNER, OWNER, "private", "fresh after edit") }],
  ]);
  const store = fileTgInboundStore(join(state.dir, "tg-off-9"));
  const { inbound: out } = await pollTelegramInbound(mk(http), store, { ownerId: OWNER });
  expect(out.length).toBe(1);
  expect(out[0]!.kind).toBe("edit");
  expect(out[0]!.text).toBe("fixed typo");
  expect(out[0]!.messageId).toBe(1); // the message_id of the message being edited
  expect(store.load()).toBe(91);
  expect(bodies[0]!["allowed_updates"]).toEqual(["message", "edited_message"]);
  const { inbound: second } = await pollTelegramInbound(mk(http), store, { ownerId: OWNER });
  expect(second[0]!.kind).toBe("message");
});

test("a voice note identifies its media so transcribe can fetch it", async () => {
  const { http } = telegramFake([
    [
      {
        update_id: 100,
        message: {
          message_id: 55,
          from: { id: OWNER, is_bot: false, username: "owner" },
          chat: { id: OWNER, type: "private" },
          voice: { file_id: "FID_VOICE", duration: 9 },
        },
      },
    ],
  ]);
  const store = fileTgInboundStore(join(state.dir, "tg-off-10"));
  const { inbound: out } = await pollTelegramInbound(mk(http), store, { ownerId: OWNER });
  expect(out.length).toBe(1);
  expect(out[0]!.kind).toBe("message");
  expect(out[0]!.text).toBeUndefined();
  expect(out[0]!.media).toEqual({ kind: "voice", fileId: "FID_VOICE", messageId: 55 });
  expect(store.load()).toBe(101);
});

test("a photo with a caption carries both the text and the largest photo", async () => {
  const { http } = telegramFake([
    [
      {
        update_id: 110,
        message: {
          message_id: 56,
          from: { id: OWNER, is_bot: false, username: "owner" },
          chat: { id: OWNER, type: "private" },
          photo: [{ file_id: "SMALL" }, { file_id: "LARGE" }],
          caption: "look at this",
        },
      },
    ],
  ]);
  const store = fileTgInboundStore(join(state.dir, "tg-off-11"));
  const { inbound: out } = await pollTelegramInbound(mk(http), store, { ownerId: OWNER });
  expect(out.length).toBe(1);
  expect(out[0]!.text).toBe("look at this");
  expect(out[0]!.media).toEqual({ kind: "photo", fileId: "LARGE", messageId: 56 });
});

test("an unparseable offset warns once across several polls and restarts from 0", async () => {
  writeFileSync(join(state.dir, "telegram-offset"), "not-a-number");
  const warns: string[] = [];
  const orig = console.log;
  console.log = (s?: unknown) => {
    warns.push(String(s));
  };
  try {
    const store = fileTgInboundStore(join(state.dir, "telegram-offset"));
    // Three polls, no updates: nothing saves over the corrupt file, every poll loads it.
    const { http } = telegramFake([[], [], []]);
    const tg = mk(http);
    for (let i = 0; i < 3; i++) await pollTelegramInbound(tg, store, { ownerId: OWNER });
    expect(store.load()).toBe(0);
  } finally {
    console.log = orig;
  }
  expect(warns).toHaveLength(1);
  expect(warns[0]).toContain("WARN");
  expect(warns[0]).toContain("unparseable");
});

test("envInt refuses empty, whitespace, 1e3 and 0x10; accepts plain integers", () => {
  for (const v of ["", "   ", "1e3", "0x10", "12.5", "abc", "99999999999999999999"]) {
    expect(() => envInt("DORI_TELEGRAM_OWNER_ID", v)).toThrow(
      `DORI_TELEGRAM_OWNER_ID must be an integer, got: ${JSON.stringify(v)}`,
    );
  }
  expect(() => envInt("DORI_TELEGRAM_OWNER_ID", undefined)).toThrow("DORI_TELEGRAM_OWNER_ID is not set");
  expect(envInt("DORI_TELEGRAM_OWNER_ID", " 42 ")).toBe(42);
  expect(envInt("DORI_TELEGRAM_TOPIC_ID", "-5")).toBe(-5);
  expect(envInt("DORI_TELEGRAM_GROUP_ID", "0")).toBe(0);
});

test("one-shot (no --loop) returns after a single bounded poll under continuous traffic", async () => {
  // Continuous traffic: every poll would return another message if polled again.
  const { http } = telegramFake(
    Array.from({ length: 20 }, (_, i) => [{ update_id: 100 + i, message: msg(OWNER, OWNER, "private", `msg ${i}`) }]),
  );
  const store = fileTgInboundStore(join(state.dir, "tg-off-oneshot"));
  const out: TgInbound[] = [];
  await telegramInboundLoop(mk(http), store, { ownerId: OWNER }, 0, (i) => out.push(i));
  // Returns, and drained exactly one poll's batch — not the whole stream.
  expect(out).toHaveLength(1);
  expect(out[0]!.updateId).toBe(100);
});

test("--loop re-polls immediately after a productive poll and sleeps only when idle", async () => {
  const { http } = telegramFake([[{ update_id: 200, message: msg(OWNER, OWNER, "private", "burst") }], []]);
  const store = fileTgInboundStore(join(state.dir, "tg-off-loop"));
  const out: TgInbound[] = [];
  const sleeps: number[] = [];
  const stop = new Error("STOP");
  // The first idle sleep throws to end the loop for the test.
  await telegramInboundLoop(
    mk(http),
    store,
    { ownerId: OWNER },
    1,
    (i) => out.push(i),
    () => {},
    async (ms) => {
      sleeps.push(ms);
      throw stop;
    },
  ).catch((e: unknown) => {
    if (e !== stop) throw e;
  });
  expect(out.map((i) => i.updateId)).toEqual([200]); // productive poll, then immediate re-poll
  expect(sleeps).toEqual([60_000]); // slept only after the idle poll
});
