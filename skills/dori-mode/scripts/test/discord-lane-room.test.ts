import { expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DoriConfig } from "../src/config.ts";
import { defaultConfig } from "../src/config.ts";
import type { Inbound } from "../src/messenger/discord-gateway.ts";
import { toInbound } from "../src/messenger/discord-message.ts";
import { Discord } from "../src/messenger/discord.ts";
import { startLaneAnswers } from "../src/messenger/discord-lane.ts";
import type { ChosenRuntimes, Ran, Runner } from "../src/run.ts";
import type { Http, HttpRequest, HttpResponse } from "../src/messenger/http.ts";

const SELF_ID = "dori-id";
const ANSWER = "빌드는 node 22 로 올리면 다시 돈다. 로그의 ESM 경고는 원인이 아니다.";
const CHANNEL = "c1";

const ok = (body: unknown): HttpResponse => ({ status: 200, headers: {}, body: JSON.stringify(body) });

const fakeHttp = () => {
  const seen: HttpRequest[] = [];
  const http: Http = async (req) => {
    seen.push(req);
    return ok({ id: String(seen.length) });
  };
  return { http, seen };
};

const posts = (seen: readonly HttpRequest[]) => seen.filter((req) => req.method === "POST");

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

const withState = async (run: (stateDir: string) => Promise<void> | void): Promise<void> => {
  const dir = mkdtempSync(join(tmpdir(), "discord-lane-"));
  try {
    await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const laneRecord = (stateDir: string, key: string, sessionId = "t46"): void => {
  mkdirSync(join(stateDir, "lanes"), { recursive: true });
  writeFileSync(
    join(stateDir, "lanes", `${key}.json`),
    JSON.stringify({
      key,
      title: key,
      thread: "none",
      brief: "",
      done: "",
      openedAt: "",
      sessionRef: { runtime: "hc", id: sessionId },
      status: "working",
    }),
  );
};

const sessionLog = (sessionsDir: string): string => {
  const dir = join(sessionsDir, "--Users-jib-.dori-superagent-workspace--");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "2026-11-17T10-00-00-000Z_01234567-89ab-cdef-0123-456789abcdef.jsonl");
  writeFileSync(path, "");
  return path;
};

const assistant = (text: string) =>
  `${JSON.stringify({ message: { role: "assistant", content: [{ type: "text", text }] } })}\n`;

/** The lane's runtime: it lists the lane by name, records what was typed into it, and its status is the test's. */
const laneRuntime = (status: { word: string }) => {
  const delivered: string[] = [];
  const rts = {
    for: () => ({
      list: async () => [{ ref: { runtime: "hc", id: "t46" }, name: "discord-chat", status: status.word }],
      deliver: async (_ref: unknown, text: string) => {
        delivered.push(text);
        status.word = "working";
        return { kind: "delivered" };
      },
      read: async () => "",
    }),
  } as unknown as ChosenRuntimes;
  return { rts, delivered };
};

const laneConfig = (stateDir: string): DoriConfig => ({
  ...defaultConfig(stateDir),
  runtime: "hc",
  leadPane: "discord-chat",
  stateDir,
  discordSelfId: SELF_ID,
  sessionsDir: join(stateDir, "sessions"),
  defaultCwd: "/Users/jib/.dori-superagent/workspace",
});

test(
  "the room's lane is handed the message, and its answer goes back through hooks.discordReply",
  { timeout: 30_000 },
  () =>
    withState(async (stateDir) => {
      laneRecord(stateDir, "discord-chat");
      const log = sessionLog(join(stateDir, "sessions"));
      const status = { word: "idle" };
      const { rts, delivered } = laneRuntime(status);
      const calls: string[][] = [];
      const run: Runner = async (argv): Promise<Ran> => {
        calls.push([...argv]);
        return { code: 0, out: "", err: "" };
      };
      const { http, seen } = fakeHttp();
      const replies = startLaneAnswers(
        new Discord(http, { now: () => 0, sleep: async () => {} }, "t"),
        {
          ...laneConfig(stateDir),
          hooks: { discordReply: ["dori", "send", "discord", "--to", "{channel}", "--text", "{text}"] },
        },
        rts,
        run,
        async () => log,
      );
      try {
        const pending = replies.enqueue(person());
        const deadline = Date.now() + 5_000;
        while (delivered.length === 0 && Date.now() < deadline) await Bun.sleep(10);
        appendFileSync(log, assistant(ANSWER));
        status.word = "idle";
        // The lane reads its answer only after its turn has ended, so the test waits for the turn it started to finish.
        expect(await pending).toBe(true);
      } finally {
        replies.stop();
      }
      expect(delivered[0]).toContain("msg=10");
      // The prompt is the message's name and nothing else: a line that reads like a standing order is repeated by a
      // lane that answers in prose, and the watchdog then sees one command run over and over.
      expect(delivered[0]).toBe(`디코 수신 · 채널=${CHANNEL} msg=10 · 세션기록=${log}`);
      expect(calls).toEqual([["dori", "send", "discord", "--to", CHANNEL, "--text", ANSWER]]);
      expect(posts(seen)).toHaveLength(0);
    }),
);

test("without hooks.discordReply the bridge posts the lane's answer to the room itself", { timeout: 30_000 }, () =>
  withState(async (stateDir) => {
    laneRecord(stateDir, "discord-chat");
    const log = sessionLog(join(stateDir, "sessions"));
    const status = { word: "idle" };
    const { rts } = laneRuntime(status);
    const { http, seen } = fakeHttp();
    const replies = startLaneAnswers(
      new Discord(http, { now: () => 0, sleep: async () => {} }, "t"),
      laneConfig(stateDir),
      rts,
      async () => ({ code: 0, out: "", err: "" }),
      async () => log,
    );
    try {
      const pending = replies.enqueue(person());
      const deadline = Date.now() + 5_000;
      while (!readFileSync(log, "utf8").includes("디코 수신") && Date.now() < deadline) await Bun.sleep(10);
      appendFileSync(log, assistant(ANSWER));
      // The lane reads its answer only after the turn it started has ended.
      status.word = "idle";
      expect(await pending).toBe(true);
    } finally {
      replies.stop();
    }
    const post = posts(seen)[0];
    expect(JSON.parse(String(post?.body))).toEqual({
      content: ANSWER,
      allowed_mentions: { parse: [] },
      message_reference: { message_id: "10", fail_if_not_exists: false },
    });
  }),
);
