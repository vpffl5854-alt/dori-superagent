import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RelayConfig, RelayDeps, RelayState } from "../../src/cue-bridge/relay.ts";
import {
  emptyState,
  forwardDiscord,
  ownerTexts,
  readState,
  relayReplies,
  sentMessageId,
  writeState,
} from "../../src/cue-bridge/relay.ts";

const config: RelayConfig = {
  channel: "chan-1",
  owner: "owner-1",
  botId: "cue-bot-1",
  taskId: "task-1",
  pollMs: 1,
  replyTimeoutMs: 180_000,
};

type Harness = {
  readonly deps: RelayDeps;
  readonly sent: string[];
  readonly posted: string[];
  readonly saves: RelayState[];
  readonly waits: number[];
  page: unknown[];
  replies: unknown;
  t: number;
};

const harness = (): Harness => {
  const h: Harness = {
    sent: [],
    posted: [],
    saves: [],
    waits: [],
    page: [],
    replies: { data: { messages: [] } },
    t: 1_000,
    deps: {} as RelayDeps,
  };
  const deps: RelayDeps = {
    discord: {
      history: async () => h.page,
      send: async (_channel, content) => {
        h.posted.push(content);
        return "posted-1";
      },
    },
    manus: {
      sendMessage: async (_task, content) => {
        h.sent.push(content);
        return { message_id: `sent-${h.sent.length}` };
      },
      listMessages: async () => h.replies,
    },
    limiter: {
      take: async () => {
        h.waits.push(h.t);
      },
    },
    save: (state) => h.saves.push(state),
    log: () => {},
    now: () => h.t,
  };
  return Object.assign(h, { deps });
};

const ownerMsg = (id: string, content: string) => ({ id, author: { id: "owner-1" }, content });

describe("discord side", () => {
  test("only the owner's plain text is taken, and the newest id is the cursor", () => {
    const page = [
      ownerMsg("10", "hello"),
      { id: "11", author: { id: "cue-bot-1", bot: true }, content: "a bot reply" },
      { id: "12", author: { id: "someone-else" }, content: "not mine" },
      ownerMsg("13", "   "),
    ];
    const { texts, newest } = ownerTexts(page, "owner-1");
    expect(texts).toEqual([{ id: "10", text: "hello" }]);
    expect(newest).toBe("13");
  });

  test("a message goes to Cue before the cursor passes it, and the reply poll is keyed on its id", async () => {
    const h = harness();
    h.page = [ownerMsg("20", "안녕 큐")];
    const next = await forwardDiscord(h.deps, config, emptyState);
    expect(h.sent).toEqual(["[디코→큐] 안녕 큐"]);
    expect(next.discordAfter).toBe("20");
    expect(next.awaiting).toEqual({ sentId: "sent-1", sinceMs: 1_000 });
    expect(h.saves.at(-1)).toEqual(next);
  });

  test("while Cue has not answered, a further message is skipped rather than queued", async () => {
    const h = harness();
    h.page = [ownerMsg("21", "second"), ownerMsg("22", "third")];
    const start: RelayState = { discordAfter: "20", awaiting: { sentId: "sent-1", sinceMs: 1_000 }, lastPosted: "" };
    const next = await forwardDiscord(h.deps, config, start);
    expect(h.sent).toEqual([]);
    expect(next.discordAfter).toBe("22");
    expect(next.awaiting).toEqual(start.awaiting);
  });

  test("a page with nothing to send still moves the cursor past bot posts", async () => {
    const h = harness();
    h.page = [{ id: "30", author: { id: "cue-bot-1", bot: true }, content: "posted by the bridge" }];
    const next = await forwardDiscord(h.deps, config, emptyState);
    expect(h.sent).toEqual([]);
    expect(next.discordAfter).toBe("30");
  });
});

describe("cue side", () => {
  test("Cue's reply after the sent message is posted once and clears the wait", async () => {
    const h = harness();
    h.replies = {
      data: {
        messages: [
          { id: "sent-1", role: "user", content: "old" },
          { id: "r-1", role: "assistant", content: "큐 답" },
        ],
      },
    };
    const start: RelayState = { discordAfter: "20", awaiting: { sentId: "sent-1", sinceMs: 1_000 }, lastPosted: "" };
    const next = await relayReplies(h.deps, config, start);
    expect(h.posted).toEqual(["큐: 큐 답"]);
    expect(next.awaiting).toBeNull();
    expect(next.lastPosted).toBe("r-1");
  });

  test("a reply that predates the sent message is not posted", async () => {
    const h = harness();
    h.replies = { messages: [{ id: "old", role: "assistant", content: "stale" }] };
    const start: RelayState = { discordAfter: "20", awaiting: { sentId: "sent-1", sinceMs: 1_000 }, lastPosted: "" };
    const next = await relayReplies(h.deps, config, start);
    expect(h.posted).toEqual([]);
    expect(next).toEqual(start);
  });

  test("a message already posted is not posted again", async () => {
    const h = harness();
    h.replies = { messages: [{ id: "r-1", role: "assistant", content: "again" }] };
    const start: RelayState = { discordAfter: "20", awaiting: { sentId: "sent-1", sinceMs: 1_000 }, lastPosted: "r-1" };
    expect((await relayReplies(h.deps, config, start)).awaiting).not.toBeNull();
  });

  test("after the reply window the wait is dropped so the bridge keeps going", async () => {
    const h = harness();
    h.t = 1_000 + 180_001;
    const start: RelayState = { discordAfter: "20", awaiting: { sentId: "sent-1", sinceMs: 1_000 }, lastPosted: "" };
    const next = await relayReplies(h.deps, config, start);
    expect(next.awaiting).toBeNull();
    expect(h.posted).toEqual([]);
  });
});

describe("relay state", () => {
  test("round-trips through the state file and survives a broken one", () => {
    const file = join(mkdtempSync(join(tmpdir(), "cue-state-")), "cue-bridge.json");
    const state: RelayState = { discordAfter: "42", awaiting: { sentId: "sent-9", sinceMs: 5 }, lastPosted: "r-2" };
    writeState(file, state);
    expect(readState(file)).toEqual(state);
    expect(readState(join(tmpdir(), "missing-cue-state.json"))).toEqual(emptyState);
  });

  test("the sent message id is read from the response, with a fallback", () => {
    expect(sentMessageId({ message_id: "m-1" })).toBe("m-1");
    expect(sentMessageId({ data: { message: { id: "m-2" } } })).toBe("m-2");
    expect(sentMessageId({})).toMatch(/^sent-\d+$/);
  });
});
