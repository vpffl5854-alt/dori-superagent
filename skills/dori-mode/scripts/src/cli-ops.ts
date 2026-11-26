/** dori sync, boot, verify-pr and the host loops: watch, freshness, dead-panes, guard, heavy, can-launch. */
import { totalmem } from "node:os";
import { dirname, join } from "node:path";
import { bootCheck, envSlackCheck } from "./boot.ts";
import { type Command, die, every, slackAuth } from "./cli-context.ts";
import { deadPaneTick, newDeadPaneState } from "./dead-panes.ts";
import { watchTick } from "./done-flow.ts";
import { freshnessTick } from "./freshness.ts";
import {
  acquireSlot,
  decideNow,
  type HeavyHost,
  heldSlots,
  pidAlive,
  releaseSlot,
  type SlotDeps,
} from "./heavy-slot.ts";
import { guardTick, sampleHost, sampleLoadMemory } from "./host-guard.ts";
import { fetchHttp } from "./messenger/http.ts";
import { Slack } from "./messenger/slack.ts";
import { Reports } from "./reports.ts";
import { canLaunch } from "./routing.ts";
import { realClock, run } from "./run.ts";
import { syncRegistry } from "./sync.ts";
import { formatVerifyPr, verifyPr } from "./verify-pr.ts";
import { Worklog } from "./worklog.ts";

const sync: Command = async ({ values, deps }) => {
  const r = await syncRegistry(deps, Boolean(values["write"]));
  console.log("key | thread | pane | session | status");
  for (const row of [...r.rows, ...r.unregistered])
    console.log([row.key, row.thread, row.pane, row.session, row.status].join(" | "));
  console.log(r.drift.length ? `DRIFT (${r.drift.length}):\n${r.drift.map((d) => `- ${d}`).join("\n")}` : "DRIFT none");
  console.log(values["write"] ? "WROTE session ids" : "READ_ONLY");
};

const boot: Command = async ({ deps, config }) => {
  const sessionDirs = [
    process.env["PI_SESSION_DIR"],
    process.env["PI_SESSION_FILE"] && dirname(process.env["PI_SESSION_FILE"]),
  ];
  const r = await bootCheck({
    ...deps,
    reports: new Reports(config.stateDir),
    worklog: new Worklog(config.stateDir),
    // A bad token file is a failed boot line, not an exit: boot is the read-only report a fresh lead depends on.
    slack: envSlackCheck((token) => new Slack(fetchHttp, realClock, slackAuth(token))),
    monitorDirs: sessionDirs.flatMap((dir) => (dir ? [join(dir, "extensions", "terminal")] : [])),
  });
  for (const line of r.lines) console.log(line);
  process.exit(r.exitCode);
};

const verifyPrCommand: Command = async ({ key, positionals, opt, config }) => {
  const repo = key ?? die("verify-pr needs owner/repo and a PR number");
  const expectedIdentity = config.repoIdentities[repo.toLowerCase()],
    cwd = opt("cwd");
  const result = await verifyPr(repo, Number(positionals[1]), run, {
    ...(expectedIdentity !== undefined ? { expectedIdentity } : {}),
    loopCount: Number(opt("loop") ?? 20),
    ...(cwd !== undefined ? { cwd } : {}),
  });
  console.log(formatVerifyPr(result));
  process.exit(result.ok ? 0 : 2);
};

const heavy: Command = async ({ rest, config }) => {
  const deps: SlotDeps = {
    dir: `${config.stateDir}/heavy`,
    policy: {
      minSlots: config.heavyMinSlots,
      maxSlots: config.heavyMaxSlots,
      maxLoad: config.heavyMaxLoad,
      jobMemGb: config.heavyJobMemGb,
      memFreeMinPct: config.guard.memFreeMinPct,
    },
    clock: realClock,
    host: async (): Promise<HeavyHost> => {
      const s = await sampleLoadMemory(run);
      return {
        load1: s.loadKnown ? s.load1 : Number.NaN,
        memFreePct: s.memKnown ? s.memFreePct : Number.NaN,
        memTotalGb: totalmem() / 1024 ** 3,
      };
    },
    alive: pidAlive,
    pid: process.pid,
    log: (line) => console.error(line),
  };
  if (rest[0] === "--status") {
    const held = heldSlots(deps);
    const d = await decideNow(deps, held);
    console.log(`HEAVY ${d.admit ? "OPEN" : "FULL"} ${d.reason}`);
    for (const h of held)
      console.log(
        `HEAVY_SLOT ${h.slot} ${h.owner ? `${h.owner.label} pid ${h.owner.pid} since ${Number.isNaN(h.owner.since) ? "unknown" : new Date(h.owner.since).toISOString()}` : "claiming"}`,
      );
    return;
  }
  const sep = rest.indexOf("--");
  const label = rest[0];
  const cmd = sep >= 0 ? rest.slice(sep + 1) : [];
  if (!label || label === "--" || !cmd.length) die("usage: dori heavy <label> -- <command ...> | dori heavy --status");
  const slot = await acquireSlot(deps, label ?? "");
  try {
    const child = Bun.spawn(cmd, { stdout: "inherit", stderr: "inherit", stdin: "inherit" });
    process.exitCode = await child.exited;
  } finally {
    releaseSlot(slot);
  }
};

export const opsCommands: Readonly<Record<string, Command>> = {
  sync,
  boot,
  "verify-pr": verifyPrCommand,
  watch: async ({ deps }) => {
    console.log("LANE_WATCH_READY");
    for (;;) {
      for (const line of await watchTick(deps).catch((e: unknown) => [`LANE_WATCH_WARN ${String(e).slice(0, 200)}`]))
        console.log(line);
      await Bun.sleep(30_000);
    }
  },
  freshness: async ({ loopMinutes, deps }) => {
    await every(loopMinutes(), async () => {
      for (const a of await freshnessTick(deps, process.env["HOME"] ?? ""))
        console.log(`${a.kind.toUpperCase()} ${a.lane} ${a.detail}`);
    });
  },
  "dead-panes": async ({ loopMinutes, config }) => {
    const seen = new Set<string>();
    const paneState = newDeadPaneState();
    await every(loopMinutes(), async () => {
      for (const line of await deadPaneTick(run, config, seen, new Date().toISOString().slice(0, 13), paneState))
        console.log(line);
    });
  },
  guard: async ({ loopMinutes, config }) => {
    const state = { alerting: false };
    const minutes = loopMinutes();
    console.log("HOST_GUARD_READY");
    await every(minutes, async () => {
      for (const line of guardTick(await sampleHost(run), config.guard, state)) console.log(line);
    });
  },
  heavy,
  "can-launch": async ({ config }) => {
    const v = canLaunch(await sampleHost(run), config.guard);
    console.log(v.ok ? "CAN_LAUNCH" : `HOLD ${v.reasons.join(" | ")}`);
    process.exit(v.ok ? 0 : 4);
  },
};
