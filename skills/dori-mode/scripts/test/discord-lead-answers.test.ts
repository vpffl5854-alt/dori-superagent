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

test("the line the pane writes first is not the answer: the room gets the last one, once the turn is over", () =>
  withState(async (stateDir) => {
    const sessionLog = join(stateDir, "lead.jsonl");
    const assistant = (text: string) =>
      `${JSON.stringify({ message: { role: "assistant", content: [{ type: "text", text }] } })}\n`;
    writeFileSync(sessionLog, "");
    const { http, seen } = fakeHttp(() => ok({ id: "99" }));
    let status = "idle";
    let workingReads = 0;
    const rts = {
      for: () => ({
        list: async () => {
          if (status === "working") workingReads++;
          return [{ ref: { runtime: "hc", id: "t74" }, status }];
        },
        deliver: async () => ({ kind: "delivered" }),
        read: async () => "",
      }),
    } as unknown as ChosenRuntimes;
    const replies = startDiscordReplies(
      new Discord(http, { now: () => 0, sleep: async () => {} }, "t"),
      stateDir,
      { ...config(stateDir), leadPane: "hc:t74" },
      undefined,
      rts,
      10,
    );
    try {
      expect(await replies.enqueue({ channel: "c1", messageId: "11", sessionPath: sessionLog })).toBe(true);
      status = "working";
      appendFileSync(sessionLog, assistant("방 글 하나 왔네 — 본문 확인하고 바로 답할게."));
      // The turn goes on with its tools while several reply polls see the first line.
      while (workingReads < 5) await Bun.sleep(5);
      expect(posts(seen)).toHaveLength(0);
      appendFileSync(sessionLog, assistant("sume은 이름이 같은 게 둘이라 어느 쪽인지에 따라 답이 갈려."));
      status = "idle";
      const deadline = Date.now() + 3_000;
      while (posts(seen).length === 0 && Date.now() < deadline) await Bun.sleep(5);
    } finally {
      replies.stop();
    }
    expect(posts(seen)).toHaveLength(1);
    expect(sent(posts(seen)[0])["content"]).toBe("sume은 이름이 같은 게 둘이라 어느 쪽인지에 따라 답이 갈려.");
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

test("a room message quoting code still reaches the lane, with look-alikes for the backtick and $(", () =>
  withState(async (stateDir) => {
    const sessionLog = join(stateDir, "lead.jsonl");
    writeFileSync(sessionLog, "");
    const delivered: string[] = [];
    const rts = {
      for: () => ({
        list: async () => [{ ref: { runtime: "hc", id: "t74" }, status: "idle" }],
        deliver: async (_ref: unknown, text: string) => {
          delivered.push(text);
          return { kind: "delivered" };
        },
        read: async () => "",
      }),
    } as unknown as ChosenRuntimes;
    const { http } = fakeHttp(() => ok({ id: "99" }));
    const replies = startDiscordReplies(
      new Discord(http, { now: () => 0, sleep: async () => {} }, "t"),
      stateDir,
      { ...config(stateDir), leadPane: "hc:t74" },
      undefined,
      rts,
      10,
    );
    try {
      const ok = await replies.enqueue({
        channel: "c1",
        messageId: "12",
        sessionPath: sessionLog,
        author: "상디",
        text: "모델은 `deepseek-v4.1` 이고 $(whoami) 는 실행 안 됨",
      });
      expect(ok).toBe(true);
    } finally {
      replies.stop();
    }
    expect(delivered.join("\n")).toContain("모델은 ˋdeepseek-v4.1ˋ 이고 $ (whoami) 는 실행 안 됨");
    expect(delivered.join("\n")).not.toMatch(/`|\$\(/);
  }));
