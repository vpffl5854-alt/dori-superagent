/**
 * One question to a model on one of OmO's API providers (its OpenAI-style endpoint and key from ~/.omo/agent), with
 * no agent around it. `omo -p` starts a whole agent session and takes minutes, long enough that the briefing's
 * rewrite and the Mac head both timed out on it.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type Thought = { readonly text: string } | { readonly error: string };

const provider = (name: string, home: string): { baseUrl: string; key: string } | undefined => {
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

/** "hive2/deepseek-ai/deepseek-v4.1-flash-1017" -> provider "hive2", model "deepseek-ai/deepseek-v4.1-flash-1017". */
export const splitModel = (ref: string): { provider: string; model: string } | undefined => {
  const i = ref.indexOf("/");
  return i > 0 && i < ref.length - 1 ? { provider: ref.slice(0, i), model: ref.slice(i + 1) } : undefined;
};

export const askOmoProvider = async (
  name: string,
  model: string,
  prompt: string,
  timeoutMs: number,
  /** Room for the answer: a reasoning model spends most of it thinking, and a cut-off answer comes back empty. */
  maxTokens = 8_000,
  home = process.env["HOME"] ?? "",
): Promise<Thought> => {
  const p = provider(name, home);
  if (!p) return { error: `no OmO provider ${name}` };
  try {
    const res = await fetch(`${p.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${p.key}` },
      body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], max_tokens: maxTokens }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = (await res.json().catch(() => ({}))) as {
      choices?: { message?: { content?: string }; finish_reason?: string }[];
    };
    const choice = body.choices?.[0];
    const text = choice?.message?.content?.trim();
    return text
      ? { text }
      : { error: `${name} answered ${res.status} with no text (finish ${choice?.finish_reason ?? "?"})` };
  } catch (e) {
    return { error: `${name}: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200) };
  }
};

/** The answer text to a question for a "provider/model" ref, or "" when the model could not be asked. */
export const askRef = async (ref: string, prompt: string, timeoutMs: number, maxTokens = 16_000): Promise<string> => {
  const m = splitModel(ref);
  if (!m) return "";
  const r = await askOmoProvider(m.provider, m.model, prompt, timeoutMs, maxTokens);
  if ("error" in r) console.log(`MODEL_ASK_FAILED ${r.error}`);
  return "text" in r ? r.text : "";
};
