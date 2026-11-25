/**
 * Asking a model for the next Mac action. DeepSeek goes straight to OmO's hive2 provider (its OpenAI-style API and
 * key from ~/.omo/agent): `omo -p` takes minutes to start and the briefing's own call already times out on it.
 * Sonnet is Claude Code headless on the owner's Claude subscription, no tools, one turn.
 */
import type { Tier } from "./mac-brain.ts";
import { askOmoProvider, type Thought } from "./omo-provider.ts";
import type { Runner } from "./run.ts";

export type ThinkConfig = {
  /** OmO provider DeepSeek is reached through, and its model id there. */
  readonly provider?: string;
  readonly deepseekModel?: string;
  /** Claude Code binary and model alias for the Sonnet tier. */
  readonly claude?: string;
  readonly sonnetModel?: string;
};
export type { Thought };

const ASK_MS = 120_000;

export const askDeepseek = (c: ThinkConfig, prompt: string): Promise<Thought> =>
  askOmoProvider(c.provider ?? "hive2", c.deepseekModel ?? "deepseek-ai/deepseek-v4.1-flash-1017", prompt, ASK_MS);

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
