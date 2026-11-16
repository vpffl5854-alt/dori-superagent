import type { Clock } from "../run.ts";
import { guardText, type Http, MessengerError, withBackoff } from "./http.ts";

const retryAfter = (body: string): number | undefined => {
  try {
    const n = (JSON.parse(body) as { retry_after?: number }).retry_after;
    return typeof n === "number" ? n : undefined;
  } catch {
    return undefined;
  }
};

export class Discord {
  constructor(
    private readonly http: Http,
    private readonly clock: Clock,
    private readonly botToken: string,
    private readonly base = "https://discord.com/api/v10",
  ) {}

  async call<T = unknown>(method: "GET" | "POST" | "PATCH", path: string, body?: Record<string, unknown>): Promise<T> {
    const res = await withBackoff(
      this.http,
      this.clock,
      {
        method,
        url: `${this.base}${path}`,
        headers: { Authorization: `Bot ${this.botToken}`, "Content-Type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      },
      undefined,
      retryAfter,
    );
    if (res.status >= 300)
      throw new MessengerError(`discord ${method} ${path}: ${res.status} ${res.body.slice(0, 160)}`, res.status);
    return (res.body ? JSON.parse(res.body) : {}) as T;
  }

  async send(channelId: string, content: string): Promise<string> {
    return (
      await this.call<{ id: string }>("POST", `/channels/${channelId}/messages`, {
        content: guardText(content),
        allowed_mentions: { parse: [] },
      })
    ).id;
  }

  async edit(channelId: string, messageId: string, content: string): Promise<void> {
    await this.call("PATCH", `/channels/${channelId}/messages/${messageId}`, { content: guardText(content) });
  }

  async typing(channelId: string): Promise<void> {
    await this.call("POST", `/channels/${channelId}/typing`);
  }

  async startThread(channelId: string, messageId: string, name: string): Promise<string> {
    return (
      await this.call<{ id: string }>("POST", `/channels/${channelId}/messages/${messageId}/threads`, {
        name: guardText(name).slice(0, 100),
      })
    ).id;
  }

  async setThread(threadId: string, patch: { readonly name?: string; readonly archived?: boolean }): Promise<void> {
    await this.call("PATCH", `/channels/${threadId}`, {
      ...(patch.name ? { name: guardText(patch.name).slice(0, 100) } : {}),
      ...(patch.archived !== undefined ? { archived: patch.archived } : {}),
    });
  }
}

export type GatewaySocket = { send(data: string): void; close(): void; onMessage(cb: (data: string) => void): void };

export const DISCORD_INTENTS_GUILD_MESSAGES = 1 << 9;

export const discordPresence = (
  open: () => GatewaySocket,
  token: string,
  clock: { setInterval: (cb: () => void, ms: number) => unknown; clearInterval: (h: unknown) => void },
) => {
  const ws = open();
  let seq: number | null = null;
  let beat: unknown;
  ws.onMessage((raw) => {
    const m = JSON.parse(raw) as { op: number; s?: number | null; d?: { heartbeat_interval?: number } };
    if (typeof m.s === "number") seq = m.s;
    if (m.op === 10 && m.d?.heartbeat_interval) {
      beat = clock.setInterval(() => ws.send(JSON.stringify({ op: 1, d: seq })), m.d.heartbeat_interval);
      ws.send(
        JSON.stringify({
          op: 2,
          d: {
            token,
            intents: DISCORD_INTENTS_GUILD_MESSAGES,
            properties: { os: process.platform, browser: "dori", device: "dori" },
            presence: { status: "online", since: null, activities: [], afk: false },
          },
        }),
      );
    }
  });
  return {
    close() {
      if (beat !== undefined) clock.clearInterval(beat);
      ws.close();
    },
  };
};
