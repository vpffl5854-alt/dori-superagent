import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Deps } from "./harness.ts";
import { chatLanes } from "./harness.ts";
import { tellLead } from "./inbox.ts";
import { RESERVED_KEYS, type Lane } from "./store-types.ts";
import { backupLane } from "./watchdog.ts";
import {
  findingText,
  readBlockedLog,
  repeatedBlocks,
  repeatedScratch,
  type WatchdogFinding,
} from "./watchdog-rules.ts";

export const DEFAULT_HARD_LIMIT_MIN = 60;
export type PaneRow = {
  readonly address: string;
  readonly name?: string;
  readonly cwd?: string;
  readonly createdMs?: number;
};

export type HardLimitOptions = {
  readonly limitMin: number;
  readonly keep: readonly string[];
  readonly log: (line: string) => void;
};

export type HardLimitEvent = { readonly pane?: string; readonly action: string; readonly detail?: string };

const str = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);

// A row without a numeric created_ms is skipped: an age that cannot be read is no proof of an old pane. A payload that
// is not the documented shape throws, so the pass is logged as failed instead of read as "no panes".
export function parsePaneRows(json: string): PaneRow[] {
  const parsed: unknown = JSON.parse(json);
  if (typeof parsed !== "object" || parsed === null) throw new Error("hc ls did not print an object");
  const terminals = (parsed as Record<string, unknown>)["terminals"];
  if (!Array.isArray(terminals)) throw new Error("hc ls printed no terminals array");
  const out: PaneRow[] = [];
  for (const t of terminals) {
    if (typeof t !== "object" || t === null) continue;
    const row = t as Record<string, unknown>;
    const address = str(row["address"]);
    const created = row["created_ms"];
    if (address === undefined || address.includes("/") || typeof created !== "number" || !Number.isFinite(created))
      continue;
    const name = str(row["name"]);
    const cwd = str(row["cwd"]);
    out.push({
      address,
      createdMs: created,
      ...(name === undefined ? {} : { name }),
      ...(cwd === undefined ? {} : { cwd }),
    });
  }
  return out;
}

export const elapsedMin = (createdMs: number, now: number): number =>
  Math.max(0, Math.floor((now - createdMs) / 60_000));

// Strictly more than limitMin minutes of wall time: exactly the limit is not yet over, and a clock that went backwards
// is 0. Compared in milliseconds, so the boundary does not depend on how a division rounds.
export const overLimit = (createdMs: number, now: number, limitMin: number): boolean =>
  now - createdMs > limitMin * 60_000;

// A pane is a lane unless its name or its address is one of the roles kept open: a role renamed in the store still
// carries its registered address, and an address is never a lane name.
export const isLanePane = (row: PaneRow, keep: readonly string[]): boolean => {
  if (row.name === undefined) return false;
  if (keep.includes(row.name.toLowerCase())) return false;
  return !keep.includes(row.address.toLowerCase());
};

// The hard limit as a finding, so one text tells the lead every way the watcher closes a pane.
const hardFinding = (row: PaneRow, now: number, limitMin: number): WatchdogFinding | undefined =>
  row.name !== undefined && row.createdMs !== undefined && overLimit(row.createdMs, now, limitMin)
    ? { rule: "budget", key: row.name, budgetMin: limitMin, elapsedMin: elapsedMin(row.createdMs, now) }
    : undefined;

const laneOf = (d: Deps, address: string): Lane | undefined => d.store.lanes().find((l) => l.sessionRef.id === address);

// The screen is the lane's recent history; a screen that cannot be read is no evidence of a loop, and the next pass
// reads it again.
async function repeatFinding(d: Deps, row: PaneRow, now: number): Promise<WatchdogFinding | undefined> {
  const read = await d.exec("hc", ["--json", "read", row.address]);
  const screen = read.code === 0 ? screenText(read.stdout) : "";
  const repeat = repeatedScratch(screen);
  if (repeat) return { ...repeat, key: row.name ?? row.address };
  const lane = laneOf(d, row.address);
  if (lane === undefined) return undefined;
  return repeatedBlocks(lane, readBlockedLog(join(d.store.root, "logs", "repeat-guard.log")), now);
}

const screenText = (json: string): string => {
  const parsed: unknown = JSON.parse(json);
  const text = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>)["text"] : undefined;
  return typeof text === "string" ? text : "";
};

async function backupPane(d: Deps, row: PaneRow, at: number): Promise<string> {
  const lane = laneOf(d, row.address);
  if (lane) return backupLane(d, lane, at);
  const dir = join(d.store.root, "backups", `watchdog-${row.name ?? row.address}-${stamp(at)}`);
  mkdirSync(join(dir, "files"), { recursive: true });
  await Bun.write(join(dir, "files", "cwd.txt"), `${row.cwd ?? ""}\n`);
  return dir;
}

const stamp = (at: number): string => new Date(at).toISOString().replace(/[:.]/g, "-");

// One judgment failure (hc ls, parsing, a backup, a kill) never throws: it is logged or reported and the next pass runs.
export async function hardLimitPass(d: Deps, opts: HardLimitOptions): Promise<HardLimitEvent[]> {
  const events: HardLimitEvent[] = [];
  const now = d.now();
  let rows: PaneRow[];
  try {
    const result = await d.exec("hc", ["--json", "ls"]);
    if (result.code !== 0) throw new Error(`hc ls exited ${result.code}: ${(result.stderr || result.stdout).trim()}`);
    rows = parsePaneRows(result.stdout);
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    opts.log(`hc ls failed, next pass continues: ${why}`);
    return [{ action: "ls-failed", detail: why }];
  }
  for (const row of rows) {
    if (!isLanePane(row, opts.keep)) continue;
    try {
      const finding = hardFinding(row, now, opts.limitMin) ?? (await repeatFinding(d, row, now));
      if (finding === undefined) continue;
      const backup = await backupPane(d, row, now);
      await d.exec("hc", ["--json", "kill", row.address]);
      await d.exec("hc", ["--json", "rm", row.address]);
      const notice = findingText(finding, `백업 ${backup}`);
      await tellLead(d, notice, "watchdog");
      events.push({ pane: row.address, action: finding.rule, detail: notice });
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      opts.log(`${row.name ?? row.address} judgment or close failed, next pass retries: ${why}`);
      events.push({ pane: row.address, action: "failed", detail: why });
    }
  }
  return events;
}

export async function runHardLimit(
  d: Deps,
  opts: HardLimitOptions & { readonly intervalMs: number },
  log: (line: string) => void = (line) => void process.stderr.write(`${line}\n`),
): Promise<never> {
  for (;;) {
    try {
      for (const e of await hardLimitPass(d, { ...opts, log }))
        log(`HARD_TIMEOUT ${[e.pane, e.action].filter(Boolean).join(" ")}${e.detail ? `: ${e.detail}` : ""}`);
    } catch (e) {
      log(`pass failed, next pass continues: ${e instanceof Error ? e.message : String(e)}`);
    }
    await Bun.sleep(opts.intervalMs);
  }
}

// The role names never closed, plus the ids of the registered lead/duty/loop sessions when those are named, plus the
// chat lanes: a chat lane stays open for conversation, so the hard wall-clock limit would close a healthy one on a
// schedule. Its own loop rules still apply, because a stuck pane is a real fault there too.
export const keepNames = (d: Deps): string[] => {
  const ids = Object.values(d.store.roles()).map((ref) => ref.id);
  return [...RESERVED_KEYS, ...ids, ...chatLanes(d.store.root)].map((n) => n.toLowerCase());
};
