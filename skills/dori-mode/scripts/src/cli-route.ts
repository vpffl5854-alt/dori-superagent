/** dori route, er and cost: the central router's pick, the infirmary sweep over working lanes, the monthly cost report. */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Command, die, every } from "./cli-context.ts";
import { aggregate, type Call, parseSession, renderReport } from "./cost-report.ts";
import { erTick, TAIL_LINES } from "./er.ts";
import { sessionOf } from "./registry.ts";
import { Reports } from "./reports.ts";
import { route } from "./router.ts";
import { run, runtimesFor } from "./run.ts";
import { readScreen } from "./sessions.ts";
import { statusReport } from "./status-report.ts";

const routeCommand: Command = async ({ opt, values, config, deps }) => {
  const text = opt("text") ?? die("route needs --text");
  const r = route(text, { devinAvailable: values["no-devin"] !== true });
  console.log(`ROUTE ${r.kind} ${r.destination} ${JSON.stringify(r.reason)}`);
  if (r.destination !== "status") return;
  const reports = new Reports(config.stateDir);
  console.log(statusReport(await deps.registry.list(), (key) => reports.read(key)));
};

const er: Command = async ({ loopMinutes, config, deps }) => {
  const seen = new Set<string>();
  const rts = runtimesFor(config, process.env, run);
  console.log(`ER_READY backups=${config.backupModels.join(",") || "-"}`);
  await every(loopMinutes(), async () => {
    const read = async (lane: Parameters<typeof sessionOf>[0]) => {
      const ref = sessionOf(lane);
      return ref ? await readScreen(rts, ref, TAIL_LINES).catch(() => null) : null;
    };
    const lines = await erTick(await deps.registry.list(), read, config, seen, new Date().toISOString().slice(0, 13));
    for (const line of lines) console.log(line);
  });
};

/** Every session log under sessionsDir (one folder per working directory); an unreadable one is skipped. */
const sessionCalls = (dir: string): Call[] => {
  const out: Call[] = [];
  for (const entry of readdirSync(dir, { recursive: true, encoding: "utf8" })) {
    if (!entry.endsWith(".jsonl") || entry.includes("-artifacts")) continue;
    try {
      out.push(...parseSession(entry, readFileSync(join(dir, entry), "utf8")));
    } catch {}
  }
  return out;
};

const cost: Command = async ({ opt, values, config }) => {
  const month = opt("month") ?? new Date().toISOString().slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(month)) die("--month must be YYYY-MM");
  const report = renderReport(month, aggregate(sessionCalls(config.sessionsDir).filter((c) => c.month === month)));
  if (values["write"] !== true) return void console.log(report);
  const dir = join(config.stateDir, "reports");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `cost-${month}.md`), report);
  console.log(`COST_REPORT ${join(dir, `cost-${month}.md`)}`);
};

export const routeCommands: Readonly<Record<string, Command>> = { route: routeCommand, er, cost };
