import { expect, test } from "bun:test";

import { HELLO_TIMEOUT_MS, type Clock, type GatewaySocket } from "../src/messenger/discord-gateway.ts";
import { type GatewayState, GatewaySocketLoop } from "../src/messenger/discord-gateway-socket.ts";

/** A clock whose timers run only when the test says so, and sockets the test can close. */
const rig = () => {
  const timers: { cb: () => void; ms: number; id: number }[] = [];
  let next = 0;
  const clock: Clock = {
    setInterval: () => ++next,
    clearInterval: () => {},
    now: () => 0,
    setTimeout: (cb, ms) => {
      const id = ++next;
      timers.push({ cb, ms, id });
      return id;
    },
    clearTimeout: (h) => {
      const i = timers.findIndex((t) => t.id === h);
      if (i >= 0) timers.splice(i, 1);
    },
  };
  const sockets: { close: (why: string) => void; hello: () => void }[] = [];
  const open = (): GatewaySocket => {
    let onMsg: (d: string) => void = () => {};
    let onClose: (why: string) => void = () => {};
    sockets.push({
      close: (why) => onClose(why),
      hello: () => onMsg(JSON.stringify({ op: 10, d: { heartbeat_interval: 41250 } })),
    });
    return {
      send: () => {},
      close: () => {},
      onMessage: (cb) => {
        onMsg = cb;
      },
      onClose: (cb) => {
        onClose = cb;
      },
    };
  };
  const events: string[] = [];
  const state: GatewayState = {
    socket: null,
    beat: undefined,
    sequence: null,
    sessionId: null,
    acked: true,
    stopped: false,
    attempts: 0,
    connectedAt: 0,
    sessionStarts: [],
    restartTimer: undefined,
  };
  const loop = new GatewaySocketLoop(state, { open, token: "t", clock, onEvent: (l) => events.push(l) }, () => true);
  const fire = (pred: (t: { ms: number }) => boolean) => {
    const t = timers.find(pred);
    if (!t) throw new Error("no such timer");
    timers.splice(timers.indexOf(t), 1);
    t.cb();
  };
  return { loop, sockets, events, timers, fire };
};

test("a socket that closes is replaced: the loop schedules a reconnect and opens a new one", () => {
  const r = rig();
  r.loop.start();
  r.sockets[0]?.hello();
  r.sockets[0]?.close("closed 1006");
  expect(r.events).toContain("gateway socket closed 1006; reconnecting");
  r.fire((t) => t.ms !== HELLO_TIMEOUT_MS);
  expect(r.sockets).toHaveLength(2);
  r.loop.stop();
});

test("a new socket that never says hello is replaced too; one that does keeps no hello timer", () => {
  const r = rig();
  r.loop.start();
  r.fire((t) => t.ms === HELLO_TIMEOUT_MS);
  expect(r.events.some((e) => e.startsWith("gateway sent no hello"))).toBe(true);
  r.fire(() => true);
  expect(r.sockets).toHaveLength(2);
  r.sockets[1]?.hello();
  expect(r.timers.filter((t) => t.ms === HELLO_TIMEOUT_MS)).toHaveLength(0);
  r.loop.stop();
});
