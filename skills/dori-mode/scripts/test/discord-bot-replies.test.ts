import { expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type DoriConfig, defaultConfig } from "../src/config.ts";
import { startDiscordReplies } from "../src/messenger/discord-answers.ts";
import type { ChosenRuntimes } from "../src/run.ts";
import { BOT_REPLY_BUDGET, botAnswerer, botCall, DORI_NAME, hasContent } from "../src/messenger/discord-bot-replies.ts";
import type { Inbound } from "../src/messenger/discord-gateway.ts";
import { toInbound } from "../src/messenger/discord-message.ts";
import { Discord } from "../src/messenger/discord.ts";
import type { Http, HttpRequest, HttpResponse } from "../src/messenger/http.ts";

const ok = (body: unknown): HttpResponse => ({ status: 200, headers: {}, body: JSON.stringify(body) });

const fakeHttp = (script: (req: HttpRequest, n: number) => HttpResponse) => {
  const seen: HttpRequest[] = [];
  const http: Http = async (req) => {
    seen.push(req);
    return script(req, seen.length);
  };
  return { http, seen };
};

const posts = (seen: readonly HttpRequest[]) => seen.filter((req) => req.method === "POST");
const sent = (req: HttpRequest | undefined) => JSON.parse(String(req?.body)) as Record<string, unknown>;

const SELF_ID = "dori-id";
const ANSWER = "빌드는 node 22 로 올리면 다시 돈다. 로그의 ESM 경고는 원인이 아니다.";

const botPost = (extra: Record<string, unknown> = {}): Inbound => {
  const { replyTo, text, ...rest } = extra as { replyTo?: Record<string, unknown>; text?: string } & Record<
    string,
    unknown
  >;
  return toInbound(
    {
      id: "10",
      channel_id: "c1",
      guild_id: "g1",
      author: { id: "b1", username: "상디", bot: true },
      content: text ?? "빌드가 깨졌다.\n로그를 봐라",
      ...rest,
      ...(replyTo ? { message_reference: { message_id: replyTo["id"] }, referenced_message: replyTo } : {}),
    },
    SELF_ID,
  )!;
};

const callsDori = (id = "10") =>
  botPost({ id, text: "@dori 이거 봐", mentions: [{ id: SELF_ID, username: DORI_NAME }] });

const config = (stateDir: string): DoriConfig => ({
  ...defaultConfig("/tmp/dori-bot-replies"),
  stateDir,
  leadPane: "",
  discordSelfId: SELF_ID,
});

const withState = async (run: (stateDir: string) => Promise<void> | void): Promise<void> => {
  const dir = mkdtempSync(join(tmpdir(), "discord-bot-replies-"));
  try {
    await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const notes: string[] = [];

const answererFor = (http: Http, stateDir: string, answer: (i: Inbound) => Promise<string | undefined>) =>
  botAnswerer({
    discord: new Discord(http, { now: () => 0, sleep: async () => {} }, "t"),
    stateDir,
    selfId: SELF_ID,
    note: (line) => notes.push(line),
    answer,
  });

const log = (stateDir: string): string => readFileSync(join(stateDir, "discord-replies.log"), "utf8");

test("a bot post that does not call Dori is logged and nothing is posted", () =>
  withState(async (stateDir) => {
    const { http, seen } = fakeHttp(() => ok({ id: "99" }));
    const replies = startDiscordReplies(
      new Discord(http, { now: () => 0, sleep: async () => {} }, "t"),
      stateDir,
      config(stateDir),
    );
    try {
      expect(await replies.enqueueBot(botPost())).toBe(false);
    } finally {
      replies.stop();
    }
    expect(posts(seen)).toHaveLength(0);
    expect(log(stateDir)).toContain("bot 상디 in c1 room talk, but there was no answer with content");
  }));

test("a bot that calls Dori is answered in the room with real content, as a reply to its post", () =>
  withState(async (stateDir) => {
    const { http, seen } = fakeHttp(() => ok({ id: "99" }));
    const answer = answererFor(http, stateDir, async () => ANSWER);
    expect(await answer(callsDori())).toBe(true);
    expect(posts(seen)).toHaveLength(1);
    expect(seen[0]?.url).toEndWith("/channels/c1/messages");
    expect(sent(seen[0])["message_reference"]).toEqual({ message_id: "10", fail_if_not_exists: false });
    expect(sent(seen[0])["content"]).toBe(ANSWER);
    expect(notes.at(-1)).toContain("answered bot 상디 in c1 called dori: 99");
    expect(JSON.parse(readFileSync(join(stateDir, "discord-bot-replies.json"), "utf8"))).toEqual({ c1: { 상디: 1 } });
  }));

test("a quote-only '말에 답한다' answer is never posted, and spends no budget", () =>
  withState(async (stateDir) => {
    const { http, seen } = fakeHttp(() => ok({ id: "99" }));
    const quoteOnly = answererFor(http, stateDir, async () => "> 빌드가 깨졌다.\n\n상디 말에 답한다.");
    const blank = answererFor(http, stateDir, async () => "   ");
    expect(await quoteOnly(callsDori())).toBe(false);
    expect(await blank(callsDori("11"))).toBe(false);
    expect(posts(seen)).toHaveLength(0);
    expect(existsSync(join(stateDir, "discord-bot-replies.json"))).toBe(false);
    expect(notes.at(-1)).toContain("no answer with content");
  }));

test("the budget is per bot and per channel, survives a restart, and running out leaves the bot unanswered", () =>
  withState(async (stateDir) => {
    const { http, seen } = fakeHttp((_, n) => ok({ id: String(n) }));
    const answer = answererFor(http, stateDir, async () => ANSWER);
    for (let i = 0; i < BOT_REPLY_BUDGET; i++) expect(await answer(callsDori(String(10 + i)))).toBe(true);
    expect(await answer(callsDori("30"))).toBe(false);
    expect(
      await answer(
        botPost({
          id: "31",
          author: { id: "b2", username: "kuma", bot: true },
          mentions: [{ id: SELF_ID, username: DORI_NAME }],
        }),
      ),
    ).toBe(true);
    expect(
      await answer(botPost({ id: "32", channel_id: "c2", mentions: [{ id: SELF_ID, username: DORI_NAME }] })),
    ).toBe(true);
    expect(posts(seen)).toHaveLength(BOT_REPLY_BUDGET + 2);
    const counts = JSON.parse(readFileSync(join(stateDir, "discord-bot-replies.json"), "utf8")) as Record<
      string,
      Record<string, number>
    >;
    expect(counts).toEqual({ c1: { 상디: BOT_REPLY_BUDGET, kuma: 1 }, c2: { 상디: 1 } });
    const restarted = answererFor(fakeHttp(() => ok({ id: "r" })).http, stateDir, async () => ANSWER);
    expect(await restarted(callsDori("33"))).toBe(false);
  }));

test("a failed post spends nothing, so a Discord outage does not use up the room's answers", () =>
  withState(async (stateDir) => {
    const { http, seen } = fakeHttp(() => ({ status: 500, headers: {}, body: JSON.stringify({ message: "boom" }) }));
    expect(await answererFor(http, stateDir, async () => ANSWER)(callsDori())).toBe(false);
    expect(posts(seen).length).toBeGreaterThan(0);
    expect(existsSync(join(stateDir, "discord-bot-replies.json"))).toBe(false);
    expect(notes.at(-1)).toContain("bot answer failed for 10");
  }));

test("a bot that replies to Dori's own post is answered; another bot's post is still offered to the answerer", () => {
  const toDori = botPost({ replyTo: { id: "5", author: { id: SELF_ID, username: DORI_NAME } } });
  const toOther = botPost({ replyTo: { id: "6", author: { id: "b1", username: "상디" } } });
  expect(botCall(toDori, SELF_ID)).toBe(`replied to ${DORI_NAME}`);
  // Room talk still reaches the answerer, which speaks only when it has something to add; `hasContent` drops the rest.
  expect(botCall(toOther, SELF_ID)).toBe("room talk");
  expect(botCall(callsDori(), SELF_ID)).toBe(`called ${DORI_NAME}`);
});

test("hasContent refuses blank text and the quote-only line, and keeps a real answer", () => {
  expect(hasContent("")).toBe(false);
  expect(hasContent("> 빌드가 깨졌다.\n\n상디 말에 답한다.")).toBe(false);
  expect(hasContent(ANSWER)).toBe(true);
});

test("a message enqueued while the lead is working still posts that message's own answer", () =>
  withState(async (stateDir) => {
    const sessionLog = join(stateDir, "lead.jsonl");
    const assistant = (text: string) =>
      `${JSON.stringify({ message: { role: "assistant", content: [{ type: "text", text }] } })}\n`;
    writeFileSync(sessionLog, assistant("첫 답"));
    const { http, seen } = fakeHttp(() => ok({ id: "99" }));
    // The pane is working and then goes idle: the test double stands in for the runtime's own list, so the reply loop
    // reads a status instead of shelling out to hc.
    let status = "working";
    const rts = {
      for: () => ({
        list: async () => [{ ref: { runtime: "hc", id: "t1t" }, status }],
        deliver: async () => ({ kind: "delivered" }),
        read: async () => "",
      }),
    } as unknown as ChosenRuntimes;
    const replies = startDiscordReplies(
      new Discord(http, { now: () => 0, sleep: async () => {} }, "t"),
      stateDir,
      { ...config(stateDir), leadPane: "hc:t1t" },
      undefined,
      rts,
    );
    try {
      appendFileSync(sessionLog, assistant("이 메시지의 답"));
      expect(await replies.enqueue({ channel: "c1", messageId: "10", sessionPath: sessionLog })).toBe(true);
      appendFileSync(sessionLog, assistant("다음 메시지의 답"));
      await Bun.sleep(200);
      status = "idle";
      const deadline = Date.now() + 5_000;
      while (posts(seen).length === 0 && Date.now() < deadline) await Bun.sleep(20);
    } finally {
      replies.stop();
    }
    expect(posts(seen)).toHaveLength(1);
    expect(sent(posts(seen)[0])["content"]).toBe("다음 메시지의 답");
  }));
