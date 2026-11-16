/** What `dori inbound discord` needs from Discord: the bot's id, REST history and guild lookups, the gateway socket, and a media store. */
import { readFileSync, renameSync, writeFileSync } from "node:fs";

import { die } from "./cli-context.ts";
import { DiscordInbound, formatInbound } from "./messenger/discord-inbound.ts";
import type { ChannelGuild, ChannelHistory, CursorStore, GatewaySocket, Inbound } from "./messenger/discord-types.ts";
import { mediaStore } from "./messenger/discord-media-store.ts";
import { fetchHttp, withBackoff } from "./messenger/http.ts";
import { realTimers } from "./messenger/typing.ts";
import { realClock } from "./run.ts";

const discordWhoAmI = async (token: string): Promise<string> => {
  const res = await fetchHttp({
    method: "GET",
    url: "https://discord.com/api/v10/users/@me",
    headers: { Authorization: `Bot ${token}` },
  });
  if (res.status >= 300) die(`discord /users/@me failed: ${res.status} ${res.body.slice(0, 120)}`);
  const id = (JSON.parse(res.body) as { id?: string }).id;
  if (!id) return die("discord /users/@me returned no id");
  return id;
};

/** Per-channel cursors, written through a temp file so a crash mid-write cannot leave a truncated JSON. */
const inboundCursors = (stateDir: string): CursorStore => {
  const path = `${stateDir}/discord-inbound-cursors.json`;
  const read = async (): Promise<Record<string, string>> => {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      const cursors: Record<string, string> = {};
      for (const [channel, id] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof id === "string" && id) cursors[channel] = id;
      }
      return cursors;
    } catch {
      return {};
    }
  };
  return {
    read,
    write: async (cursors) => {
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(cursors, null, 2)}\n`);
      renameSync(tmp, path);
    },
  };
};

/** Discord REST history for one channel; a channel the bot cannot read is empty, not fatal. */
const channelHistory =
  (token: string): ChannelHistory =>
  async (channel, after, limit) => {
    const url = `https://discord.com/api/v10/channels/${channel}/messages?after=${after}&limit=${limit}`;
    const res = await withBackoff(
      fetchHttp,
      realClock,
      { method: "GET", url, headers: { Authorization: `Bot ${token}` } },
      undefined,
      (body) => {
        try {
          const parsed = JSON.parse(body) as { retry_after?: unknown };
          return typeof parsed.retry_after === "number" ? parsed.retry_after : undefined;
        } catch {
          return undefined;
        }
      },
    );
    if (res.status === 403 || res.status === 404) return [];
    if (res.status >= 300) throw new Error(`GET ${channel} messages -> ${res.status} ${res.body.slice(0, 120)}`);
    const parsed = JSON.parse(res.body) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  };

const channelGuild =
  (token: string): ChannelGuild =>
  async (channel) => {
    const res = await fetchHttp({
      method: "GET",
      url: `https://discord.com/api/v10/channels/${channel}`,
      headers: { Authorization: `Bot ${token}` },
    });
    if (res.status >= 300) throw new Error(`GET ${channel} -> ${res.status} ${res.body.slice(0, 120)}`);
    const parsed = JSON.parse(res.body) as { guild_id?: unknown };
    return typeof parsed.guild_id === "string" ? parsed.guild_id : null;
  };

const openGatewaySocket = (): GatewaySocket => {
  const ws = new WebSocket("wss://gateway.discord.gg/?v=10&encoding=json");
  let handler: (d: string) => void = () => {};
  let closer: (code: number, reason: string) => void = () => {};
  ws.addEventListener("message", (e) => handler(String(e.data)));
  ws.addEventListener("close", (e) => closer(Number(e.code ?? 0), String(e.reason ?? "")));
  return {
    send: (d) => ws.send(d),
    close: () => ws.close(),
    onMessage: (cb) => {
      handler = cb;
    },
    onClose: (cb) => {
      closer = cb;
    },
  };
};

export const discordInbound = async (stateDir: string): Promise<void> => {
  const token = process.env["DORI_DISCORD_TOKEN"] ?? die("DORI_DISCORD_TOKEN is not set");
  const me = await discordWhoAmI(token);
  const inbound = new DiscordInbound(
    () => openGatewaySocket(),
    token,
    realTimers,
    me,
    (i: Inbound) => console.log(formatInbound(i)),
    (line) => console.error(`[${new Date().toISOString().replace(/\.\d+Z$/, "Z")}] discord gateway: ${line}`),
    mediaStore(stateDir),
    inboundCursors(stateDir),
    channelHistory(token),
    channelGuild(token),
  );
  inbound.start();
  console.log("INBOUND_READY discord");
  await new Promise(() => {});
};
