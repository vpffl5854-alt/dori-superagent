/**
 * Asking a model for the next Mac action. DeepSeek goes straight to OmO's hive2 provider (its OpenAI-style API and
 * key from ~/.omo/agent): `omo -p` takes minutes to start and the briefing's own call already times out on it.
 * Sonnet is Claude Code headless on the owner's Claude subscription, no tools, one turn.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Tier } from "./mac-brain.ts";
import type { Runner } from "./run.ts";

export type ThinkConfig = {
  /** OmO provider DeepSeek is reached through, and its model id there. */
  readonly provider?: string;
  readonly deepseekModel?: string;
  /** Claude Code binary and model alias for the Sonnet tier. */
  readonly claude?: string;
  readonly sonnetModel?: string;
};
export type Thought = { readonly text: string } | { readonly error: string };

const ASK_MS = 120_000;

const omoProvider = (name: string, home: string): { baseUrl: string; key: string } | undefined => {
  const agent = join(home, ".omo", "agent");
  if (!existsSync(join(agent, "models.json")) || !existsSync(join(agent, "auth.json"))) return undefined;
  const models = JSON.parse(readFileSync(join(agent, "models.json"), "utf8")) as {
    providers?: Record<string, { baseUrl?: string }>;
  };
  const auth = JSON.parse(readFileSync(join(agent, "auth.json"), "utf8")) as Record<string, { key?: string }>;
  const baseUrl = (models.providers ?? (models as Record<string, { baseUrl?: string }>))[name]?.baseUrl;
  const key = auth[name]?.key;
  return baseUrl && key ? { baseUrl, key } : undefined;
};

export const askDeepseek = async (
  c: ThinkConfig,
  prompt: string,
  home = process.env["HOME"] ?? "",
): Promise<Thought> => {
  const p = omoProvider(c.provider ?? "hive2", home);
  if (!p) return { error: `no OmO provider ${c.provider ?? "hive2"}` };
  try {
    const res = await fetch(`${p.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${p.key}` },
      body: JSON.stringify({
        model: c.deepseekModel ?? "deepseek-ai/deepseek-v4.1-flash-1017",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 2_000,
      }),
      signal: AbortSignal.timeout(ASK_MS),
    });
    const body = (await res.json().catch(() => ({}))) as { choices?: { message?: { content?: string } }[] };
    const text = body.choices?.[0]?.message?.content?.trim();
    return text ? { text } : { error: `deepseek answered ${res.status} with no text` };
  } catch (e) {
    return { error: `deepseek: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200) };
  }
};

export const askSonnet = async (c: ThinkConfig, prompt: string, run: Runner, cwd: string): Promise<Thought> => {
  const r = await run(
    [
      c.claude ?? "claude",
      "-p",
      "--model",
      c.sonnetModel ?? "sonnet",
      "--output-format",
      "json",
      "--max-turns",
      "1",
      "--tools",
      "",
      "--",
      prompt,
    ],
    { cwd, timeoutMs: ASK_MS },
  );
  let o: { result?: string; is_error?: boolean } = {};
  try {
    o = JSON.parse(r.out) as typeof o;
  } catch {}
  if (r.code !== 0 || o.is_error || !o.result)
    return { error: `sonnet: ${(o.result ?? r.err ?? `exit ${r.code}`).slice(0, 200)}` };
  return { text: o.result };
};

export const ask = (tier: Tier, c: ThinkConfig, prompt: string, run: Runner, cwd: string): Promise<Thought> =>
  tier === "sonnet" ? askSonnet(c, prompt, run, cwd) : askDeepseek(c, prompt);
