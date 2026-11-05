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

type Row = { id: string; channel_id: string; guild_id?: string; content?: string; author?: { id?: string; username?: string; bot?: boolean } };

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
