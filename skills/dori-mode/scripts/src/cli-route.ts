/** dori route, er, cost and render-er: the router's pick, the infirmary, the monthly cost report, the render hospital. */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Command, die, every } from "./cli-context.ts";
import { aggregate, type Call, parseSession, renderReport } from "./cost-report.ts";
import { erTick, harnessLanes, TAIL_LINES } from "./er.ts";
import { fill } from "./config.ts";
import { planRenders, renderLine } from "./render-er.ts";
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

const readJson = <T>(path: string): T | null => {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
};

const readHarness = (dir: string) =>
  (existsSync(dir) ? readdirSync(dir) : []).flatMap((f) =>
    f.endsWith(".json") ? [readJson<Record<string, never>>(join(dir, f)) ?? {}] : [],
  );

const er: Command = async ({ loopMinutes, config, deps }) => {
  const seen = new Set<string>();
  const rts = runtimesFor(config, process.env, run);
  console.log(`ER_READY backups=${config.backupModels.join(",") || "-"}`);
  await every(loopMinutes(), async () => {
    const read = async (lane: Parameters<typeof sessionOf>[0]) => {
      const ref = sessionOf(lane);
      return ref ? await readScreen(rts, ref, TAIL_LINES).catch(() => null) : null;
    };
    // With DORI_HOME set the harness's own lane and role records are watched; otherwise this skill's registry.
    const home = process.env["DORI_HOME"];
    const lanes = home
      ? harnessLanes(readHarness(join(home, "lanes")), readJson(join(home, "roles.json")) ?? {})
      : await deps.registry.list();
    const lines = await erTick(lanes, read, config, seen, new Date().toISOString().slice(0, 13));
    for (const line of lines) console.log(line);
    const hook = config.hooks.erNotify;
    if (lines.length > 0 && hook?.length) {
      const r = await run(fill(hook, { text: `[의무실]\n${lines.join("\n")}` }), { timeoutMs: 60_000 });
      if (r.code !== 0) console.log(`ER_NOTIFY_FAILED exit=${r.code} ${r.err.slice(0, 160)}`);
    }
  });
};

/** Every session log under sessionsDir (one folder per working directory); an unreadable one is skipped. */
export const sessionCalls = (dir: string): Call[] => {
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
  // `prev` is last month: the monthly job runs on the 1st for the month that just ended.
  const now = new Date();
  const month =
    opt("month") === "prev"
      ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 7)
      : (opt("month") ?? now.toISOString().slice(0, 7));
  if (!/^\d{4}-\d{2}$/.test(month)) die("--month must be YYYY-MM");
  const report = renderReport(month, aggregate(sessionCalls(config.sessionsDir).filter((c) => c.month === month)));
  if (values["write"] !== true) return void console.log(report);
  const dir = join(config.stateDir, "reports");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `cost-${month}.md`), report);
  console.log(`COST_REPORT ${join(dir, `cost-${month}.md`)}`);
};

/** Each `<job>.log` in the folder is one render job; only the jobs a rerun can cure are run again, through hooks.render. */
const renderEr: Command = async ({ key, values, config }) => {
  const dir = key ?? die("render-er needs the folder of render logs");
  const jobs = readdirSync(dir)
    .filter((f) => f.endsWith(".log"))
    .map((f) => ({ job: f.slice(0, -4), log: readFileSync(join(dir, f), "utf8") }));
  const plan = planRenders(jobs);
  for (const f of plan.findings) console.log(renderLine(f));
  console.log(`RERUN ${plan.rerun.join(" ") || "-"}`);
  if (values["rerun"] !== true || plan.rerun.length === 0) return;
  const hook = config.hooks.render ?? die("no hooks.render configured: nothing can run a job again");
  for (const job of plan.rerun) {
    const r = await run(fill(hook, { job }));
    console.log(`RERUN_${r.code === 0 ? "OK" : "FAILED"} ${job}${r.code === 0 ? "" : ` exit=${r.code}`}`);
  }
};

export const routeCommands: Readonly<Record<string, Command>> = {
  route: routeCommand,
  er,
  cost,
  "render-er": renderEr,
};
