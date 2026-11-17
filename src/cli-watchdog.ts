import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { one, USAGE, type Args } from "./cli-args.ts";
import { Refusal } from "./refusal.ts";
import { DEFAULT_HARD_LIMIT_MIN, hardLimitPass, keepNames, runHardLimit } from "./hard-timeout.ts";
import type { Deps } from "./harness.ts";
import { acquire, release } from "./loop-lock.ts";

const positive = (a: Args, flag: string, fallback: number): number => {
  const raw = one(a, flag);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!(Number.isFinite(n) && n > 0)) throw new Refusal(`--${flag} must be a positive number`);
  return n;
};

export async function runWatchdog(d: Deps, a: Args, x: string | undefined): Promise<number> {
  if (x !== undefined) throw new Refusal(`unknown watchdog command ${x}\n\n${USAGE}`);
  const limitMin = positive(a, "limit-min", DEFAULT_HARD_LIMIT_MIN);
  const intervalSec = positive(a, "interval", 60);
  const opts = { limitMin, keep: keepNames(d), log: (line: string) => void process.stderr.write(`dori: ${line}\n`) };
  if (one(a, "once")) {
    for (const e of await hardLimitPass(d, opts))
      console.log(`HARD_TIMEOUT ${[e.pane, e.action].filter(Boolean).join(" ")}${e.detail ? `: ${e.detail}` : ""}`);
    return 0;
  }
  // Two watchers would race to close the same pane; the second logs it and leaves.
  const lock = d.store.lockPath("watchdog");
  const held = acquire(d, lock);
  if ("holder" in held) throw new Refusal(`another watchdog runs in this home (${held.holder})`);
  mkdirSync(join(d.store.root, "logs"), { recursive: true });
  console.log(`WATCHDOG limit=${limitMin}min interval=${intervalSec}s`);
  try {
    await runHardLimit(d, { ...opts, intervalMs: intervalSec * 1000 });
  } finally {
    release(d, held.nonce, lock);
  }
  return 0;
}
