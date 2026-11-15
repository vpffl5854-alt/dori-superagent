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

  async call<T = unknown>(
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
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

  async send(channelId: string, content: string, replyTo?: string): Promise<string> {
    return (
      await this.call<{ id: string }>("POST", `/channels/${channelId}/messages`, {
        content: guardText(content),
        allowed_mentions: { parse: [] },
        ...(replyTo ? { message_reference: { message_id: replyTo, fail_if_not_exists: false } } : {}),
      })
    ).id;
  }

  async edit(channelId: string, messageId: string, content: string): Promise<void> {
    await this.call("PATCH", `/channels/${channelId}/messages/${messageId}`, { content: guardText(content) });
  }

  async typing(channelId: string): Promise<void> {
    await this.call("POST", `/channels/${channelId}/typing`);
  }

  /**
   * Adds a reaction. `emoji` is either a unicode character or `name:id` for a custom
   * emoji; the two forms go in different fields, so the shape of the string decides.
   * Discord percent-encodes the emoji in the path — a bare character sent raw is
   * rejected with 400 on some clients.
   */
  async react(channelId: string, messageId: string, emoji: string): Promise<void> {
    const raw = emoji.trim();
    if (!raw) throw new MessengerError("discord react: empty emoji", 400);
    const custom = /^[a-zA-Z0-9_]+:\d{5,}$/.test(raw);
    const enc = custom ? raw : encodeURIComponent(raw);
    await this.call("PUT", `/channels/${channelId}/messages/${messageId}/reactions/${enc}/@me`);
  }

  /** Removes the bot's own reaction, which is how a read receipt gets cleared. */
  async unreact(channelId: string, messageId: string, emoji: string): Promise<void> {
    const raw = emoji.trim();
    if (!raw) throw new MessengerError("discord unreact: empty emoji", 400);
    const custom = /^[a-zA-Z0-9_]+:\d{5,}$/.test(raw);
    const enc = custom ? raw : encodeURIComponent(raw);
    await this.call("DELETE", `/channels/${channelId}/messages/${messageId}/reactions/${enc}/@me`);
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
