/**
 * The infirmary: reads the bottom of every working lane's screen, names what is wrong with its model
 * (rate limited, model gone, context too long, auth refused) and prints one prescription line for
 * the lead. A backup model is only ever suggested from config `backupModels` — empty by default,
 * because the owner pins every session to one model and a silent switch would break that rule.
 */
import type { Lane } from "./registry.ts";
import { statusOf } from "./registry.ts";

export type Diagnosis = "rate-limit" | "model-dead" | "context-overflow" | "auth";
export type Prescription =
  | { readonly action: "switch-model"; readonly to: string }
  | { readonly action: "wait" }
  | { readonly action: "shorten-prompt" }
  | { readonly action: "escalate" };

/** Checked in order: an auth failure or a missing model also prints a status code a rate-limit pattern could match. */
const SIGNS: readonly (readonly [Diagnosis, RegExp])[] = [
  ["auth", /\b401\b|unauthori[sz]ed|invalid (?:api )?key|authentication failed|permission denied for model/i],
  [
    "model-dead",
    /model[^\n]{0,40}(?:not found|does not exist|unavailable|deprecated|not supported)|no such model|unknown model|invalid model/i,
  ],
  [
    "context-overflow",
    /context (?:length|window)[^\n]{0,40}(?:exceed|too long|limit)|prompt is too long|maximum context|too many tokens/i,
  ],
  [
    "rate-limit",
    /rate.?limit|\b429\b|too many requests|overloaded|\b529\b|quota (?:exceeded|exhausted)|usage limit|resource.?exhausted/i,
  ],
];

/** Only the screen's last lines count: an error scrolled far above a recovered lane is history. */
export const TAIL_LINES = 15;

export const diagnose = (screen: string): Diagnosis | null => {
  const tail = Bun.stripANSI(screen).split("\n").slice(-TAIL_LINES).join("\n");
  for (const [d, sign] of SIGNS) if (sign.test(tail)) return d;
  return null;
};

export const prescribe = (d: Diagnosis, model: string, backups: readonly string[]): Prescription => {
  const backup = backups.find((m) => m !== model);
  if (d === "rate-limit") return backup ? { action: "switch-model", to: backup } : { action: "wait" };
  if (d === "model-dead") return backup ? { action: "switch-model", to: backup } : { action: "escalate" };
  if (d === "context-overflow") return { action: "shorten-prompt" };
  return { action: "escalate" };
};

export const erLine = (key: string, model: string, d: Diagnosis, rx: Prescription): string =>
  `ER ${key} ${d} model=${model} -> ${rx.action}${rx.action === "switch-model" ? ` to=${rx.to}` : ""}`;

export type ErOptions = { readonly defaultModel: string; readonly backupModels: readonly string[] };

/**
 * One sweep over the working lanes. A lane's finding is printed once per hour per diagnosis
 * (`seen` lives as long as the loop), so a lane that stays rate limited does not repeat every tick.
 */
export const erTick = async (
  lanes: readonly Lane[],
  read: (lane: Lane) => Promise<string | null>,
  opts: ErOptions,
  seen: Set<string>,
  hourKey: string,
): Promise<string[]> => {
  const out: string[] = [];
  for (const lane of lanes) {
    if (statusOf(lane) !== "working") continue;
    const screen = await read(lane);
    if (screen === null) continue;
    const d = diagnose(screen);
    if (d === null) continue;
    const mark = `${lane.key} ${d} ${hourKey}`;
    if (seen.has(mark)) continue;
    seen.add(mark);
    const model = lane.model ?? opts.defaultModel;
    out.push(erLine(lane.key, model, d, prescribe(d, model, opts.backupModels)));
  }
  return out;
};

/**
 * The harness keeps its own records (`$DORI_HOME/lanes/<key>.json` with a status of working, waiting, ready, done or
 * lost, and `$DORI_HOME/roles.json` naming the lead and duty sessions as `hc:t1t`). The infirmary reads them as lanes
 * so a harness home is watched too: every working or waiting lane, plus the lead and duty agents themselves.
 */
export const harnessLanes = (
  laneRecords: readonly { key?: string; status?: string; sessionRef?: { runtime?: string; id?: string } }[],
  roles: Readonly<Record<string, string>>,
): Lane[] => {
  const asLane = (key: string, runtime: string, id: string): Lane => ({
    key,
    title: key,
    thread: "-",
    brief: "-",
    done: "-",
    openedAt: "",
    pane: id,
    sessionRef: { runtime: runtime as "hc" | "herdr", id },
  });
  const lanes = laneRecords.flatMap((r) =>
    r.key && r.sessionRef?.runtime && r.sessionRef.id && (r.status === "working" || r.status === "waiting")
      ? [asLane(r.key, r.sessionRef.runtime, r.sessionRef.id)]
      : [],
  );
  const agents = ["lead", "duty"].flatMap((role) => {
    const [runtime, id] = (roles[role] ?? "").split(":");
    return runtime && id ? [asLane(role, runtime, id)] : [];
  });
  return [...agents, ...lanes];
};
