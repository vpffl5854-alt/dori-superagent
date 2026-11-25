/** dori launch, adopt, attach, claim-done, object-done, close, pause and resume. */
import { OmoHostRuntime } from "../../../../src/runtime/omo-host/index.ts";
import { type Command, die } from "./cli-context.ts";
import { claimDone, closeLane, objectDone } from "./done-flow.ts";
import { adoptLane } from "./launch-adopt.ts";
import { type LaunchInput, launchLane, prepareLaunch } from "./launch.ts";
import { pauseLane, resumeLane } from "./pause.ts";
import { shellQuote } from "./launch-footer.ts";
import { sessionOf } from "./registry.ts";
import { runtimesOf } from "./run.ts";

const launch: Command = async ({ key, opt, need, ceiling, strings, values, deps }) => {
  const wallMinutes = ceiling("wall-minutes"),
    tokens = ceiling("token-limit"),
    costUsd = ceiling("cost-limit");
  const thread = opt("thread"),
    model = opt("model"),
    cwd = opt("cwd");
  const input: LaunchInput = {
    key: key ?? "",
    title: need("title"),
    brief: need("brief"),
    done: need("done"),
    ...(thread !== undefined ? { thread } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
    budget: {
      ...(wallMinutes !== undefined ? { wallMinutes } : {}),
      ...(tokens !== undefined ? { tokens } : {}),
      ...(costUsd !== undefined ? { costUsd } : {}),
    },
    activityPaths: strings("activity-path"),
  };
  if (values["dry-run"]) {
    const prepared = await prepareLaunch(deps, input);
    for (const warning of prepared.warnings) console.error(warning);
    console.log(prepared.preamble);
    return;
  }
  const r = await launchLane(deps, input);
  for (const warning of r.warnings) console.error(warning);
  console.log(`LAUNCHED ${r.lane.key} pane=${r.lane.pane} tab=${r.lane.tab ?? "?"}`);
  console.log(r.startup);
  process.exit(r.startup.startsWith("STARTUP_OK") || r.startup.startsWith("STARTUP_DONE") ? 0 : 3);
};

const adopt: Command = async ({ key, opt, need, deps }) => {
  const thread = opt("thread");
  const l = await adoptLane(deps, {
    key: key ?? "",
    title: need("title"),
    brief: need("brief"),
    done: need("done"),
    ...(thread !== undefined ? { thread } : {}),
    pane: need("pane"),
  });
  console.log(`ADOPTED ${l.key} pane=${l.pane} thread=${l.thread}`);
};

/**
 * A view of an omo-host lane: an hc terminal running omo's TUI client attached to the lane's host session (`--rm`: the
 * terminal goes when the client quits; the lane keeps running). `--print` prints the client's command instead.
 */
const attach: Command = async ({ key, values, lane, deps }) => {
  const target = await lane(key ?? die("attach needs a lane key"));
  const ref = sessionOf(target);
  const rt = ref === undefined ? undefined : runtimesOf(deps).for(ref);
  if (ref === undefined || !(rt instanceof OmoHostRuntime))
    return die(`lane ${target.key} runs on ${ref?.runtime ?? "no session"}; attach is for omo-host lanes`);
  const argv = await rt.attachArgv(ref);
  if (values["print"]) return console.log(argv.map(shellQuote).join(" "));
  const cwd = target.cwd ?? deps.config.defaultCwd;
  const flags = ["--bg", "--no-parent", "--no-notify", "--rm", "--cwd", cwd, "--label", `dori.view=${target.key}`];
  const r = await deps.run(["hc", "--json", "run", ...flags, "--", ...argv]);
  const address = r.code === 0 ? (JSON.parse(r.out) as { address?: unknown }).address : undefined;
  if (typeof address !== "string") return die(`hc run failed: ${(r.err || r.out).slice(0, 300)}`);
  console.log(`ATTACHED ${target.key} view=${address} (quit the client or hc kill ${address}; the lane keeps running)`);
};

const close: Command = async ({ key, opt, lane, deps }) => {
  const target = await lane(key ?? die("close needs a lane key"));
  const rule = opt("lesson");
  const r = await closeLane(
    deps,
    target,
    opt("note") ?? "closed by the lead",
    rule === undefined ? undefined : { rule, evidence: opt("evidence") ?? target.done },
  );
  for (const line of r.lines) console.log(line);
  process.exit(r.closed ? 0 : 2);
};

const pauseOrResume: Command = async ({ command, key, opt, lane, deps }) => {
  const act = command === "pause" ? pauseLane : resumeLane;
  const r = await act(
    deps,
    await lane(key ?? die(`${command} needs a lane key`)),
    opt("note") ?? `${command}d by the lead`,
  );
  for (const line of r.lines) console.log(line);
  process.exit(r.code);
};

export const laneCommands: Readonly<Record<string, Command>> = {
  launch,
  adopt,
  attach,
  "claim-done": async ({ key, need, lane, deps }) => {
    console.log(await claimDone(deps, await lane(key), need("evidence")));
  },
  "object-done": async ({ key, values, lane, deps }) => {
    const reasons = (values["reason"] as string[] | undefined)?.map((r) => r.trim()).filter(Boolean) ?? [];
    if (!reasons.length) die("--reason is required");
    console.log(await objectDone(deps, await lane(key ?? die("object-done needs a lane key")), reasons));
  },
  close,
  pause: pauseOrResume,
  resume: pauseOrResume,
};
