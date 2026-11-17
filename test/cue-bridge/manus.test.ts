import { describe, expect, test } from "bun:test";

import type { HttpRequest } from "../../src/cue-bridge/manus.ts";
import { manusClient, parseMessages, rateLimiter, repliesAfter } from "../../src/cue-bridge/manus.ts";

describe("manus client", () => {
  test("sends the key in the header only, and posts the task id with the message", async () => {
    const seen: HttpRequest[] = [];
    const client = manusClient(async (req) => {
      seen.push(req);
      return { status: 200, body: JSON.stringify({ message_id: "m-1" }) };
    }, "key-abc");
    await client.sendMessage("task-1", "hello");
    const req = seen[0]!;
    expect(req.method).toBe("POST");
    expect(req.url).toBe("https://api.manus.ai/v2/task.sendMessage");
    expect(req.headers["x-manus-api-key"]).toBe("key-abc");
    expect(req.url).not.toContain("key-abc");
    expect(JSON.parse(req.body!)).toEqual({ task_id: "task-1", message: { content: "hello" } });
  });

  test("a rejected key names the key, never its value", async () => {
    const client = manusClient(async () => ({ status: 401, body: "{}" }), "key-abc");
    const err = await client.agentList().catch((e: unknown) => e);
    expect(String(err)).toContain("Manus API key was rejected");
    expect(String(err)).not.toContain("key-abc");
  });

  test("listMessages asks for the task's messages", async () => {
    const urls: string[] = [];
    const client = manusClient(async (req) => {
      urls.push(req.url);
      return { status: 200, body: "{}" };
    }, "k");
    await client.listMessages("task 1");
    expect(urls[0]).toBe("https://api.manus.ai/v2/task.listMessages?task_id=task%201");
  });
});

describe("rate limiter", () => {
  test("allows 10 a minute and makes the 11th wait for the first to age out", async () => {
    let t = 0;
    const waits: number[] = [];
    const limiter = rateLimiter(10, 60_000, {
      now: () => t,
      sleep: async (ms) => {
        waits.push(ms);
        t += ms;
      },
    });
    for (let i = 0; i < 10; i++) await limiter.take();
    await limiter.take();
    expect(waits).toEqual([60_000]);
    await limiter.take();
    expect(waits).toEqual([60_000]);
  });
});

describe("message parsing", () => {
  test("finds the list under data, messages or a bare array", () => {
    const rows = [{ id: "a", role: "user", content: "hi" }];
    expect(parseMessages({ data: { messages: rows } })).toEqual([{ id: "a", role: "user", content: "hi" }]);
    expect(parseMessages({ result: rows })).toEqual([{ id: "a", role: "user", content: "hi" }]);
    expect(parseMessages(rows)).toEqual([{ id: "a", role: "user", content: "hi" }]);
    expect(parseMessages({ error: "nope" })).toEqual([]);
  });

  test("replies after the sent message skip the owner's own messages", () => {
    const msgs = [
      { id: "1", role: "user", content: "old" },
      { id: "2", role: "assistant", content: "old reply" },
      { id: "3", role: "user", content: "new" },
      { id: "4", role: "assistant", content: "new reply" },
    ];
    expect(repliesAfter(msgs, "3").map((m) => m.id)).toEqual(["4"]);
    expect(repliesAfter(msgs, "not-in-the-list").map((m) => m.id)).toEqual([]);
  });
});
