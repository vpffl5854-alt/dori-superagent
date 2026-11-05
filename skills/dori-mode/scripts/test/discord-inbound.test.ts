import { describe, expect, test } from "bun:test";
import {
  DiscordInbound,
  formatInbound,
  type ChannelGuild,
  type ChannelHistory,
  type Clock,
  type CursorStore,
  type GatewaySocket,
  type Inbound,
  type InboundCursors,
  type MediaStore,
} from "../src/messenger/discord-inbound.ts";

const inertClock: Clock = { setInterval: () => 1, clearInterval: () => {} };

const silentSocket = (): GatewaySocket => ({ send: () => {}, close: () => {}, onMessage: () => {} });

const cursorStore = (initial: InboundCursors) => {
  const writes: InboundCursors[] = [];
  let current: InboundCursors = initial;
  const store: CursorStore = {
    read: async () => current,
    write: async (next) => {
      writes.push(next);
      current = next;
    },
  };
  return { store, writes, current: () => current };
};

type Row = {
  id: string;
  channel_id: string;
  guild_id?: string;
  content?: string;
  author?: { id?: string; username?: string; bot?: boolean };
  attachments?: readonly unknown[];
};

const row = (id: string, channel: string, authorId = "someone", content = `m${id}`): Row => ({
  id,
  channel_id: channel,
  content,
  author: { id: authorId, username: `user-${authorId}` },
});

const newestFirst = (...rows: Row[]): readonly unknown[] => rows;

type Harness = {
  inbound: DiscordInbound;
  delivered: Inbound[];
  events: string[];
  calls: { channel: string; after: string }[];
};

const harness = (opts: {
  cursors: CursorStore;
  rowsFor: (channel: string, after: string) => Promise<readonly unknown[]>;
  selfId?: string;
  guild?: ChannelGuild;
}): Harness => {
  const delivered: Inbound[] = [];
  const events: string[] = [];
  const calls: { channel: string; after: string }[] = [];
  const history: ChannelHistory = async (channel, after) => {
    calls.push({ channel, after });
    return opts.rowsFor(channel, after);
  };
  const inbound = new DiscordInbound(
    silentSocket,
    "token",
    inertClock,
    opts.selfId ?? "self",
    (i) => delivered.push(i),
    (line) => events.push(line),
    null,
    opts.cursors,
    history,
    opts.guild ?? (async () => "guild-1"),
  );
  return { inbound, delivered, events, calls };
};

describe("DiscordInbound delivery order", () => {
  test("a long message is printed whole, so a reader can see all of it", async () => {
    const long = "x".repeat(2_000);
    const cursorState = cursorStore({ ch1: "300" });
    const h = harness({
      cursors: cursorState.store,
      rowsFor: async () => newestFirst(row("301", "ch1", "someone", long)),
    });

    h.inbound.start();
    await h.inbound.idle();

    expect(h.delivered.map((i) => i.text)).toEqual([long]);
    const line = formatInbound(h.delivered[0]!);
    expect(line.endsWith(JSON.stringify(long))).toBe(true);
    expect(line.includes("truncated")).toBe(false);
  });

  const mediaRow = (id: string, channel: string): Row => ({
    ...row(id, channel),
    attachments: [{ url: `https://cdn.example/${id}.png`, filename: `${id}.png` }],
  });

  test("a media message's cursor moves only after its line is printed", async () => {
    const order: string[] = [];
    let release: () => void = () => {};
    const saved = new Promise<void>((resolve) => {
      release = resolve;
    });
    const store: MediaStore = {
      save: async (messageId) => {
        order.push(`media-start ${messageId}`);
        await saved;
        order.push(`media-end ${messageId}`);
        return [`/tmp/${messageId}.png`];
      },
    };
    const delivered: Inbound[] = [];
    const inbound = new DiscordInbound(
      silentSocket,
      "token",
      inertClock,
      "self",
      (i) => {
        order.push(`LINE ${i.messageId}`);
        delivered.push(i);
      },
      () => {},
      store,
      {
        read: async () => ({ ch1: "400" }),
        write: async (next) => {
          order.push(`cursor-write ${next["ch1"]}`);
        },
      },
      async () => newestFirst(mediaRow("401", "ch1")),
      async () => "guild-1",
    );

    inbound.start();
    await Promise.resolve();
    await Promise.resolve();
    expect(order.some((o) => o.startsWith("cursor-write"))).toBe(false);
    release();
    await inbound.idle();

    expect(delivered.map((i) => i.messageId)).toEqual(["401"]);
    const lineAt = order.indexOf("LINE 401");
    const cursorAt = order.findIndex((o) => o.startsWith("cursor-write"));
    expect(lineAt).toBeGreaterThanOrEqual(0);
    expect(cursorAt).toBeGreaterThan(lineAt);
  });
});

describe("DiscordInbound backfill", () => {
  test("delivers the messages after the stored cursor in order and moves the cursor to the newest", async () => {
    const cursorState = cursorStore({ ch1: "100" });
    const h = harness({
      cursors: cursorState.store,
      rowsFor: async () => newestFirst(row("103", "ch1"), row("102", "ch1"), row("101", "ch1")),
    });

    h.inbound.start();
    await h.inbound.idle();

    expect(h.calls).toEqual([{ channel: "ch1", after: "100" }]);
    expect(h.delivered.map((i) => i.messageId)).toEqual(["101", "102", "103"]);
    expect(h.delivered.map((i) => i.text)).toEqual(["m101", "m102", "m103"]);
    expect(h.delivered.every((i) => i.source === "guild" && i.guild === "guild-1")).toBe(true);
    expect(cursorState.current()).toEqual({ ch1: "103" });
    expect(cursorState.writes.at(-1)).toEqual({ ch1: "103" });
    expect(h.events.some((e) => e.startsWith("backfill fetched 3 message(s) in ch1, delivered 3"))).toBe(true);
  });

  test("a message the bot itself posted is not delivered, but the cursor still passes it", async () => {
    const cursorState = cursorStore({ ch1: "200" });
    const h = harness({
      cursors: cursorState.store,
      rowsFor: async () => newestFirst(row("202", "ch1", "self"), row("201", "ch1")),
      selfId: "self",
    });

    h.inbound.start();
    await h.inbound.idle();

    expect(h.delivered.map((i) => i.messageId)).toEqual(["201"]);
    expect(cursorState.current()).toEqual({ ch1: "202" });
  });

  test("a failing history call stops that channel's backfill and leaves the reason on onEvent", async () => {
    const cursorState = cursorStore({ ch1: "100" });
    const h = harness({
      cursors: cursorState.store,
      rowsFor: async () => {
        throw new Error("502 bad gateway");
      },
    });

    h.inbound.start();
    await h.inbound.idle();

    expect(h.calls).toEqual([{ channel: "ch1", after: "100" }]);
    expect(h.delivered).toEqual([]);
    expect(cursorState.writes).toEqual([]);
    expect(h.events).toContain("backfill stopped for ch1: 502 bad gateway");
  });
});
