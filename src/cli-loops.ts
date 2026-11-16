import { backlogAdd, backlogDecide, backlogDrop, backlogImport, IMPORT_LIMIT } from "./backlog.ts";
import { need, one, textOf, USAGE, type Args } from "./cli-args.ts";
import { dutyTick } from "./duty.ts";
import type { Deps } from "./harness.ts";
import { Refusal } from "./refusal.ts";
import { HOUR, loopTick, msUntilNext, summary } from "./loop.ts";
import { acquire, release } from "./loop-lock.ts";

export async function runDuty(d: Deps, a: Args, x: string | undefined): Promise<number> {
  if (x === "stop") {
    d.store.setStop(d.now(), one(a, "text") ?? "stopped by hand", "duty");
    console.log("DUTY STOPPED");
    return 0;
  }
  if (x === "resume") {
    d.store.clearStop("duty");
    console.log("DUTY RESUMED");
    return 0;
  }
  if (x === "status") {
    const stop = d.store.stop("duty");
    console.log(stop ? `stopped: ${stop.reason}` : "running (no stop file)");
    return 0;
  }
  if (x !== undefined) throw new Refusal(`unknown duty command ${x}\n\n${USAGE}`);
  const interval = Number(one(a, "interval") ?? "60") * 1000;
  // Bun.sleep(NaN) and any Bun.sleep under 1 ms return at once, so a bad value would run duty passes back to back.
  if (!(Number.isFinite(interval) && interval >= 1))
    throw new Refusal("--interval must be a number of seconds, 0.001 or more");
  // One duty loop per home: two would deliver the same inbox twice and nudge every lane twice.
  const lock = d.store.lockPath("duty");
  const held = acquire(d, lock);
  if ("holder" in held) throw new Refusal(`another duty loop runs in this home (${held.holder})`);
  try {
    for (;;) {
      for (const e of await dutyTick(d))
        console.log(`DUTY ${[e.lane ?? e.pane, e.action].filter(Boolean).join(" ")}${e.detail ? `: ${e.detail}` : ""}`);
      if (one(a, "once")) break;
      await Bun.sleep(interval);
    }
  } finally {
    release(d, held.nonce, lock);
  }
  return 0;
}

export async function runLoop(d: Deps, a: Args, x: string | undefined): Promise<number> {
  if (x === "stop") {
    d.store.setStop(d.now(), one(a, "text") ?? "stopped by hand");
    console.log("LOOP STOPPED");
    return 0;
  }
  if (x === "resume") {
    d.store.clearStop();
    console.log("LOOP RESUMED");
    return 0;
  }
  if (x === "status") {
    const stop = d.store.stop();
    const last = d.store.lastRun();
    const age = last ? Math.round((d.now() - last.at) / 60_000) : undefined;
    console.log(
      stop
        ? `stopped: ${stop.reason}`
        : `armed (no stop file; ${age === undefined ? "no run recorded yet" : `last run ${age}m ago`})`,
    );
    console.log(last ? summary(last) : "no run yet");
    return 0;
  }
  if (x !== undefined) throw new Refusal(`unknown loop command ${x}\n\n${USAGE}`);
  const interval = Number(one(a, "interval") ?? String(HOUR / 1000)) * 1000;
  const opts = {
    interval,
    maxLanes: Number(one(a, "max-lanes") ?? process.env["DORI_MAX_LANES"] ?? "3"),
    maxStarts: Number(one(a, "max-starts") ?? process.env["DORI_MAX_STARTS"] ?? "2"),
    force: one(a, "force") === "true",
    ...((one(a, "max-load") ?? process.env["DORI_MAX_LOAD"])
      ? { maxLoad: Number(one(a, "max-load") ?? process.env["DORI_MAX_LOAD"]) }
      : {}),
  };
  const count = (n: number): boolean => Number.isInteger(n) && n >= 0;
  if (
    !(Number.isFinite(interval) && interval > 0) ||
    !count(opts.maxLanes) ||
    !count(opts.maxStarts) ||
    !(opts.maxLoad === undefined || (Number.isFinite(opts.maxLoad) && opts.maxLoad > 0))
  ) {
    throw new Refusal(
      "--interval and --max-load must be finite positive numbers; --max-lanes and --max-starts whole numbers >= 0",
    );
  }
  for (;;) {
    try {
      const run = await loopTick(d, opts);
      console.log(
        run.skipped
          ? `LOOP skipped: ${run.skipped}`
          : `LOOP started=${run.started.length} findings=${run.findings.length} asked=${run.asked.length}`,
      );
    } catch (e) {
      console.error(`LOOP ERROR ${e instanceof Error ? e.message : String(e)}`);
      if (one(a, "once")) return 1;
    }
    if (one(a, "once")) break;
    opts.force = false;
    await Bun.sleep(msUntilNext(d, interval));
  }
  return 0;
}

export async function runBacklog(d: Deps, a: Args, x: string | undefined): Promise<number> {
  if (x === "add") {
    const id = need(a.pos[2], "item id");
    const p = one(a, "priority");
    const title = one(a, "title");
    const cwd = one(a, "cwd");
    const decision = one(a, "decision");
    const item = backlogAdd(d, id, need(one(a, "brief"), "--brief"), {
      ...(title !== undefined ? { title } : {}),
      ...(cwd !== undefined ? { cwd } : {}),
      ...(decision !== undefined ? { decision } : {}),
      ...(p !== undefined ? { priority: Number(p) } : {}),
    });
    console.log(`ADDED ${item.id} p${item.priority}${item.decision ? " (needs decision)" : ""}`);
  } else if (x === "list" || x === undefined) {
    for (const i of d.store.items()) {
      console.log(
        `${i.id.padEnd(24)} ${i.status.padEnd(8)} p${i.priority}  ${i.decision ? `DECIDE: ${i.decision}` : i.title}`,
      );
    }
  } else if (x === "decide") {
    const id = need(a.pos[2], "item id");
    backlogDecide(d, id, await textOf(a));
    console.log(`DECIDED ${id}`);
  } else if (x === "drop") {
    const id = need(a.pos[2], "item id");
    backlogDrop(d, id, one(a, "text"));
    console.log(`DROPPED ${id}`);
  } else if (x === "import") {
    const { added, capped } = await backlogImport(
      d,
      need(a.pos[2], "owner/repo"),
      one(a, "label") ?? "dori",
      one(a, "cwd"),
    );
    console.log(`IMPORTED ${added.length}${added.length ? `: ${added.join(", ")}` : ""}`);
    if (capped)
      console.error(
        `WARNING: gh returned ${IMPORT_LIMIT} issues, the import limit; some labelled issues may be missing`,
      );
  } else {
    throw new Refusal(`unknown backlog command ${x}\n\n${USAGE}`);
  }
  return 0;
}
