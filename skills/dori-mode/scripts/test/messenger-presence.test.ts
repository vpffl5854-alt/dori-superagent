import { expect, test } from "bun:test";
import { discordPresence } from "../src/messenger/discord.ts";
import type { Http, HttpRequest, HttpResponse } from "../src/messenger/http.ts";
import { Slack } from "../src/messenger/slack.ts";
import { slackPresence } from "../src/messenger/slack-presence.ts";
import { typingWhile } from "../src/messenger/typing.ts";
import { transcribe, TranscriptionError } from "../src/messenger/voice.ts";
import { fakeClock } from "./fakes.ts";

type Script = (req: HttpRequest, n: number) => HttpResponse;

const fakeHttp = (script: Script) => {
  const seen: HttpRequest[] = [];
  const http: Http = async (req) => {
    seen.push(req);
    return script(req, seen.length);
  };
  return { http, seen };
};

const ok = (body: unknown, status = 200, headers: Record<string, string> = {}): HttpResponse => ({
  status,
  headers,
  body: JSON.stringify(body),
});

const sleeps = () => {
  const waited: number[] = [];
  const clock = {
    ...fakeClock(0),
    sleep: async (ms: number) => {
      waited.push(ms);
    },
  };
  return { clock, waited };
};

const fakeTimers = () => {
  const live = new Set<() => void>();
  return {
    live,
    timers: {
      setInterval: (cb: () => void) => {
        live.add(cb);
        return cb;
      },
      clearInterval: (h: unknown) => {
        live.delete(h as () => void);
      },
    },
    fire: () => {
      for (const cb of live) cb();
    },
  };
};

test("the typing indicator is sent at once, repeats while work runs, and stops when it ends even on failure", async () => {
  const sent: number[] = [];
  const t = fakeTimers();
  const send = async () => {
    sent.push(1);
  };
  const result = await typingWhile(send, t.timers, async () => {
    t.fire();
    t.fire();
    return 42;
  });
  expect(result).toBe(42);
  expect(sent).toHaveLength(3);
  expect(t.live.size).toBe(0);
  await expect(
    typingWhile(send, t.timers, async () => {
      throw new Error("boom");
    }),
  ).rejects.toThrow("boom");
  expect(t.live.size).toBe(0);
});

test("a voice note becomes text through the configured hook, and a failing or empty transcription is an error", async () => {
  const calls: string[][] = [];
  const run = async (argv: readonly string[]) => {
    calls.push([...argv]);
    return { code: 0, out: "  ship it  ", err: "" };
  };
  expect(await transcribe(run, ["stt", "--file", "{file}"], "/tmp/v 1.ogg")).toBe("ship it");
  expect(calls[0]).toEqual(["stt", "--file", "/tmp/v 1.ogg"]);
  await expect(
    transcribe(async () => ({ code: 0, out: "", err: "" }), ["stt", "{file}"], "/a.ogg"),
  ).rejects.toBeInstanceOf(TranscriptionError);
  await expect(transcribe(run, undefined, "/a.ogg")).rejects.toBeInstanceOf(TranscriptionError);
});

test("Slack presence opens one client-type socket with the cookie, then only tickles it; release closes it and sets away", async () => {
  const { http, seen } = fakeHttp((req) =>
    req.url.endsWith("client.getWebSocketURL")
      ? ok({ ok: true, primary_websocket_url: "wss://wss-primary.example/", routing_context: "gw-1" })
      : ok({ ok: true }),
  );
  const frames: string[] = [];
  let opened: { url: string; headers: Record<string, string> } | null = null;
  let open = false;
  const p = slackPresence(
    new Slack(http, sleeps().clock, { token: "xt", cookie: "dc" }),
    (url, headers) => {
      opened = { url, headers: { ...headers } };
      open = true;
      return {
        isOpen: () => open,
        send: (f) => frames.push(f),
        close: () => {
          open = false;
        },
      };
    },
    { token: "xt", cookie: "dc" },
  );
  expect(await p.hold()).toBe("opened");
  expect(await p.hold()).toBe("tickled");
  expect(await p.hold()).toBe("tickled");
  const url = new URL(opened!.url);
  expect(url.searchParams.get("slack_client")).toBe("desktop");
  expect(url.searchParams.get("gateway_server")).toBe("gw-1");
  expect(opened!.headers).toEqual({ Cookie: "d=dc", Origin: "https://app.slack.com" });
  expect(frames.map((f) => JSON.parse(f).type)).toEqual(["tickle", "tickle"]);
  await p.release();
  expect(open).toBe(false);
  expect(
    seen.filter((r) => r.url.endsWith("users.setPresence")).map((r) => JSON.parse(String(r.body)).presence),
  ).toEqual(["auto", "away"]);
});

test("Discord presence identifies as online after hello, heartbeats with the last sequence, and stops beating on close", () => {
  const sent: string[] = [];
  let onMsg: (d: string) => void = () => {};
  const t = fakeTimers();
  let closed = false;
  const p = discordPresence(
    () => ({
      send: (d) => sent.push(d),
      close: () => {
        closed = true;
      },
      onMessage: (cb) => {
        onMsg = cb;
      },
    }),
    "BOT",
    t.timers,
  );
  onMsg(JSON.stringify({ op: 10, d: { heartbeat_interval: 41250 } }));
  onMsg(JSON.stringify({ op: 0, s: 3, t: "READY", d: {} }));
  t.fire();
  const identify = JSON.parse(sent[0] ?? "{}");
  expect(identify.op).toBe(2);
  expect(identify.d.presence.status).toBe("online");
  expect(JSON.parse(sent[1] ?? "{}")).toEqual({ op: 1, d: 3 });
  p.close();
  expect(closed).toBe(true);
  expect(t.live.size).toBe(0);
});
