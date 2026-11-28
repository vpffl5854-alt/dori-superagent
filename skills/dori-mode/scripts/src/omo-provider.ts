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

/** A question with a picture: the text, then the image as a data URL (OpenAI-style content parts). */
export const withImage = (text: string, bytes: Uint8Array, mime = "image/jpeg"): unknown[] => [
  { type: "text", text },
  { type: "image_url", image_url: { url: `data:${mime};base64,${Buffer.from(bytes).toString("base64")}` } },
];

/** The provider's own words for a refused call: its `message`, or the `error.message` of an OpenAI-style body. */
const refusal = (body: unknown): string => {
  const b = body as { message?: unknown; error?: { message?: unknown } };
  const message = typeof b?.message === "string" ? b.message : b?.error?.message;
  return typeof message === "string" && message ? `: ${message.slice(0, 120)}` : "";
};

export const askOmoProvider = async (
  name: string,
  model: string,
  prompt: string | readonly unknown[],
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
      message?: unknown;
      error?: { message?: unknown };
    };
    const choice = body.choices?.[0];
    const text = choice?.message?.content?.trim();
    if (text) return { text };
    if (!res.ok) return { error: `${name} answered ${res.status}${refusal(body)}` };
    // A reasoning model spends the budget thinking before it writes: `length` with no content means the whole
    // allowance went to thought, not that the model had nothing to say.
    return {
      error:
        choice?.finish_reason === "length"
          ? `${name} spent all ${maxTokens} tokens thinking and answered with nothing`
          : `${name} answered ${res.status} with no text (finish ${choice?.finish_reason ?? "?"})`,
    };
  } catch (e) {
    return { error: `${name}: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200) };
  }
};

/**
 * One question for a "provider/model" ref, the answer or the reason there is none: a caller that only wants text
 * must still be able to say why the ask failed, so an empty answer is never reported as a bad reply.
 */
export const askRef = async (
  ref: string,
  prompt: string,
  timeoutMs: number,
  maxTokens = 16_000,
  home = process.env["HOME"] ?? "",
): Promise<Thought> => {
  const m = splitModel(ref);
  if (!m) return { error: `no provider/model in "${ref}"` };
  const r = await askOmoProvider(m.provider, m.model, prompt, timeoutMs, maxTokens, home);
  // stderr: the caller's stdout is discarded when a slot fails, so a reason printed there is never read.
  if ("error" in r) console.error(`MODEL_ASK_FAILED ${r.error}`);
  return r;
};
