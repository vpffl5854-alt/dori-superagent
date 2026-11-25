// Shape checks for the config file's untrusted JSON: a bad value stops the load with ConfigError naming the key,
// never a half-applied setting. Kept apart from config.ts so the loader stays under the 250-line rule.
import type { RuntimeKind, TerminalKind } from "../../../../src/runtime/types.ts";
import type { CommitIdentity } from "./verify-pr-check.ts";

export class ConfigError extends Error {}

export const RUNTIMES: Readonly<Record<TerminalKind, true>> = { herdr: true, hc: true };
export const LANE_RUNTIMES: Readonly<Record<RuntimeKind, true>> = { ...RUNTIMES, "omo-host": true };

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isIdentity = (value: unknown): value is CommitIdentity => {
  const v = value as { name?: unknown; email?: unknown } | null;
  return (
    typeof v === "object" &&
    v !== null &&
    typeof v.name === "string" &&
    !!v.name.trim() &&
    typeof v.email === "string" &&
    !!v.email.trim()
  );
};

// The file is untrusted JSON: keep only well-formed identities, so a bad entry reads as an unconfigured repo.
export const repoIdentities = (value: unknown): Record<string, CommitIdentity> =>
  typeof value !== "object" || value === null || Array.isArray(value)
    ? {}
    : Object.fromEntries(
        Object.entries(value).flatMap(([repo, identity]) =>
          isIdentity(identity) ? [[repo.toLowerCase(), identity]] : [],
        ),
      );

export const checkRuntime = (name: string, value: unknown, allowed: Readonly<Record<string, true>>): void => {
  if (value !== undefined && !(typeof value === "string" && Object.hasOwn(allowed, value)))
    throw new ConfigError(
      `invalid ${name}: expected ${Object.keys(allowed)
        .map((k) => JSON.stringify(k))
        .join(" or ")}, got ${JSON.stringify(value)}`,
    );
};

export const checkStrings = (name: string, value: unknown, shape: RegExp, expected: string): void => {
  if (value !== undefined && !(Array.isArray(value) && value.every((v) => typeof v === "string" && shape.test(v))))
    throw new ConfigError(`invalid ${name}: expected ${expected}`);
};

const SUPERVISION_KEYS = new Set([
  "hungAfterMinutes",
  "staleAfterMinutes",
  "defaults",
  "lanes",
  "usageArgv",
  "recordCostArgv",
  "activityPaths",
  "gitActivity",
]);
const CEILINGS = new Set(["wallMinutes", "tokens", "costUsd"]);
const checkCeilingNames = (where: string, budget: Record<string, unknown>): void => {
  for (const name of Object.keys(budget)) {
    if (!CEILINGS.has(name))
      throw new ConfigError(
        `invalid supervision ${where}.${name}: unknown ceiling (expected wallMinutes, tokens or costUsd)`,
      );
  }
};

// A malformed supervision entry stops with its name: dropping it could turn a ceiling off, and keeping it would crash
// every sweep later. A misspelt name is refused for the same reason.
export const checkSupervision = (value: unknown): void => {
  if (value === undefined) return;
  if (!isRecord(value)) throw new ConfigError("invalid supervision: expected an object");
  for (const name of Object.keys(value)) {
    if (!SUPERVISION_KEYS.has(name)) throw new ConfigError(`invalid supervision ${name}: unknown setting`);
  }
  for (const name of ["defaults", "lanes"] as const) {
    if (value[name] !== undefined && !isRecord(value[name]))
      throw new ConfigError(`invalid supervision ${name}: expected an object`);
  }
  if (isRecord(value["defaults"])) checkCeilingNames("defaults", value["defaults"]);
  for (const [key, budget] of Object.entries(isRecord(value["lanes"]) ? value["lanes"] : {})) {
    if (!isRecord(budget)) throw new ConfigError(`invalid supervision lanes.${key}: expected an object`);
    checkCeilingNames(`lanes.${key}`, budget);
  }
  for (const name of ["usageArgv", "recordCostArgv", "activityPaths"] as const) {
    const list = value[name];
    if (list !== undefined && !(Array.isArray(list) && list.every((item) => typeof item === "string"))) {
      throw new ConfigError(`invalid supervision ${name}: expected an array of strings`);
    }
  }
  if (value["gitActivity"] !== undefined && typeof value["gitActivity"] !== "boolean")
    throw new ConfigError("invalid supervision gitActivity: expected true or false");
};

/** The heavy-slot numbers: a finite number, at least one (the minimum may be zero), the minimum under the cap. */
export const checkHeavySlots = (slots: {
  readonly heavyMinSlots: number;
  readonly heavyMaxSlots: number;
  readonly heavyJobMemGb: number;
  readonly heavyMaxLoad: number;
}): void => {
  for (const name of ["heavyMinSlots", "heavyMaxSlots", "heavyJobMemGb", "heavyMaxLoad"] as const) {
    const value = slots[name];
    if (typeof value !== "number" || !Number.isFinite(value) || value < (name === "heavyMinSlots" ? 0 : 1))
      throw new ConfigError(`invalid ${name}: expected a number of at least ${name === "heavyMinSlots" ? 0 : 1}`);
  }
  if (slots.heavyMinSlots > slots.heavyMaxSlots)
    throw new ConfigError("invalid heavyMinSlots: above heavyMaxSlots (or the old heavySlots)");
};
