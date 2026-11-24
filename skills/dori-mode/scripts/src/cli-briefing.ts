/** dori briefing [--no-send]: the morning briefing from Dori's own records, sent to the owner's Telegram. */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Briefing, type LaneFact, laneSummary, renderBriefing } from "./briefing.ts";
import type { Command } from "./cli-context.ts";
import { sessionCalls } from "./cli-route.ts";
import { fill } from "./config.ts";
import { run } from "./run.ts";

export type BriefingConfig = {
  /** Sends the message (`{text}`); the SNS alert's argv when absent. */
  readonly notifyArgv?: readonly string[];
  /** Prints one line of weather; the briefing says "미연결" when absent. */
  readonly weatherArgv?: readonly string[];
};

/** Nothing older than this counts as "since the last briefing", even when the last one never ran. */
const MAX_WINDOW_MS = 36 * 3_600_000;
/** How much of a fault line has to match for two lines to count as the same fault. */
const FAULT_HEAD = 50;

const readJson = <T>(path: string): T | undefined => {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
};
const files = (dir: string, ext: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith(ext))
        .map((f) => join(dir, f))
    : [];

type Lane = {
  key?: string;
  status?: string;
  final?: { text?: string };
  log?: { kind?: string; at?: number; text?: string }[];
  lastActivityAt?: number;
};

const lanes = (home: string, since: number, chat: readonly string[]) => {
  const out = { finished: [] as LaneFact[], working: [] as LaneFact[], lost: [] as LaneFact[] };
  for (const path of files(join(home, "lanes"), ".json")) {
    const l = readJson<Lane>(path);
    if (!l?.key || chat.includes(l.key)) continue;
    const last = l.log?.at(-1);
    const changed = (last?.at ?? l.lastActivityAt ?? 0) >= since;
    const fact = { key: l.key, summary: laneSummary(l.final?.text ?? last?.text) };
    if (l.status === "working") out.working.push(fact);
    else if (changed && (l.status === "done" || l.status === "ready")) out.finished.push(fact);
    else if (changed && l.status === "lost") out.lost.push(fact);
  }
  return out;
};

const faults = (state: string, logs: string, since: number): string[] => {
  const seen = readJson<{ seen?: Record<string, { count?: number; lastAt?: string; file?: string }> }>(
    join(state, "incidents.json"),
  );
  // One fault often logs with a different URL or id each time: lines that start alike are one line with the counts summed.
  const grouped = new Map<string, number>();
  for (const [sig, v] of Object.entries(seen?.seen ?? {})) {
    if (Date.parse(v.lastAt ?? "") < since) continue;
    const head = `${v.file ?? "로그"}: ${sig.slice(0, FAULT_HEAD)}`;
    grouped.set(head, (grouped.get(head) ?? 0) + (v.count ?? 1));
  }
  const out = [...grouped].map(([head, n]) => `${head} (${n}회)`);
  const sns = join(state, "sns", "errors.jsonl");
  const broken = new Set<string>();
  for (const line of existsSync(sns) ? readFileSync(sns, "utf8").split("\n") : []) {
    const e = safe(line);
    if (e && Date.parse(e.at ?? "") >= since) broken.add(`${e.platform}.${e.field}`);
  }
  if (broken.size > 0) out.push(`SNS 셀렉터 깨짐: ${[...broken].join(", ")}`);
  const shortsErr = join(logs, "shorts-daily.err.log");
  const told = out.some((l) => l.startsWith("shorts-daily.err.log"));
  if (!told && existsSync(shortsErr) && statSync(shortsErr).mtimeMs >= since) {
    const last = readFileSync(shortsErr, "utf8").trim().split("\n").at(-1);
    if (last) out.push(`쇼츠: ${last}`);
  }
  return out;
};
const safe = (line: string): { at?: string; platform?: string; field?: string } | undefined => {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
};

const shorts = (state: string, since: number): string[] =>
  files(join(state, "shorts", "jobs"), "")
    .map((dir) => readJson<{ url?: string; at?: string; meta?: { title?: string } }>(join(dir, "youtube.json")))
    .filter(
      (y): y is { url: string; at: string; meta?: { title?: string } } => !!y?.url && Date.parse(y.at ?? "") >= since,
    )
    .map((y) => `${y.meta?.title ?? "쇼츠"} ${y.url}`);

const approvals = (home: string): string[] =>
  files(join(home, "backlog"), ".json")
    .map((p) => readJson<{ status?: string; title?: string; decision?: string }>(p))
    .filter((b) => b?.status === "open")
    .map((b) => (b?.decision ? `${b.title}: ${b.decision}` : (b?.title ?? "")));

const monthCost = (sessionsDir: string, now: Date) => {
  const month = now.toISOString().slice(0, 7);
  try {
    const calls = sessionCalls(sessionsDir).filter((c) => c.month === month);
    const total = calls.reduce((s, c) => s + (c.costKnown ? c.cost : 0), 0);
    return { month, total, calls: calls.length, unknown: calls.filter((c) => !c.costKnown).length };
  } catch {
    return undefined;
  }
};

const briefing: Command = async ({ values, config }) => {
  const cfg = (config as { briefing?: BriefingConfig; sns?: { notifyArgv?: readonly string[] } }).briefing ?? {};
  const home = dirname(config.stateDir);
  const statePath = join(config.stateDir, "briefing.json");
  const now = new Date();
  const lastAt = readJson<{ at?: string }>(statePath)?.at;
  const since = Math.max(Date.parse(lastAt ?? "") || 0, now.getTime() - MAX_WINDOW_MS);
  const chat = (config as { chatLanes?: readonly string[] }).chatLanes ?? [];
  let weather: string | undefined;
  if (cfg.weatherArgv?.length) {
    const r = await run([...cfg.weatherArgv], { timeoutMs: 60_000 });
    weather = r.code === 0 ? r.out.trim().split("\n")[0] : "확인 못 함";
  }
  const b: Briefing = {
    now,
    ...lanes(home, since, chat),
    faults: faults(config.stateDir, join(home, "logs"), since),
    shorts: shorts(config.stateDir, since),
    approvals: approvals(home),
    ...(() => {
      const c = monthCost(config.sessionsDir, now);
      return c ? { cost: c } : {};
    })(),
    ...(weather === undefined ? {} : { weather }),
  };
  const text = renderBriefing(b);
  console.log(text);
  if (values["no-send"] === true) return;
  const argv = cfg.notifyArgv ?? (config as { sns?: { notifyArgv?: readonly string[] } }).sns?.notifyArgv;
  if (!argv?.length) return void console.log("BRIEFING_NOT_SENT no briefing.notifyArgv");
  const r = await run(fill(argv, { text }), { timeoutMs: 60_000 });
  if (r.code !== 0) return void console.log(`BRIEFING_SEND_FAILED exit=${r.code} ${r.err.slice(0, 200)}`);
  mkdirSync(config.stateDir, { recursive: true });
  writeFileSync(statePath, JSON.stringify({ at: now.toISOString() }));
  console.log("BRIEFING_SENT");
};

export const briefingCommands: Readonly<Record<string, Command>> = { briefing };
