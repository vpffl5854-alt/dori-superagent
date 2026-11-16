import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Http, HttpRequest, HttpResponse } from "../src/messenger/http.ts";
import { Telegram } from "../src/messenger/telegram.ts";
import {
  fileTgInboundStore,
  pollTelegramInbound,
  type TgInbound,
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

test("live-location edit refreshes carry no text and are dropped, not one line each", async () => {
  const realEdit = {
    update_id: 200,
    edited_message: { ...msg(OWNER, OWNER, "private", "moved the pin"), edit_date: 1730 },
  };
  const locEdits = Array.from({ length: 6 }, (_, i) => ({
    update_id: 201 + i,
    edited_message: {
      message_id: 42,
      from: { id: OWNER, is_bot: false, username: "owner" },
      chat: { id: OWNER, type: "private" },
      location: { latitude: 1.3 + i * 0.0001, longitude: 103.8 },
      edit_date: 1731 + i,
    },
  }));
  // One getUpdates response can carry the whole burst, and so can one poll.
  const { http } = telegramFake([[realEdit, ...locEdits]]);
  const store = fileTgInboundStore(join(state.dir, "tg-off-loc"));
  const { inbound: out } = await pollTelegramInbound(mk(http), store, { ownerId: OWNER });
  expect(out.length).toBe(1); // the text edit survives
  expect(out[0]!.text).toBe("moved the pin");
  expect(store.load()).toBe(207); // the location stream was consumed, not replayed
});

test("--loop re-polls after a poll whose updates were all gate-dropped", async () => {
  // A stranger's message is dropped by the owner gate, but updates came back:
  // more may be waiting, so the next poll must happen before any interval sleep.
  const { http, bodies } = telegramFake([
    [{ update_id: 300, message: msg(999, -1003801002434, "supergroup", "stranger", 3, true) }],
    [],
  ]);
  const store = fileTgInboundStore(join(state.dir, "tg-off-drop"));
  const emitted: TgInbound[] = [];
  const sleeps: number[] = [];
  const stop = new Error("STOP");
  await telegramInboundLoop(
    mk(http),
    store,
    { ownerId: OWNER },
    1,
    (i) => emitted.push(i),
    () => {},
    async (ms) => {
      sleeps.push(ms);
      throw stop;
    },
  ).catch((e: unknown) => {
    if (e !== stop) throw e;
  });
  expect(emitted).toHaveLength(0); // nothing passed the gate
  expect(bodies.length).toBe(2); // dropped poll -> immediate re-poll -> empty poll -> only then sleep
  expect(sleeps).toEqual([60_000]);
});
