/** dori route and dori er: the central router's pick for a message, and the infirmary sweep over working lanes. */
import { type Command, die, every } from "./cli-context.ts";
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

export const routeCommands: Readonly<Record<string, Command>> = { route: routeCommand, er };
