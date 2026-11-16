import { describe, expect, test } from "bun:test";
import { DiscordInbound, type Clock, type CursorStore, type InboundCursors } from "../src/messenger/discord-inbound.ts";

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

type Timer = { cb: () => void; ms: number };

/** Keeps every timer the class arms, even after clearInterval, so a test can fire a callback the
 * clock had already queued and prove it cannot touch the socket that replaced it. */

const manualClock = () => {
  const live: Timer[] = [];
  const all: Timer[] = [];
  const cleared: unknown[] = [];
  const clock: Clock = {
    setInterval: (cb, ms) => {
      const t = { cb, ms };
      all.push(t);
      live.push(t);
      return t;
    },
    clearInterval: (h) => {
      cleared.push(h);
      const i = live.indexOf(h as Timer);
      if (i >= 0) live.splice(i, 1);
    },
    setTimeout: (cb, ms) => {
      const t = { cb, ms };
      all.push(t);
      live.push(t);
      return t;
    },
    clearTimeout: (h) => {
      cleared.push(h);
      const i = live.indexOf(h as Timer);
      if (i >= 0) live.splice(i, 1);
    },
  };
  return { clock, live, all, cleared };
};

const fakeSocket = () => {
  const sent: Record<string, unknown>[] = [];
  let handler: (data: string) => void = () => {};
  let closer: (code: number, reason: string) => void = () => {};
  const s = {
    sent,
    closes: 0,
    send: (data: string) => void sent.push(JSON.parse(data) as Record<string, unknown>),
    close: () => void s.closes++,
    onMessage: (cb: (data: string) => void) => {
      handler = cb;
    },
    onClose: (cb: (code: number, reason: string) => void) => {
      closer = cb;
    },
    deliver: (payload: unknown) => handler(JSON.stringify(payload)),
    /** HELLO is always the first frame Discord sends, on every connection. */
    hello: (interval = 1000) => s.deliver({ op: 10, d: { heartbeat_interval: interval } }),
    closeWith: (code: number, reason = "") => closer(code, reason),
  };
  return s;
};

const gateway = (clock: Clock) => {
  const sockets: ReturnType<typeof fakeSocket>[] = [];
  const open = () => {
    const s = fakeSocket();
    sockets.push(s);
    return s;
  };
  const events: string[] = [];
  const inbound = new DiscordInbound(
    open,
    "token",
    clock,
    "self",
    () => {},
    (line) => events.push(line),
  );
  return { sockets, events, inbound };
};

describe("DiscordInbound cursor safety (#87 review)", () => {
  const ready = (s: { deliver: (p: unknown) => void }) => s.deliver({ op: 0, t: "READY", d: { session_id: "s1" } });

  test("a live message does not move a channel's cursor while that channel's catch-up is still running", async () => {
    const cursorState = cursorStore({ ch1: "100" });
    let releaseHistory = () => {};
    let historyStarted = () => {};
    const started = new Promise<void>((resolve) => (historyStarted = resolve));
    const clock = manualClock();
    const g = gateway(clock.clock);
    const inbound = new DiscordInbound(
      () => {
        const s = fakeSocket();
        g.sockets.push(s);
        return s;
      },
      "token",
      clock.clock,
      "self",
      () => {},
      (line) => g.events.push(line),
      null,
      cursorState.store,
      async () => {
        historyStarted();
        await new Promise<void>((resolve) => (releaseHistory = resolve));
        return newestFirst(row("101", "ch1"));
      },
      async () => "guild-1",
    );

    inbound.start();
    await started;

    g.sockets[0]!.deliver({ op: 0, t: "MESSAGE_CREATE", d: row("150", "ch1") });
    expect(cursorState.current()).toEqual({ ch1: "100" });

    releaseHistory();
    await inbound.idle();
    expect(cursorState.current()).toEqual({ ch1: "101" });

    g.sockets[0]!.deliver({ op: 0, t: "MESSAGE_CREATE", d: row("151", "ch1") });
    await inbound.idle();
    expect(cursorState.current()).toEqual({ ch1: "151" });
  });
  test("a catch-up that stopped early leaves the cursor behind, and the next live message cannot overtake the gap", async () => {
    const cursorState = cursorStore({ ch1: "100" });
    const clock = manualClock();
    const g = gateway(clock.clock);
    let fail = true;
    const inbound = new DiscordInbound(
      () => {
        const s = fakeSocket();
        g.sockets.push(s);
        return s;
      },
      "token",
      clock.clock,
      "self",
      () => {},
      (line) => g.events.push(line),
      null,
      cursorState.store,
      async () => {
        if (fail) throw new Error("502 bad gateway");
        return [];
      },
      async () => "guild-1",
    );

    inbound.start();
    await inbound.idle();
    expect(g.events).toContain("backfill stopped for ch1: 502 bad gateway");

    g.sockets[0]!.deliver({ op: 0, t: "MESSAGE_CREATE", d: row("150", "ch1") });
    await inbound.idle();
    expect(cursorState.current()).toEqual({ ch1: "100" });

    fail = false;
    ready(g.sockets[0]!);
    await inbound.idle();

    g.sockets[0]!.deliver({ op: 0, t: "MESSAGE_CREATE", d: row("151", "ch1") });
    await inbound.idle();
    expect(cursorState.current()).toEqual({ ch1: "151" });
  });

  test("a fresh identify after op 9 runs catch-up again, so the outage window is replayed", async () => {
    const cursorState = cursorStore({ ch1: "100" });
    const clock = manualClock();
    const g = gateway(clock.clock);
    const calls: { channel: string; after: string }[] = [];
    const inbound = new DiscordInbound(
      () => {
        const s = fakeSocket();
        g.sockets.push(s);
        return s;
      },
      "token",
      clock.clock,
      "self",
      () => {},
      (line) => g.events.push(line),
      null,
      cursorState.store,
      async (channel, after) => {
        calls.push({ channel, after });
        return [];
      },
      async () => "guild-1",
    );

    inbound.start();
    await inbound.idle();
    expect(calls).toHaveLength(1);

    g.sockets[0]!.deliver({ op: 9, d: false });
    const delay = clock.live.find((t) => t.ms >= 1000 && t.ms <= 5000);
    expect(delay).toBeDefined();
    delay!.cb();

    ready(g.sockets.at(-1)!);
    await inbound.idle();
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual({ channel: "ch1", after: "100" });
  });
});
