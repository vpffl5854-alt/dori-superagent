import { readFileSync } from "node:fs";
import { cpus, loadavg } from "node:os";
import { join } from "node:path";
import { shq } from "./delivery.ts";
import { memFreePct } from "./host.ts";
import { type Exec, spawnExec } from "./runtime/exec.ts";
import { HcRuntime } from "./runtime/hc/index.ts";
import { OmoHostRuntime } from "./runtime/omo-host/index.ts";
import { HerdrRuntime } from "./runtime/herdr/index.ts";
import { Runtimes } from "./runtime/registry.ts";
import { type RuntimeChoice, readRuntimeChoice } from "./runtime/select.ts";
import { Store } from "./store.ts";
import { type HostLoad, KEY_RE, type Role, reservedKey } from "./store-types.ts";
import { Telemetry, type Usage } from "./telemetry.ts";

export { KEY_RE, reservedKey };

const PROMPTS = join(import.meta.dir, "..", "prompts");
// The running entry point, not a path beside this file: from the bundled `bin/dori.js` a `cli.ts` beside it does not
// exist, and every lane that ran a `dori` command from its rules failed on module-not-found (2026-11-18).
const SELF = Bun.main;

export type Deps = {
  readonly store: Store;
  /** The session runtimes: `default` opens new sessions, `for(ref)` reaches a stored one on its own runtime. */
  readonly runtimes: Runtimes;
  /** Which runtime new sessions open on, and why (`dori status` prints it). Throws when none can be chosen. */
  readonly choice: () => RuntimeChoice;
  readonly exec: Exec;
  readonly now: () => number;
  readonly agentCmd: string;
  /** The model a new lane opens with, from config; absent means the agent's own default. */
  readonly laneModel?: string;
  readonly doriCmd: string;
  readonly host: () => HostLoad;
  readonly usage: Usage;
};

/** The runtime is chosen on first use, so commands that open or reach no session work without one installed. */
export const defaultDeps = (): Deps => {
  const store = new Store();
  let chosen: RuntimeChoice | undefined;
  let runtimes: Runtimes | undefined;
  const choice = (): RuntimeChoice =>
    (chosen ??= readRuntimeChoice({ env: process.env, configPath: join(store.root, "config.json") }));
  return {
    store,
    get runtimes() {
      // The choice is made only when a NEW session is opened: a stored session's own runtime needs none.
      runtimes ??= new Runtimes(
        () => choice().kind,
        (k) =>
          k === "hc"
            ? new HcRuntime(spawnExec)
            : k === "omo-host"
              ? new OmoHostRuntime(spawnExec)
              : new HerdrRuntime(spawnExec, process.env["DORI_HERDR_SESSION"]),
      );
      return runtimes;
    },
    choice,
    exec: spawnExec,
    now: Date.now,
    agentCmd: process.env["DORI_AGENT_CMD"] ?? "omo",
    ...(laneModel(store.root) === undefined ? {} : { laneModel: laneModel(store.root) as string }),
    doriCmd: process.env["DORI_CMD"] ?? `DORI_HOME=${shq(store.root)} bun ${shq(SELF)}`,
    host: () => ({ load1: loadavg()[0] ?? 0, cores: cpus().length, memFreePct: memFreePct() }),
    usage: new Telemetry(store.root),
  };
};

/** `DORI_PROMPTS_DIR` when set, else the repo's `prompts/`. */
export const promptsDir = (): string => process.env["DORI_PROMPTS_DIR"] || PROMPTS;

/**
 * The model a lane runs on: `DORI_LANE_MODEL`, else `defaultModel` in this home's config.json, else nothing.
 * Without this a lane ran on `omo`'s own default whatever the config said (2026-11-19).
 */
export const laneModel = (storeRoot: string): string | undefined => {
  const fromEnv = nonEmpty(process.env["DORI_LANE_MODEL"]);
  if (fromEnv !== undefined) return fromEnv;
  const model = configKey(storeRoot, "defaultModel");
  return typeof model === "string" && model ? model : undefined;
};

/**
 * Lanes that stay open for conversation (`chatLanes` in config.json): they never count as open work, so closing the
 * last work lane still reads as idle while the chat lane keeps running.
 */
export const chatLanes = (storeRoot: string): readonly string[] => {
  const keys = configKey(storeRoot, "chatLanes");
  return Array.isArray(keys) ? keys.filter((k): k is string => typeof k === "string") : [];
};

const configKey = (storeRoot: string, key: string): unknown => {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(storeRoot, "config.json"), "utf8"));
    return typeof raw === "object" && raw !== null ? Reflect.get(raw, key) : undefined;
  } catch {
    return undefined;
  }
};

const nonEmpty = (value: string | undefined): string | undefined =>
  value === undefined || value.trim() === "" ? undefined : value;

export const prompt = (name: string, vars: Record<string, string>): string =>
  readFileSync(join(promptsDir(), name), "utf8").replace(/\{\{(\w+)\}\}/g, (_, k: string) => vars[k] ?? `{{${k}}}`);

/** The roles `dori role` registers by hand; `dori up` also registers the two loop sessions. */
export const ROLES: readonly Role[] = ["lead", "duty"];
