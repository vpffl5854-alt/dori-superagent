import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { Checkpoints } from "./checkpoints.ts";
import { fill } from "./config.ts";
import { Reports } from "./reports.ts";
import type { Clock, Runner } from "./run.ts";
import {
  type BudgetLimits,
  laneActivity,
  type SupervisedLane,
  type SupervisionOptions,
  type Usage,
  type UsageSnapshot,
  workingTimer,
} from "./supervision-observe.ts";

export type SupervisionDeps = {
  readonly stateDir: string;
  readonly run: Runner;
  readonly clock: Pick<Clock, "now">;
  readonly reports?: Reports;
  readonly alert?: (lane: SupervisedLane, message: string) => void | Promise<void>;
};
export type SupervisionResult = {
  readonly enabled: boolean;
  readonly state: "running" | "stalled" | "blocked" | "halted" | "done" | null;
  readonly alerts: readonly string[];
  readonly usage: UsageSnapshot | null;
  readonly hung: boolean;
};
type Observation = {
  readonly at: number;
  readonly timer: number | null;
  readonly timerKind: string | null;
  readonly activity: string;
  readonly activeAt: number;
  readonly alerts: readonly string[];
};

export class Supervision {
  readonly reports: Reports;
  readonly checkpoints: Checkpoints;
  constructor(
    readonly deps: SupervisionDeps,
    readonly options: SupervisionOptions = {},
  ) {
    this.reports = deps.reports ?? new Reports(deps.stateDir);
    this.checkpoints = new Checkpoints(deps.stateDir);
  }

  private enabled(lane: SupervisedLane): boolean {
    return lane.reportProtocol === "jsonl-v1" || existsSync(this.reports.path(lane.key));
  }

  private async usage(
    lane: SupervisedLane,
    now: number,
    persist = Boolean(this.options.usageArgv?.length),
  ): Promise<UsageSnapshot> {
    let usage: Usage = { tokens: null, costUsd: null };
    if (this.options.usageArgv?.length) {
      const result = await this.deps.run(
        fill(this.options.usageArgv, { key: lane.key, session: lane.session ?? "", cwd: lane.cwd ?? "" }),
        { ...(lane.cwd !== undefined ? { cwd: lane.cwd } : {}), timeoutMs: 10_000 },
      );
      if (result.code === 0) {
        try {
          const value: unknown = JSON.parse(result.out);
          const metric = (name: "tokens" | "costUsd"): number | null => {
            const n =
              typeof value === "object" && value !== null && name in value
                ? (value as Record<string, unknown>)[name]
                : null;
            return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null;
          };
          usage = { tokens: metric("tokens"), costUsd: metric("costUsd") };
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
          // Malformed external JSON remains unknown, never zero.
        }
      }
    }
    const snapshot = { key: lane.key, at: new Date(now).toISOString(), ...usage };
    // Without a usage hook every sweep would append the same unknown reading; close still records its final one.
    if (persist) this.record(snapshot);
    return snapshot;
  }

  private costPath(key: string): string {
    return join(dirname(this.reports.path(key)), "cost.jsonl");
  }

  private record(snapshot: UsageSnapshot): void {
    const path = this.costPath(snapshot.key);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
  }

  private activity(lane: SupervisedLane): Promise<string> {
    return laneActivity(this.deps.run, this.options, this.reports, this.checkpoints, lane);
  }

  async sweep(lane: SupervisedLane, screen: string): Promise<SupervisionResult> {
    if (!this.enabled(lane)) return { enabled: false, state: null, alerts: [], usage: null, hung: false };
    const now = this.deps.clock.now();
    const path = join(dirname(this.reports.path(lane.key)), "supervision.json");
    const previous = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Observation) : null;
    const activity = await this.activity(lane);
    const timer = workingTimer(screen);
    const activeAt = !previous || activity !== previous.activity ? now : previous.activeAt;
    const usage = await this.usage(lane, now);
    const limits = {
      wallMinutes: null,
      tokens: null,
      costUsd: null,
      ...this.options.defaults,
      ...this.options.lanes?.[lane.key],
      ...lane.budget,
    };
    const violations: string[] = [];
    const exceeds = (name: keyof BudgetLimits, actual: number | null): void => {
      const ceiling = limits[name];
      if (
        typeof ceiling === "number" &&
        Number.isFinite(ceiling) &&
        ceiling >= 0 &&
        actual !== null &&
        actual >= ceiling
      )
        violations.push(`${name} ceiling reached (${ceiling})`);
    };
    exceeds("wallMinutes", (now - Date.parse(lane.openedAt)) / 60_000);
    exceeds("tokens", usage.tokens);
    exceeds("costUsd", usage.costUsd);
    const hung =
      previous !== null &&
      timer !== null &&
      previous.timer !== null &&
      timer.kind === previous.timerKind &&
      timer.seconds > previous.timer &&
      // A changed timer origin means a new call, even if its duration is larger. Rounding to the shown unit moves the
      // computed origin by up to one unit, plus sweep jitter.
      Math.abs(now - timer.seconds * 1000 - (previous.at - previous.timer * 1000)) <= timer.step * 1000 + 2000 &&
      timer.seconds >= (this.options.hungAfterMinutes ?? 20) * 60 &&
      now - activeAt >= (this.options.staleAfterMinutes ?? 20) * 60_000;
    const progress = this.reports.read(lane.key);
    const terminal = progress?.state === "done" || progress?.state === "halted";
    const unavailable = (["tokens", "costUsd"] as const)
      .filter((name) => typeof limits[name] === "number" && usage[name] === null)
      .map((name) => `${name} ceiling cannot be checked: usage unavailable`);
    const hungMessage = "Working/Running timer exceeded threshold without fresh report, checkpoint, or file activity";
    const alerts = terminal ? [] : [...(violations.length ? violations : hung ? [hungMessage] : []), ...unavailable];
    const freshAlerts = alerts.filter((message) => !previous?.alerts.includes(message));
    // A question also reads as blocked; only this same ceiling blocker as the latest report makes a new one a repeat.
    const blocker = violations.join("; ");
    const reported = progress?.lastReport?.kind === "blocker" && progress.lastReport.text === blocker;
    if (!terminal && violations.length && !reported) {
      this.reports.report(lane.key, "blocker", blocker, now);
    } else if (!terminal && hung && (!progress || progress.state === "running")) {
      this.reports.append({
        type: "activity",
        key: lane.key,
        at: new Date(now).toISOString(),
        state: "stalled",
        text: hungMessage,
      });
    } else if (!alerts.length && progress?.state === "stalled" && activity !== previous?.activity) {
      this.reports.append({
        type: "activity",
        key: lane.key,
        at: new Date(now).toISOString(),
        state: "running",
        text: "Fresh report, checkpoint, or file activity observed",
      });
    }
    // Deliver before saving, so only alerts that reached the callback count as sent; a failed one is sent again next sweep.
    const undelivered = new Map<string, string>();
    for (const message of freshAlerts) {
      try {
        await this.deps.alert?.(lane, message);
      } catch (error) {
        undelivered.set(message, error instanceof Error ? error.message : String(error));
      }
    }
    // Save the post-blocker signature so our own report does not count as progress.
    const observation: Observation = {
      at: now,
      timer: timer?.seconds ?? null,
      timerKind: timer?.kind ?? null,
      activity: await this.activity(lane),
      activeAt,
      alerts: alerts.filter((message) => !undelivered.has(message)),
    };
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(observation), { mode: 0o600 });
    renameSync(temporary, path);
    if (undelivered.size)
      throw new Error(
        `alert delivery failed for ${lane.key}: ${[...undelivered].map(([message, why]) => `${message} (${why})`).join("; ")}`,
      );
    return { enabled: true, state: this.reports.read(lane.key)?.state ?? "running", alerts: freshAlerts, usage, hung };
  }

  async close(lane: SupervisedLane): Promise<UsageSnapshot | null> {
    if (!this.enabled(lane)) return null;
    // A close that already recorded its final reading (a retried or second close) returns it and runs no hook, so a
    // cost ledger gets each lane once. {closeKey} is the same on every attempt, for a ledger that dedupes on it.
    const path = this.costPath(lane.key);
    const recorded = existsSync(path)
      ? readFileSync(path, "utf8")
          .split("\n")
          .filter((line) => line.trim())
          .map((line) => JSON.parse(line) as UsageSnapshot)
          .findLast((entry) => entry.final === true)
      : undefined;
    if (recorded) return recorded;
    const snapshot = await this.usage(lane, this.deps.clock.now(), false);
    if (this.options.recordCostArgv?.length && (snapshot.tokens !== null || snapshot.costUsd !== null)) {
      const result = await this.deps.run(
        fill(this.options.recordCostArgv, {
          key: lane.key,
          session: lane.session ?? "",
          tokens: snapshot.tokens === null ? "null" : String(snapshot.tokens),
          costUsd: snapshot.costUsd === null ? "null" : String(snapshot.costUsd),
          at: snapshot.at,
          closeKey: `${lane.key}@${lane.openedAt}`,
        }),
        { ...(lane.cwd !== undefined ? { cwd: lane.cwd } : {}), timeoutMs: 10_000 },
      );
      if (result.code !== 0) {
        // Kept as a plain reading, so the next close takes a new one and runs the hook again.
        this.record(snapshot);
        throw new Error(`recordCost failed for ${lane.key}: ${result.err}`);
      }
    }
    const final: UsageSnapshot = { ...snapshot, final: true };
    this.record(final);
    return final;
  }
}
