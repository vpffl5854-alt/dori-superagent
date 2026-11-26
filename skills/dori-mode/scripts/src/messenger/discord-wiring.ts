/**
 * Discord gateway wiring for `dori inbound discord` in this space.
 *
 * A copy made 2026-11-15 when this space was installed. It was read out of the Kakao/Instagram
 * space's checkout (`~/.dori/src`) so both spaces can receive Discord messages, but nothing is
 * shared at run time: this space reads its own token file and writes its own state. Editing one
 * copy must never be assumed to change the other.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

import { die } from "../cli-context.ts";
import { fetchHttp, withBackoff } from "./http.ts";
import type { ChannelGuild, ChannelHistory, CursorStore, GatewaySocket, MediaStore } from "./discord-gateway.ts";
import { realClock, run } from "../run.ts";

export const discordToken = (home: string = homedir()): string => {
  const fromEnv = process.env["DORI_DISCORD_TOKEN"];
  if (fromEnv) return fromEnv;
  const file = `${home}/.dori-superagent/secrets/discord-token`;
  try {
    const value = readFileSync(file, "utf8").trim();
    if (value) return value;
  } catch {}
  return die(`DORI_DISCORD_TOKEN is not set (and ${file} was not readable)`);
};

const MAX_MEDIA_BYTES = 10 * 1024 * 1024;

const EXT_BY_TYPE: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "video/mp4": "mp4",
  "video/webm": "webm",
};

export const mediaStore = (stateDir: string): MediaStore => {
  const dir = `${stateDir}/discord-media`;
  return {
    save: async (messageId, index, ref) => {
      const res = await fetch(ref.url);
      if (!res.ok) throw new Error(`GET ${ref.url} -> ${res.status}`);
      const declared = Number(res.headers.get("content-length") ?? "0");
      if (declared > MAX_MEDIA_BYTES)
        throw new Error(`${ref.url} is ${declared} bytes, past the ${MAX_MEDIA_BYTES} limit`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.byteLength > MAX_MEDIA_BYTES)
        throw new Error(`${ref.url} is ${bytes.byteLength} bytes, past the ${MAX_MEDIA_BYTES} limit`);
      const type = (res.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
      const ext = EXT_BY_TYPE[type] ?? ref.name.split(".").pop()?.toLowerCase().slice(0, 8) ?? "bin";
      mkdirSync(dir, { recursive: true });
      const base = `${dir}/${messageId}-${index}`;
      const path = `${base}.${ext}`;
      writeFileSync(path, bytes);
      if (!type.startsWith("video/")) return [path];
      const frame = `${base}.png`;
      const ff = await run(["ffmpeg", "-y", "-loglevel", "error", "-ss", "0.5", "-i", path, "-frames:v", "1", frame], {
        timeoutMs: 20_000,
      });
      return ff.code === 0 && existsSync(frame) ? [frame, path] : [path];
    },
  };
};

export const discordWhoAmI = async (token: string): Promise<string> => {
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

export const inboundCursors = (stateDir: string): CursorStore => {
  const path = `${stateDir}/discord-inbound-cursors.json`;
  const read = async (): Promise<Record<string, string>> => {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      const out: Record<string, string> = {};
      for (const [channel, id] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof id === "string" && id) out[channel] = id;
      }
      return out;
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

export const channelHistory =
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

export const channelGuild =
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

export const surviveCrashes = (label: string): void => {
  const report = (kind: string) => (e: unknown) => {
    const detail = e instanceof Error ? (e.stack ?? e.message) : String(e);
    console.error(`${label} ${kind}: ${detail}`);
  };
  process.on("uncaughtException", report("uncaughtException"));
  process.on("unhandledRejection", report("unhandledRejection"));
};

export const openGatewaySocket = (): GatewaySocket => {
  const ws = new WebSocket("wss://gateway.discord.gg/?v=10&encoding=json");
  let handler: (d: string) => void = () => {};
  ws.addEventListener("message", (e) => handler(String(e.data)));
  let closed: (why: string) => void = () => {};
  let told = false;
  const tell = (why: string) => {
    if (told) return;
    told = true;
    closed(why);
  };
  ws.addEventListener("close", (e) => tell(`closed ${e.code}${e.reason ? ` ${e.reason}` : ""}`));
  ws.addEventListener("error", () => tell("error"));
  return {
    send: (d) => ws.send(d),
    close: () => ws.close(),
    onMessage: (cb) => {
      handler = cb;
    },
    onClose: (cb) => {
      closed = cb;
    },
  };
};
