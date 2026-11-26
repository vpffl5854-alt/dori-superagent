/** Where the nightly fixer works and keeps its files (cli-fixer.ts, cli-fixer-decide.ts). */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { die } from "./cli-context.ts";
import type { DoriConfig } from "./config.ts";

export type FixerConfig = {
  /** Dori's own repository: the live folder the services run, the remote and branch fixes go to. */
  readonly live?: string;
  readonly remote?: string;
  readonly branch?: string;
  readonly repo?: string;
  /** The clone the hunted issues are fixed in (remote origin upstream, remote fork the owner's fork). */
  readonly huntClone?: string;
  readonly budgetMin?: number;
};

export const readJson = <T>(path: string): T | undefined => {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
};
export const harnessOf = (config: DoriConfig): readonly string[] =>
  (config as { incidents?: { harness?: readonly string[] } }).incidents?.harness ?? die("no incidents.harness");
export const cfgOf = (config: DoriConfig) => {
  const c = (config as { fixer?: FixerConfig }).fixer ?? {};
  const home = dirname(config.stateDir);
  return {
    live: c.live ?? join(process.env["HOME"] ?? "", "dori-superagent"),
    remote: c.remote ?? "mine",
    branch: c.branch ?? "discord-lane-answer",
    repo: c.repo ?? "vpffl5854-alt/dori-superagent",
    huntClone: c.huntClone ?? join(home, "workspace", "hunt", "bun", "src"),
    budgetMin: c.budgetMin ?? 45,
    home,
    dir: join(config.stateDir, "fixer"),
  };
};
export const resultPath = (dir: string, key: string): string => join(dir, `${key}.json`);
