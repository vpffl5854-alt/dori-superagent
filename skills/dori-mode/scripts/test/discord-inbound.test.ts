import { describe, expect, test } from "bun:test";
import {
  DiscordInbound,
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

const mediaRow = (id: string, channel: string): Row => ({
  ...row(id, channel, "someone", ""),
  attachments: [{ url: `https://cdn/${id}.png`, filename: `${id}.png` }],
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
  media?: MediaStore | null;
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
    opts.media ?? null,
    opts.cursors,
    history,
    opts.guild ?? (async () => "guild-1"),
  );
  return { inbound, delivered, events, calls };
};
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

describe("DiscordInbound delivery guarantee", () => {
  test("a media message's cursor moves only after its line is out", async () => {
    const cursorState = cursorStore({ ch1: "300" });
    let releaseSave = () => {};
    let saveStarted = () => {};
    const started = new Promise<void>((resolve) => (saveStarted = resolve));
    const media: MediaStore = {
      save: async (messageId) => {
        saveStarted();
        await new Promise<void>((resolve) => (releaseSave = resolve));
        return [`/state/${messageId}.png`];
      },
    };
    const h = harness({ cursors: cursorState.store, rowsFor: async () => newestFirst(mediaRow("301", "ch1")), media });

    h.inbound.start();
    await started;
    // The download is in flight: nothing has printed and the cursor must still be behind.
    expect(h.delivered).toEqual([]);
    expect(cursorState.writes).toEqual([]);

    releaseSave();
    await h.inbound.idle();

    expect(h.delivered.map((i) => i.media)).toEqual([["/state/301.png"]]);
    expect(cursorState.current()).toEqual({ ch1: "301" });
  });

  test("a text line waits for an earlier message's download instead of overtaking it", async () => {
    const cursorState = cursorStore({ ch1: "500" });
    let releaseSave = () => {};
    let saveStarted = () => {};
    const started = new Promise<void>((resolve) => (saveStarted = resolve));
    const order: string[] = [];
    const media: MediaStore = {
      save: async (messageId) => {
        saveStarted();
        await new Promise<void>((resolve) => (releaseSave = resolve));
        return [`/state/${messageId}.png`];
      },
    };
    const inbound = new DiscordInbound(
      silentSocket,
      "token",
      inertClock,
      "self",
      (i) => order.push(`LINE ${i.messageId}`),
      () => {},
      media,
      cursorState.store,
      async () => newestFirst(row("502", "ch1"), mediaRow("501", "ch1")),
      async () => "guild-1",
    );

    inbound.start();
    await started;
    expect(order).toEqual([]);

    releaseSave();
    await inbound.idle();

    expect(order).toEqual(["LINE 501", "LINE 502"]);
    expect(cursorState.current()).toEqual({ ch1: "502" });
  });

  test("a line that never came out leaves the cursor behind, so a restart prints the message again", async () => {
    const cursorState = cursorStore({ ch1: "400" });
    const attempts: string[] = [];
    const events: string[] = [];
    const inbound = new DiscordInbound(
      silentSocket,
      "token",
      inertClock,
      "self",
      () => {
        attempts.push("line");
        throw new Error("stdout closed");
      },
      (line) => events.push(line),
      null,
      cursorState.store,
      async () => newestFirst(row("401", "ch1")),
      async () => "guild-1",
    );

    inbound.start();
    await inbound.idle();

    expect(attempts).toEqual(["line"]);
    expect(cursorState.writes).toEqual([]);
    expect(events.some((e) => e.startsWith("delivery failed: stdout closed"))).toBe(true);
  });
});
