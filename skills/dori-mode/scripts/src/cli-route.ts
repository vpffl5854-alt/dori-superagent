/** dori route: which destination the central router picks for a message, and the status report when it is asked for. */
import { type Command, die } from "./cli-context.ts";
import { Reports } from "./reports.ts";
import { route } from "./router.ts";
import { statusReport } from "./status-report.ts";

const routeCommand: Command = async ({ opt, values, config, deps }) => {
  const text = opt("text") ?? die("route needs --text");
  const r = route(text, { devinAvailable: values["no-devin"] !== true });
  console.log(`ROUTE ${r.kind} ${r.destination} ${JSON.stringify(r.reason)}`);
  if (r.destination !== "status") return;
  const reports = new Reports(config.stateDir);
  console.log(statusReport(await deps.registry.list(), (key) => reports.read(key)));
};

export const routeCommands: Readonly<Record<string, Command>> = { route: routeCommand };
