import { describe, expect, test } from "bun:test";
import { DiscordInbound, type Clock } from "../src/messenger/discord-inbound.ts";

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

describe("DiscordInbound reconnect safety (#87 review)", () => {
  test("op 9 waits a random 1-5 s before identifying again instead of reconnecting at once", () => {
    const clock = manualClock();
    const g = gateway(clock.clock);
    g.inbound.start();
    expect(g.sockets).toHaveLength(1);

    g.sockets[0]!.deliver({ op: 9, d: false });

    expect(g.sockets).toHaveLength(1);
    const delays = clock.live.filter((t) => t.ms >= 1000 && t.ms <= 5000);
    expect(delays).toHaveLength(1);
    delays[0]!.cb();
    expect(g.sockets).toHaveLength(2);
  });

  test("repeated op 9 frames back off, so a storm cannot open a socket per frame", () => {
    const clock = manualClock();
    const g = gateway(clock.clock);
    g.inbound.start();

    g.sockets[0]!.deliver({ op: 9, d: false });
    const first = clock.live.filter((t) => t.ms >= 1000 && t.ms <= 5000);
    first[0]!.cb();
    g.sockets[1]!.deliver({ op: 9, d: false });
    // The delay is random before the backoff doubles it: the first wait is 1-5 s, the second 2-10 s, so
    // the second is only sometimes longer. What must hold is that the base delay doubled.
    const second = clock.live.filter((t) => t.ms >= 1000 && t.ms <= 60_000 && !first.includes(t));
    expect(second).toHaveLength(1);
    expect(second[0]!.ms).toBeGreaterThanOrEqual(2_000);
    expect(second[0]!.ms).toBeLessThanOrEqual(10_000);
    expect(g.sockets).toHaveLength(2);
  });

  test("a fatal close code stops the loop instead of identifying forever", () => {
    const clock = manualClock();
    const g = gateway(clock.clock);
    g.inbound.start();

    g.sockets[0]!.closeWith(4004, "Authentication failed");

    expect(g.sockets).toHaveLength(1);
    expect(clock.live.filter((t) => t.ms >= 1000 && t.ms <= 60_000)).toHaveLength(0);
    expect(g.events.some((e) => e.includes("4004"))).toBe(true);
  });

  test("a non-fatal close code reconnects after a delay", () => {
    const clock = manualClock();
    const g = gateway(clock.clock);
    g.inbound.start();

    g.sockets[0]!.closeWith(1006, "");

    const delay = clock.live.filter((t) => t.ms >= 1000 && t.ms <= 5000);
    expect(delay).toHaveLength(1);
    delay[0]!.cb();
    expect(g.sockets).toHaveLength(2);
  });
});
