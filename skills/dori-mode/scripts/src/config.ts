import { homedir } from "node:os";
import { join } from "node:path";

import type { RuntimeKind, TerminalKind } from "../../../../src/runtime/types.ts";
import type { ShortsConfig } from "./shorts.ts";
import type { SnsConfig } from "./sns.ts";
import type { SupervisionOptions } from "./supervision-observe.ts";
import type { CommitIdentity } from "./verify-pr-check.ts";
import {
  ConfigError,
  LANE_RUNTIMES,
  RUNTIMES,
  checkHeavySlots,
  checkRuntime,
  checkStrings,
  checkSupervision,
  repoIdentities,
} from "./config-guards.ts";

export { ConfigError } from "./config-guards.ts";

export type ArgvTemplate = readonly string[];

export type Hooks = {
  readonly threadReply?: ArgvTemplate;
  readonly threadDone?: ArgvTemplate;
  readonly transcribe?: ArgvTemplate;
  /** How the Discord room's lane posts its answer: `{channel}`, `{message}` and `{text}`. */
  readonly discordReply?: ArgvTemplate;
  /** Where `dori er` sends its prescriptions (`{text}`, one ER line per line), for example the lead's inbox. */
  readonly erNotify?: ArgvTemplate;
  /** How `dori render-er --rerun` runs one render job again: `{job}` is the job id (its log file name). */
  readonly render?: ArgvTemplate;
};

export type GuardThresholds = {
  readonly loadAlert: number;
  readonly loadOk: number;
  readonly memFreeMinPct: number;
  readonly diskFreeMinGb: number;
  readonly panesMax: number;
};

export type DoriConfig = {
  /** Where new sessions open; absent = detected (see run.ts runtimeChoice). */
  readonly runtime?: TerminalKind;
  /** Where new lanes open; absent = the same runtime as `runtime`. `omo-host` runs each lane inside omo's shared host. */
  readonly laneRuntime?: RuntimeKind;
  /** Where the lead session lives; absent = the same runtime as `runtime`. Read by lanes to name how they reach the lead. */
  readonly leadRuntime?: RuntimeKind;
  readonly stateDir: string;
  readonly laneWorkspace: string;
  readonly workspaces: readonly string[];
  readonly ignorePanes: readonly string[];
  readonly leadPane: string;
  /** Dori's own Discord user id, so a bot's reply to Dori's post is told apart from a reply to another bot. */
  readonly discordSelfId?: string;
  readonly defaultCwd: string;
  readonly agentCommand: ArgvTemplate;
  readonly defaultModel: string;
  readonly launchKeywords: string;
  readonly goalMarker: string;
  /** How long `launch` waits for the agent's ready status and goal after it starts; a slow host is a host property. */
  readonly startupWaitSeconds: number;
  readonly sessionsDir: string;
  readonly nudgeAfterMin: number;
  readonly postAfterMin: number;
  readonly closeAfterMin: number;
  /** `dori heavy` admits by free memory and load between these two; the old `heavySlots` key is read as the ceiling. */
  readonly heavyMinSlots: number;
  readonly heavyMaxSlots: number;
  readonly heavyJobMemGb: number;
  readonly heavyMaxLoad: number;
  readonly deadPanePatterns: readonly string[];
  /** Models `dori er` may suggest when a lane's model is rate limited or gone; empty means suggest none. */
  readonly backupModels: readonly string[];
  /** `owner/repo` list `dori hunt` reads when no repository is named on the command line. */
  readonly huntRepos: readonly string[];
  /** The shorts factory's slots and send target (`dori shorts`); absent means no slot is filled. */
  readonly shorts?: ShortsConfig;
  /** The SNS scrapers and their self-healing (`dori sns`). */
  readonly sns?: SnsConfig;
  readonly guard: GuardThresholds;
  readonly hooks: Hooks;
  /** Expected Git author and committer per lowercase `owner/repo`, for `verify-pr` and the lane footer. */
  readonly repoIdentities: Readonly<Record<string, CommitIdentity>>;
  readonly supervision: SupervisionOptions;
};

export const defaultConfig = (home = homedir()): DoriConfig => ({
  stateDir: join(home, ".dori", "state"),
  laneWorkspace: "",
  workspaces: [],
  ignorePanes: [],
  leadPane: "",
  defaultCwd: home,
  agentCommand: ["omo", "--model", "{model}", "{prompt}"],
  defaultModel: "anthropic/claude-opus-5-5",
  launchKeywords: "ulw set goal and work",
  goalMarker: "Pursuing goal",
  startupWaitSeconds: 180,
  sessionsDir: join(home, ".omo", "agent", "sessions"),
  nudgeAfterMin: 15,
  postAfterMin: 20,
  closeAfterMin: 5,
  heavyMinSlots: 1,
  heavyMaxSlots: 4,
  heavyJobMemGb: 4,
  heavyMaxLoad: 80,
  deadPanePatterns: ["has stopped", "no suitable jobs"],
  backupModels: [],
  huntRepos: [],
  guard: { loadAlert: 150, loadOk: 80, memFreeMinPct: 20, diskFreeMinGb: 50, panesMax: 20 },
  hooks: {},
  repoIdentities: {},
  supervision: {
    hungAfterMinutes: 20,
    staleAfterMinutes: 20,
    defaults: { wallMinutes: null, tokens: null, costUsd: null },
  },
});

export const configPath = (): string => process.env["DORI_CONFIG"] ?? join(homedir(), ".dori", "config.json");

export const expandHome = (path: string, home = homedir()): string =>
  path === "~" ? home : path.startsWith("~/") ? join(home, path.slice(2)) : path;

export const loadConfig = async (path = configPath(), home = homedir()): Promise<DoriConfig> => {
  const base = defaultConfig(home);
  const file = Bun.file(path);
  const raw = (await file.exists()) ? ((await file.json()) as Partial<DoriConfig>) : {};
  checkRuntime("runtime", raw.runtime, RUNTIMES);
  checkRuntime("laneRuntime", raw.laneRuntime, LANE_RUNTIMES);
  checkRuntime("leadRuntime", raw.leadRuntime, LANE_RUNTIMES);
  checkSupervision(raw.supervision);
  checkStrings("backupModels", raw.backupModels, /./, "an array of strings");
  checkStrings("huntRepos", raw.huntRepos, /^[\w.-]+\/[\w.-]+$/, "an array of owner/repo strings");
  const merged: DoriConfig = {
    ...base,
    ...raw,
    guard: { ...base.guard, ...raw.guard },
    hooks: { ...base.hooks, ...raw.hooks },
    repoIdentities: repoIdentities(raw.repoIdentities),
    // Only a string is a marker: null or false would quietly turn the goal check off, and an object would never show.
    goalMarker: typeof raw.goalMarker === "string" ? raw.goalMarker : base.goalMarker,
    // Only a nonnegative number is a wait: a string or null would otherwise end every launch at the first check.
    startupWaitSeconds:
      typeof raw.startupWaitSeconds === "number" &&
      Number.isFinite(raw.startupWaitSeconds) &&
      raw.startupWaitSeconds >= 0
        ? raw.startupWaitSeconds
        : base.startupWaitSeconds,
    heavyMaxSlots: raw.heavyMaxSlots ?? (raw as { heavySlots?: number }).heavySlots ?? base.heavyMaxSlots,
    supervision: {
      ...base.supervision,
      ...raw.supervision,
      defaults: { ...base.supervision.defaults, ...raw.supervision?.defaults },
    },
  };
  for (const [name, value] of Object.entries({
    hungAfterMinutes: merged.supervision.hungAfterMinutes,
    staleAfterMinutes: merged.supervision.staleAfterMinutes,
    ...merged.supervision.defaults,
  })) {
    if (value != null && (typeof value !== "number" || !Number.isFinite(value) || value < 0))
      throw new ConfigError(`invalid supervision ${name}: expected a nonnegative number or null`);
  }
  checkHeavySlots(merged);
  for (const [key, budget] of Object.entries(merged.supervision.lanes ?? {})) {
    for (const [name, value] of Object.entries(budget)) {
      if (value != null && (typeof value !== "number" || !Number.isFinite(value) || value < 0))
        throw new ConfigError(`invalid supervision lanes.${key}.${name}: expected a nonnegative number or null`);
    }
  }
  return {
    ...merged,
    stateDir: expandHome(process.env["DORI_STATE_DIR"] ?? merged.stateDir, home),
    defaultCwd: expandHome(merged.defaultCwd, home),
    sessionsDir: expandHome(merged.sessionsDir, home),
    leadPane: process.env["DORI_LEAD_PANE"] ?? merged.leadPane,
    ...(merged.discordSelfId ? { discordSelfId: merged.discordSelfId } : {}),
  };
};

export const fill = (template: ArgvTemplate, values: Readonly<Record<string, string>>): string[] =>
  template.map((part) => part.replace(/\{(\w+)\}/g, (whole, name: string) => values[name] ?? whole));
