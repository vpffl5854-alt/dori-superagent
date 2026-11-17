#!/usr/bin/env bun
/**
 * cue-bridge entry point. Run it with `bun src/cue-bridge/main.ts`; it needs the Cue bot token, the Manus API key,
 * the Cue task id and the channel id, and refuses to run on a placeholder or on another bot's token.
 *
 * Subcommands: `agents` lists the Manus agents (find Cue's task id there once the key exists), `check` loads the
 * credentials and the guard without touching Discord or Manus.
 */
import { existsSync, mkdirSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { DiscordCreds } from "./credentials.ts";
import { assertCueToken, assertOwnBot, CredentialError, identifyToken, loadCredentials } from "./credentials.ts";
import { fetchHttp, manusClient, rateLimiter, SEND_PER_MINUTE } from "./manus.ts";
import type { RelayConfig, RelayDeps, RelayState } from "./relay.ts";
import { readState, runRelay, writeState } from "./relay.ts";

const HOME = process.env["DORI_HOME"] ?? join(homedir(), ".dori-superagent");
const STATE_FILE = join(HOME, "state", "cue-bridge.json");
const LOG_FILE = join(HOME, "logs", "cue-bridge.log");
const OWNER = process.env["CUE_BRIDGE_OWNER"] ?? "1555125670588190830";
const POLL_MS = Number(process.env["CUE_BRIDGE_POLL_MS"] ?? 3000);
const REPLY_TIMEOUT_MS = Number(process.env["CUE_BRIDGE_REPLY_TIMEOUT_MS"] ?? 180_000);

const log = (line: string): void => {
  const stamped = `${new Date().toISOString()} ${line}`;
  console.log(stamped);
  mkdirSync(join(HOME, "logs"), { recursive: true });
  appendFileSync(LOG_FILE, `${stamped}\n`);
};

const discordCall = async (token: string, method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> => {
  const res = await fetchHttp({
    method,
    url: `https://discord.com/api/v10${path}`,
    headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (res.status >= 300) throw new Error(`discord ${method} ${path.split("?")[0]} -> ${res.status}`);
  return res.body ? (JSON.parse(res.body) as unknown) : {};
};

const guarded = async (): Promise<{
  readonly discord: DiscordCreds;
  readonly apiKey: string;
  readonly taskId: string;
}> => {
  const { discord, manus } = loadCredentials(HOME, OWNER);
  assertCueToken(HOME, discord.cueToken);
  const me = await identifyToken(discord.cueToken);
  assertOwnBot(me, OWNER);
  const owner = await discordCall(discord.cueToken, "GET", `/channels/${discord.channel}`).catch(() => null);
  if (!owner)
    throw new CredentialError(`the Cue bot cannot see channel ${discord.channel}; invite it to the room first`);
  log(`GUARD OK cue bot=${me.id} channel=${discord.channel} task=${manus.taskId}`);
  return { discord: { ...discord, botId: me.id }, apiKey: manus.apiKey, taskId: manus.taskId };
};

const agents = async (): Promise<void> => {
  const apiKey = loadCredentials(HOME, OWNER).manus.apiKey;
  const list = await manusClient(fetchHttp, apiKey).agentList();
  console.log(JSON.stringify(list, null, 2));
};

const main = async (): Promise<void> => {
  if (process.argv[2] === "agents") {
    await agents();
    return;
  }
  const { discord, apiKey, taskId } = await guarded();
  if (process.argv[2] === "check") return;
  const manus = manusClient(fetchHttp, apiKey);
  const config: RelayConfig = {
    channel: discord.channel,
    owner: OWNER,
    botId: discord.botId,
    taskId,
    pollMs: POLL_MS,
    replyTimeoutMs: REPLY_TIMEOUT_MS,
  };
  let state: RelayState;
  if (existsSync(STATE_FILE)) state = readState(STATE_FILE);
  else {
    const page = (await discordCall(discord.cueToken, "GET", `/channels/${discord.channel}/messages?limit=1`)) as {
      id: string;
    }[];
    state = readState(STATE_FILE);
    state = { ...state, discordAfter: page[0]?.id ?? "0" };
    writeState(STATE_FILE, state);
  }
  log(
    `START channel=${config.channel} bot=${config.botId} after=${state.discordAfter} awaiting=${state.awaiting?.sentId ?? "-"}`,
  );
  const deps: RelayDeps = {
    discord: {
      history: async (channel, after, limit) =>
        (await discordCall(
          discord.cueToken,
          "GET",
          `/channels/${channel}/messages?after=${after}&limit=${limit}`,
        )) as unknown[],
      send: (channel, content) =>
        discordCall(discord.cueToken, "POST", `/channels/${channel}/messages`, {
          content,
          allowed_mentions: { parse: [] },
        }),
    },
    manus,
    limiter: rateLimiter(SEND_PER_MINUTE, 60_000, { now: () => Date.now(), sleep: (ms) => Bun.sleep(ms) }),
    save: (next) => writeState(STATE_FILE, next),
    log,
    now: () => Date.now(),
  };
  await runRelay(deps, config, state);
};

if (import.meta.main) {
  main().catch((e: unknown) => {
    log(`FATAL ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
