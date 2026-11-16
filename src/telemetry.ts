import { createHash, randomBytes } from "node:crypto";
import { existsSync, linkSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";

import { isOn, OS_TYPE, otlpLogs, rejectedRecords } from "./telemetry-otlp.ts";

// Anonymous usage counts, sent the way omo sends its own: OTLP/HTTP JSON logs to the omo collector.
// Only counts and fixed enums leave the machine: never paths, repo names, PR numbers, lane keys or message text.
// Off with DORI_TELEMETRY=0 or DO_NOT_TRACK=1.

const HOUR_MS = 3_600_000;

export type MergeOutcome = "merged" | "no_receipt" | "review_block" | "no_checks" | "checks_red" | "checks_all_skipped";
export type DutyCounts = { ticks: number; flushed: number; nudges: number; escalations: number; lost: number };

export type TelemetryEvent =
  | { name: "dori.installed" }
  | { name: "dori.daily_active"; day_utc: string }
  | { name: "dori.lane_started"; open_lanes: number }
  | { name: "dori.lane_ready"; evidence_count: number; lane_minutes: number }
  | { name: "dori.merge_decided"; outcome: MergeOutcome }
  | { name: "dori.review_completed"; verdict: "CLEAR" | "BLOCK" }
  | ({ name: "dori.duty_summary" } & DutyCounts);

export type Sender = (
  url: string,
  body: string,
  headers: Record<string, string>,
) => Promise<{ status: number; text: string }>;

export interface Usage {
  touch(): void;
  record(event: TelemetryEvent): void;
  duty(counts: DutyCounts): void;
  flush(maxMs: number): Promise<void>;
}

export const NOTICE = "dori sends anonymous usage counts (no paths, names or text). Turn it off with DORI_TELEMETRY=0.";

const isOff = (v: string | undefined) =>
  v !== undefined && ["0", "false", "no", "off"].includes(v.trim().toLowerCase());
export const telemetryEnabled = (env: NodeJS.ProcessEnv): boolean =>
  !isOff(env["DORI_TELEMETRY"]) && !isOn(env["DO_NOT_TRACK"]);

type State = {
  installId: string;
  key?: string;
  rejected?: number;
  noticeShown?: boolean;
  installedSent?: boolean;
  lastActiveDay?: string;
  duty?: DutyCounts & { since: number };
};

const fetchSender: Sender = async (url, body, headers) => {
  const res = await fetch(url, { method: "POST", body, headers, signal: AbortSignal.timeout(2000) });
  return { status: res.status, text: await res.text() };
};

// Every call is queued and runs in the background; a failure anywhere (state file, network) is dropped, so usage
// counting can never fail or slow a command. The CLI waits for the queue at exit, capped by flush(maxMs).
export class Telemetry implements Usage {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly home: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly send: Sender = fetchSender,
    private readonly now: () => number = Date.now,
    private readonly notice: (s: string) => void = (s) => process.stderr.write(s + "\n"),
  ) {}

  private get path(): string {
    return join(this.home, "telemetry.json");
  }

  private enqueue(work: () => Promise<void>): void {
    if (!telemetryEnabled(this.env)) return;
    this.queue = this.queue.then(work).catch(() => {});
  }

  async flush(maxMs: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      this.queue,
      new Promise<void>((r) => {
        timer = setTimeout(r, maxMs);
      }),
    ]);
    clearTimeout(timer);
  }

  // The first install id is written to a private temp file and claimed with link(), which fails rather than replaces
  // when the file exists: racing first runs end up on one id, and no reader ever sees a half-written file.
  private load(): State {
    if (!existsSync(this.path)) {
      const tmp = `${this.path}.${process.pid}.${randomBytes(4).toString("hex")}.new`;
      writeFileSync(tmp, JSON.stringify({ installId: randomBytes(16).toString("hex") }) + "\n", { mode: 0o600 });
      try {
        linkSync(tmp, this.path);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      } finally {
        unlinkSync(tmp);
      }
    }
    return JSON.parse(readFileSync(this.path, "utf8")) as State;
  }

  private save(state: State): void {
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(state) + "\n", { mode: 0o600 });
    renameSync(tmp, this.path);
  }

  touch(): void {
    this.enqueue(async () => {
      const state = this.load();
      if (!state.noticeShown) {
        this.notice(NOTICE);
        state.noticeShown = true;
      }
      this.save(state);
      const day = new Date(this.now()).toISOString().slice(0, 10);
      const events: TelemetryEvent[] = [];
      if (!state.installedSent) events.push({ name: "dori.installed" });
      if (state.lastActiveDay !== day) events.push({ name: "dori.daily_active", day_utc: day });
      if (!(await this.emit(state, events))) return;
      state.installedSent = true;
      state.lastActiveDay = day;
      this.save(state);
    });
  }

  record(event: TelemetryEvent): void {
    this.enqueue(async () => {
      const state = this.load();
      await this.emit(state, [event]);
    });
  }

  duty(counts: DutyCounts): void {
    this.enqueue(async () => {
      const state = this.load();
      const now = this.now();
      const acc = state.duty ?? { ticks: 0, flushed: 0, nudges: 0, escalations: 0, lost: 0, since: now };
      for (const k of ["ticks", "flushed", "nudges", "escalations", "lost"] as const) acc[k] += counts[k];
      if (now - acc.since < HOUR_MS) {
        state.duty = acc;
        this.save(state);
        return;
      }
      const { since: _since, ...totals } = acc;
      delete state.duty;
      this.save(state);
      await this.emit(state, [{ name: "dori.duty_summary", ...totals }]);
    });
  }

  private async emit(state: State, events: TelemetryEvent[]): Promise<boolean> {
    if (events.length === 0) return true;
    if (OS_TYPE[platform()] === undefined) return false;
    const endpoint = (this.env["DORI_TELEMETRY_ENDPOINT"] ?? "https://t.omo.dev").replace(/\/+$/, "");
    const installHash = createHash("sha256").update(state.installId).digest("hex");
    const key = this.env["DORI_TELEMETRY_KEY"] ?? state.key ?? (await this.register(endpoint, installHash, state));
    if (key === undefined) return false;
    const body = JSON.stringify(otlpLogs(installHash, events, this.now(), this.env));
    const res = await this.send(`${endpoint}/v1/logs`, body, {
      "content-type": "application/json",
      "x-omo-ingest-key": key,
    });
    if (res.status === 401 && state.key !== undefined) {
      delete state.key;
      this.save(state);
      return false;
    }
    if (res.status < 200 || res.status >= 300) return false;
    const rejected = rejectedRecords(res.text);
    if (rejected > 0) {
      state.rejected = (state.rejected ?? 0) + rejected;
      this.save(state);
    }
    return true;
  }

  // The collector mints a key bound to this install hash; it is cached locally and never shared between installs.
  private async register(endpoint: string, installHash: string, state: State): Promise<string | undefined> {
    const res = await this.send(
      `${endpoint}/v1/register`,
      JSON.stringify({ product: "dori-superagent", install_hash: installHash }),
      {
        "content-type": "application/json",
      },
    );
    if (res.status !== 200) return undefined;
    const key = (JSON.parse(res.text) as { key?: unknown }).key;
    if (typeof key !== "string" || key === "") return undefined;
    state.key = key;
    this.save(state);
    return key;
  }
}
