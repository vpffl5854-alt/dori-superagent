import { expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type DoriConfig, defaultConfig } from "../src/config.ts";
import { startDiscordReplies } from "../src/messenger/discord-answers.ts";
import { sessionPathForPane } from "../src/messenger/discord-pane.ts";
import { Discord } from "../src/messenger/discord.ts";
import type { Http, HttpRequest, HttpResponse } from "../src/messenger/http.ts";
import type { ChosenRuntimes } from "../src/run.ts";

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

const config = (stateDir: string): DoriConfig => ({
  ...defaultConfig("/tmp/dori-bot-replies"),
  stateDir,
  leadPane: "",
  discordSelfId: "dori-id",
});

const withState = async (run: (stateDir: string) => Promise<void> | void): Promise<void> => {
  const dir = mkdtempSync(join(tmpdir(), "discord-lead-answers-"));
  try {
    await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

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

test("the room's pane is found by its name when a restart gave it a new address", () =>
  withState(async (stateDir) => {
    const sessionsDir = join(stateDir, "sessions");
    const dir = join(sessionsDir, "--Users-jib-.dori-superagent-workspace--");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "2026-11-17T10-00-00-000Z_01234567-89ab-cdef-0123-456789abcdef.jsonl"), "");
    const rts = {
      for: () => ({
        list: async () => [
          { ref: { runtime: "hc", id: "t1t" }, name: "lead", cwd: "/tmp/lead" },
          { ref: { runtime: "hc", id: "t99" }, name: "discord-chat", cwd: "/Users/jib/.dori-superagent/workspace" },
        ],
      }),
    } as unknown as ChosenRuntimes;
    const config: DoriConfig = {
      ...defaultConfig(stateDir),
      runtime: "hc",
      leadPane: "discord-chat",
      sessionsDir,
      defaultCwd: "/Users/jib/.dori-superagent/workspace",
    };
    expect(await sessionPathForPane(config, rts)).toBe(
      join(dir, "2026-11-17T10-00-00-000Z_01234567-89ab-cdef-0123-456789abcdef.jsonl"),
    );
    // An address still wins when it is live; a name nothing carries falls back to the default directory, which has no
    // session log here.
    expect(await sessionPathForPane({ ...config, leadPane: "hc:t1t", defaultCwd: "/tmp/lead" }, rts)).toBeUndefined();
    expect(await sessionPathForPane({ ...config, leadPane: "nobody" }, rts)).toBe(
      join(dir, "2026-11-17T10-00-00-000Z_01234567-89ab-cdef-0123-456789abcdef.jsonl"),
    );
  }));
