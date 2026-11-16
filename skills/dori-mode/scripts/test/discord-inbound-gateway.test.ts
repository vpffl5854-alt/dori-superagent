import { describe, expect, test } from "bun:test";
import { DiscordInbound, HELLO_WAIT_MS, type Clock } from "../src/messenger/discord-inbound.ts";

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

describe("DiscordInbound HELLO wait", () => {
  test("a socket that connects but never sends HELLO is closed, reconnected once, and the reason is reported", () => {
    const clock = manualClock();
    const g = gateway(clock.clock);
    g.inbound.start();

    expect(g.sockets).toHaveLength(1);
    const wait = clock.all.filter((t) => t.ms === HELLO_WAIT_MS);
    expect(wait).toHaveLength(1);

    wait[0]!.cb();

    expect(g.sockets[0]!.closes).toBe(1);
    expect(g.sockets).toHaveLength(1);
    const delay = clock.live.filter((t) => t.ms >= 1000 && t.ms <= 5000);
    expect(delay).toHaveLength(1);
    delay[0]!.cb();
    expect(g.sockets).toHaveLength(2);
    expect(g.events).toEqual([`gateway sent no HELLO within ${HELLO_WAIT_MS / 1000}s; reconnecting`]);
    // The replacement socket is watched by its own HELLO timer, and the fired one is gone.
    expect(clock.all.filter((t) => t.ms === HELLO_WAIT_MS)).toHaveLength(2);
    expect(clock.live.filter((t) => t.ms === HELLO_WAIT_MS)).toHaveLength(1);
  });

  test("HELLO clears the wait timer, and the callback the clock had already queued cannot close the healthy socket", () => {
    const clock = manualClock();
    const g = gateway(clock.clock);
    g.inbound.start();
    const wait = clock.all.find((t) => t.ms === HELLO_WAIT_MS)!;

    g.sockets[0]!.hello(30_000);

    expect(clock.cleared).toContain(wait);
    expect(clock.live).not.toContain(wait);
    expect(clock.live.filter((t) => t.ms === 30_000)).toHaveLength(1);

    wait.cb();

    expect(g.sockets).toHaveLength(1);
    expect(g.sockets[0]!.closes).toBe(0);
    expect(g.events.filter((e) => e.includes("HELLO"))).toEqual([]);
  });

  test("after stop() the HELLO wait is cleared, and a queued callback or a late HELLO reconnects nothing", () => {
    const clock = manualClock();
    const g = gateway(clock.clock);
    g.inbound.start();
    const wait = clock.all.find((t) => t.ms === HELLO_WAIT_MS)!;

    g.inbound.stop();
    expect(clock.live).toEqual([]);

    wait.cb();
    g.sockets[0]!.hello();

    expect(g.sockets).toHaveLength(1);
    expect(g.events).toEqual([]);
  });
});
