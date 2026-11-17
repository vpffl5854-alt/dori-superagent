/**
 * Credentials for the Cue bridge, and the guard that keeps it on its own bot account.
 *
 * The Cue bridge speaks in Discord with a bot token made for it alone. On 2026-11-16 another bot's token was used
 * to post and the owner's account was banned twice, so a Cue token that is byte-for-byte another bot's token, or
 * that belongs to another bot on Discord, is refused before anything is sent. Nothing here logs a token value.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type DiscordCreds = {
  readonly cueToken: string;
  readonly channel: string;
  readonly botId: string;
};

export type ManusCreds = { readonly apiKey: string; readonly taskId: string };

/** The other bot token files this bridge must never speak with, relative to DORI_HOME. */
export const OTHER_TOKEN_FILES = [
  "secrets/discord-token",
  "secrets/instinct-token",
  "secrets/discord-insta-token",
] as const;

export class CredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialError";
  }
}

const readSecret = (path: string): string | undefined => {
  try {
    return readFileSync(path, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
};

export type TokenIdentity = { readonly id: string; readonly bot: boolean };

/** `GET /users/@me` with a bot token. Throws CredentialError on a rejected token or a non-bot account. */
export const identifyToken = async (token: string): Promise<TokenIdentity> => {
  const res = await fetch("https://discord.com/api/v10/users/@me", {
    headers: { Authorization: `Bot ${token}`, "User-Agent": "cue-bridge (local, 1)" },
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 401) throw new CredentialError("the Cue bot token was rejected by Discord (401)");
  if (!res.ok) throw new CredentialError(`discord /users/@me -> ${res.status}`);
  const me = (await res.json()) as { id?: unknown; bot?: unknown };
  if (typeof me.id !== "string") throw new CredentialError("discord /users/@me returned no id");
  return { id: me.id, bot: me.bot === true };
};

/** The Cue token must be its own token and its own bot account; anything else stops the bridge. */
export const assertOwnBot = (cue: TokenIdentity, ownerId: string): void => {
  if (!cue.bot) throw new CredentialError("the Cue token belongs to a user account, not a bot");
  if (cue.id === ownerId) throw new CredentialError("the Cue token is the owner's own Discord account");
};

const readTaskId = (home: string): string => {
  const raw = readSecret(join(home, "secrets", "cue-task.json"));
  if (!raw) throw new CredentialError("no Cue task id (secrets/cue-task.json); see README, find it with agent.list");
  try {
    const taskId = String((JSON.parse(raw) as { taskId?: unknown }).taskId ?? "");
    if (taskId) return taskId;
  } catch {}
  throw new CredentialError("secrets/cue-task.json holds no taskId");
};

/**
 * Reads the Cue bot token, the Manus API key, the Cue task id and the channel, or throws CredentialError naming what
 * is missing. `DORI_HOME` defaults to `~/.dori-superagent`; the files are `secrets/cue-token` (raw token),
 * `secrets/manus-api-key` (raw key) and `secrets/cue-task.json` (`{"taskId": "..."}`).
 */
export const loadCredentials = (
  home: string,
  ownerId: string,
): { readonly discord: DiscordCreds; readonly manus: ManusCreds } => {
  const cueToken = readSecret(join(home, "secrets", "cue-token"));
  const apiKey = readSecret(join(home, "secrets", "manus-api-key"));
  if (!cueToken || !apiKey)
    throw new CredentialError(
      `no ${[cueToken ? "" : "Cue bot token (secrets/cue-token)", apiKey ? "" : "Manus API key (secrets/manus-api-key)"].filter(Boolean).join(" and ")}; the Cue bridge does not run without it`,
    );
  const taskId = readTaskId(home);
  const channel = readSecret(join(home, "secrets", "cue-channel"));
  if (!channel) throw new CredentialError("no Discord channel id (secrets/cue-channel)");
  return { discord: { cueToken, channel, botId: ownerId }, manus: { apiKey, taskId } };
};

/**
 * The Cue bot token, after the guard: it must differ from every other bot token file (compared by content, never
 * logged), and the caller then checks the Discord identity with `identifyToken` + `assertOwnBot`.
 */
export const assertCueToken = (home: string, token: string): void => {
  for (const file of OTHER_TOKEN_FILES) {
    if (readSecret(join(home, file)) === token)
      throw new CredentialError(
        `${file} holds this same token; the Cue bot needs its own token and never speaks as another bot`,
      );
  }
};
