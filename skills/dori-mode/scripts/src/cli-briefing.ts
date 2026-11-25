/** dori briefing [--no-send]: the morning briefing from Dori's own records, sent to the owner's Telegram. */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  type Briefing,
  keepsFacts,
  type LaneFact,
  laneSummary,
  plainPrompt,
  renderBriefing,
  sourceName,
} from "./briefing.ts";
import type { Command } from "./cli-context.ts";
import { sendApprovals } from "./cli-dorichat.ts";
import { clearQueue, readQueue } from "./cli-notify.ts";
import { sessionCalls } from "./cli-route.ts";
import { fill } from "./config.ts";
import { askOmoProvider, splitModel } from "./omo-provider.ts";
import { run } from "./run.ts";

export type BriefingConfig = {
  /** Sends the message (`{text}`); the SNS alert's argv when absent. */
  readonly notifyArgv?: readonly string[];
  /**
   * The model ("provider/model" on one of OmO's providers) that rewrites the briefing in plain Korean, asked directly
   * (omo-provider.ts); the plain version goes out when it fails or changes a number or link. `omo` is no longer read.
   */
  readonly omo?: string;
  readonly model?: string;
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
    const head = `${sourceName(v.file ?? "로그")}: ${sig.slice(0, FAULT_HEAD)}`;
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
  const told = out.some((l) => l.startsWith(sourceName("shorts-daily.err.log")));
  if (!told && existsSync(shortsErr) && statSync(shortsErr).mtimeMs >= since) {
    const last = readFileSync(shortsErr, "utf8").trim().split("\n").at(-1);
    if (last) out.push(`${sourceName("shorts-daily.err.log")}: ${last}`);
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

type Open = { id: string; title: string; decision?: string };
const openItems = (home: string): Open[] =>
  files(join(home, "backlog"), ".json").flatMap((p) => {
    const b = readJson<{ status?: string; title?: string; decision?: string }>(p);
    return b?.status === "open"
      ? [{ id: basename(p, ".json"), title: b.title ?? "", ...(b.decision ? { decision: b.decision } : {}) }]
      : [];
  });
/** A button label: the issue number when the title has one ("#49082"), else the id. */
const buttonLabel = (o: Open): string => /#\d+/.exec(o.title)?.[0] ?? o.id;

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
  const open = openItems(home);
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
    alerts: readQueue(config).map((q) => `${q.source}: ${q.text}`),
    approvals: open.map((o) => (o.decision ? `${o.title}: ${o.decision}` : o.title)),
    ...(() => {
      const c = monthCost(config.sessionsDir, now);
      return c ? { cost: c } : {};
    })(),
    ...(weather === undefined ? {} : { weather }),
  };
  const raw = renderBriefing(b);
  let text = raw;
  const ref = splitModel(cfg.model ?? config.defaultModel);
  if (ref) {
    const r = await askOmoProvider(ref.provider, ref.model, plainPrompt(raw), 180_000, 32_000);
    const plain = "text" in r ? r.text : "";
    if (plain && keepsFacts(raw, plain)) text = plain;
    else console.log(`BRIEFING_PLAIN_SKIPPED ${"error" in r ? r.error : "(numbers or links changed)"}`);
  }
  // Only --no-send prints the text: the launchd log is scanned for faults, and a briefing quoting yesterday's errors
  // would be read back as new ones.
  if (values["no-send"] === true) return void console.log(text);
  const argv = cfg.notifyArgv ?? (config as { sns?: { notifyArgv?: readonly string[] } }).sns?.notifyArgv;
  if (!argv?.length) return void console.log("BRIEFING_NOT_SENT no briefing.notifyArgv");
  const r = await run(fill(argv, { text }), { timeoutMs: 60_000 });
  if (r.code !== 0) return void console.log(`BRIEFING_SEND_FAILED exit=${r.code} ${r.err.slice(0, 200)}`);
  mkdirSync(config.stateDir, { recursive: true });
  writeFileSync(statePath, JSON.stringify({ at: now.toISOString() }));
  console.log("BRIEFING_SENT");
  clearQueue(config);
  const buttons = await sendApprovals(
    config,
    open.map((o) => ({ id: o.id, label: buttonLabel(o) })),
  ).catch((e) => {
    console.log(`BRIEFING_BUTTONS_FAILED ${String(e).slice(0, 200)}`);
    return false;
  });
  if (buttons) console.log(`BRIEFING_BUTTONS ${open.length}`);
};

export const briefingCommands: Readonly<Record<string, Command>> = { briefing };
