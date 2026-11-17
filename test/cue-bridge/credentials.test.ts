import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assertCueToken, CredentialError, identifyToken, loadCredentials } from "../../src/cue-bridge/credentials.ts";

const home = (files: Record<string, string>): string => {
  const dir = mkdtempSync(join(tmpdir(), "cue-home-"));
  for (const [rel, value] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), value);
  }
  return dir;
};

const complete = {
  "secrets/cue-token": "cue-token-value\n",
  "secrets/manus-api-key": "manus-key-value\n",
  "secrets/cue-task.json": JSON.stringify({ taskId: "task-cue-1" }),
  "secrets/cue-channel": "1555125672106663990\n",
};

describe("cue credentials", () => {
  test("loads the Cue token, Manus key, task id and channel", () => {
    const { discord, manus } = loadCredentials(home(complete), "owner-1");
    expect(discord.cueToken).toBe("cue-token-value");
    expect(discord.channel).toBe("1555125672106663990");
    expect(manus.apiKey).toBe("manus-key-value");
    expect(manus.taskId).toBe("task-cue-1");
  });

  test("without the Cue token or the Manus key it says which one is missing", () => {
    expect(() => loadCredentials(home({}), "owner-1")).toThrow(
      "no Cue bot token (secrets/cue-token) and Manus API key (secrets/manus-api-key)",
    );
    const { ["secrets/cue-token"]: _drop, ...noToken } = complete;
    expect(() => loadCredentials(home(noToken), "owner-1")).toThrow("no Cue bot token (secrets/cue-token)");
    const { ["secrets/manus-api-key"]: _key, ...noKey } = complete;
    expect(() => loadCredentials(home(noKey), "owner-1")).toThrow("no Manus API key (secrets/manus-api-key)");
  });

  test("a placeholder task id or channel is refused instead of run", () => {
    expect(() => loadCredentials(home({ ...complete, "secrets/cue-task.json": "{}" }), "owner-1")).toThrow(
      "secrets/cue-task.json holds no taskId",
    );
    expect(() => loadCredentials(home({ ...complete, "secrets/cue-channel": "  " }), "owner-1")).toThrow(
      "no Discord channel id",
    );
  });

  test("a Cue token equal to the dori, instinct or insta token dies", () => {
    for (const file of ["secrets/discord-token", "secrets/instinct-token", "secrets/discord-insta-token"]) {
      const dir = home({ ...complete, [file]: "cue-token-value\n" });
      expect(() => assertCueToken(dir, "cue-token-value")).toThrow(`${file} holds this same token`);
      expect(() => assertCueToken(dir, "cue-token-value")).toThrow(CredentialError);
    }
  });

  test("a different token, or an absent other token file, passes the guard", () => {
    expect(() => assertCueToken(home(complete), "cue-token-value")).not.toThrow();
    expect(() =>
      assertCueToken(home({ ...complete, "secrets/discord-token": "dori-value\n" }), "cue-token-value"),
    ).not.toThrow();
  });

  test("identifyToken refuses a rejected token without echoing it", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("{}", { status: 401 }) });
    const original = globalThis.fetch;
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) =>
      original(String(input).replace("https://discord.com", `http://localhost:${server.port}`), init)) as typeof fetch;
    try {
      const err = await identifyToken("secret-value").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CredentialError);
      expect(String(err)).toContain("rejected");
      expect(String(err)).not.toContain("secret-value");
    } finally {
      globalThis.fetch = original;
      server.stop(true);
    }
  });
});
