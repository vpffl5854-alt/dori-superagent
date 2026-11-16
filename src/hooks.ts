import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Deps } from "./harness.ts";

/** An argv template: element 0 is the command; placeholders are substituted per element and never shell-expanded. */
export type ArgvTemplate = readonly string[];

export type Hooks = {
  readonly onReady?: ArgvTemplate;
  readonly onReport?: ArgvTemplate;
  readonly onLost?: ArgvTemplate;
  readonly reviewCommand?: ArgvTemplate;
};

export type HookName = keyof Hooks;
export type HookVars = Partial<Record<"key" | "text" | "evidence" | "pr" | "repo" | "number" | "sha", string>>;

/** `$DORI_HOME/config.json` is present but its `hooks` value is not the documented shape. */
export class ConfigError extends Error {}

const NAMES: readonly HookName[] = ["onReady", "onReport", "onLost", "reviewCommand"];

function template(name: string, value: unknown): ArgvTemplate {
  if (!Array.isArray(value) || value.length === 0)
    throw new ConfigError(`config.json: hooks.${name} must be a non-empty array of strings (an argv template)`);
  const argv: string[] = [];
  for (const element of value) {
    if (typeof element !== "string")
      throw new ConfigError(`config.json: hooks.${name} must contain only strings, got ${JSON.stringify(element)}`);
    argv.push(element);
  }
  return argv;
}

/** Reads `hooks` from `<root>/config.json`. No file or no `hooks` key = no hooks; other keys are ignored. */
export function loadHooks(root: string): Hooks {
  const path = join(root, "config.json");
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new ConfigError(`config.json is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new ConfigError("config.json must be a JSON object");
  const raw: unknown = Reflect.get(parsed, "hooks");
  if (raw === undefined) return {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw new ConfigError("config.json: hooks must be an object");
  const hooks: { -readonly [K in HookName]?: ArgvTemplate } = {};
  for (const name of NAMES) {
    const value: unknown = Reflect.get(raw, name);
    if (value !== undefined) hooks[name] = template(name, value);
  }
  return hooks;
}

/** Substitutes `{key}`, `{text}`, `{evidence}`, `{pr}`, `{repo}`, `{number}`, `{sha}` inside each element. */
export function substitute(argv: ArgvTemplate, vars: HookVars): string[] {
  return argv.map((element) =>
    element.replace(/\{(key|text|evidence|pr|repo|number|sha)\}/g, (whole, k: keyof HookVars) => vars[k] ?? whole),
  );
}

/** A started hook: `kill` is set once its process is spawned; a killed hook's own exit is not reported again. */
type Running = { readonly name: HookName; kill?: () => void; killed?: boolean };
const pending = new Map<Promise<void>, Running>();

/** How long the CLI waits for hooks still running at exit; a slower hook is killed and reported as timed out. */
export const HOOK_SETTLE_MS = 2000;

/**
 * Resolves once every hook started so far has finished, or after `ms`: a hook that hangs never keeps a command from
 * exiting: each hook still running is killed, then gets one `timed out` line. The CLI awaits it before exiting.
 */
export async function hooksSettled(ms: number = HOOK_SETTLE_MS): Promise<void> {
  if (pending.size === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ms);
  });
  const outcome = await Promise.race([Promise.all([...pending.keys()]).then(() => "done" as const), deadline]);
  clearTimeout(timer);
  if (outcome === "timeout") {
    for (const hook of pending.values()) {
      hook.killed = true;
      hook.kill?.();
      process.stderr.write(`dori: hook ${hook.name} failed (timed out after ${ms} ms)\n`);
    }
  }
}

const firstLine = (s: string): string => s.trim().split("\n")[0] ?? "";

/**
 * Runs a lifecycle hook fire-and-forget: the caller never waits for it and it never throws. A bad config, a spawn
 * error or a non-zero exit writes one stderr line. The returned promise is only for callers that want to await it.
 */
export function runHook(d: Deps, name: Exclude<HookName, "reviewCommand">, vars: HookVars): Promise<void> {
  const hook: Running = { name };
  const fail = (why: string) => {
    if (hook.killed) return;
    process.stderr.write(`dori: hook ${name} failed (${why})\n`);
  };
  const run = async (): Promise<void> => {
    try {
      const argv = loadHooks(d.store.root)[name];
      if (!argv) return;
      const [cmd, ...rest] = substitute(argv, vars);
      if (cmd === undefined) return;
      const res = await d.exec(cmd, rest, {
        onSpawn: (proc) => {
          hook.kill = () => proc.kill();
        },
      });
      if (res.code !== 0) fail(firstLine(res.stderr) || `exit ${res.code}`);
    } catch (e) {
      fail(firstLine(e instanceof Error ? e.message : String(e)));
    }
  };
  const p = run();
  pending.set(p, hook);
  void p.finally(() => pending.delete(p));
  return p;
}
