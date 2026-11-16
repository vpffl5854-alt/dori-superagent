// The hourly loop: sync the backlog with live lanes, audit for missed work, start the next item
// that needs no decision, ask the lead the open questions, and record the run. It never merges,
// never pushes, never closes a pane and never edits a lane record. See docs/hourly-loop.md.
import { log } from "./backlog.ts";
import type { Deps } from "./harness.ts";
import { tellLead } from "./inbox.ts";
import { startLane } from "./lanes.ts";
import { audit, HOUR } from "./loop-audit.ts";
import { acquire, holds, release } from "./loop-lock.ts";
import { refText } from "./refs.ts";
import type { LoopRun } from "./store-types.ts";

export { HOUR };
export const REMIND_HOURS = 6;
export const MAX_ATTEMPTS = 2;
export const MEM_FREE_MIN_PCT = 10;

export type LoopOpts = { interval?: number; maxLanes?: number; maxStarts?: number; maxLoad?: number; force?: boolean };

const PR_RE = /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/;

async function ghState(d: Deps, kind: "pr" | "issue", repo: string, n: string): Promise<string> {
  const r = await d.exec("gh", [kind, "view", n, "--repo", repo, "--json", "state"]);
  if (r.code !== 0)
    throw new Error(`gh ${kind} view ${repo}#${n}: ${(r.stderr || r.stdout).trim() || `exit ${r.code}`}`);
  return String((JSON.parse(r.stdout) as { state?: string }).state);
}

async function sync(d: Deps, run: LoopRun): Promise<void> {
  for (const item of d.store.items()) {
    try {
      if (item.status === "running") {
        const lane = d.store.lane(item.id);
        if (lane?.status === "done") {
          item.status = "done";
          log(d, item, "done", "lane done");
          run.synced.push(`${item.id} done (lane done)`);
        } else if (!lane || lane.status === "lost") {
          const why = lane ? "lane lost" : "lane record missing";
          item.status = "open";
          item.attempts += 1;
          if (item.attempts >= MAX_ATTEMPTS) item.decision = `${why} ${item.attempts} times; retry, re-brief or drop?`;
          log(d, item, "reopen", `${why}, attempt ${item.attempts}`);
          run.synced.push(`${item.id} reopened (${why}, attempt ${item.attempts})`);
        } else if (lane.status === "ready") {
          const m = lane.final?.evidence.map((e) => PR_RE.exec(e)).find(Boolean);
          if (m && (await ghState(d, "pr", m[1]!, m[2]!)) === "MERGED") {
            item.status = "done";
            log(d, item, "done", "PR merged");
            run.synced.push(`${item.id} done (PR merged)`);
            run.findings.push(`${item.id} READY and its PR merged: dori done ${item.id}`);
          }
        }
      } else if (item.status === "open" && item.source) {
        const [repo, n] = item.source.split("#");
        if ((await ghState(d, "issue", repo!, n!)) === "CLOSED") {
          item.status = "dropped";
          log(d, item, "drop", "source issue closed");
          run.synced.push(`${item.id} dropped (${item.source} closed)`);
        }
      }
    } catch (e) {
      run.findings.push(`gh: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

const isOpenLane = (status: string): boolean => status !== "done" && status !== "lost";

async function pull(
  d: Deps,
  run: LoopRun,
  maxLanes: number,
  maxStarts: number,
  maxLoad: number | undefined,
  nonce: string,
): Promise<void> {
  if (!d.store.roles().lead) {
    run.held.push("no lead pane registered");
    return;
  }
  const host = d.host();
  const open = d.store.lanes().filter((l) => isOpenLane(l.status)).length;
  let starts = Math.max(0, Math.min(maxLanes - open, maxStarts));
  const candidates = d.store
    .items()
    .filter((i) => i.status === "open" && !i.decision && !isOpenLane(d.store.lane(i.id)?.status ?? "done"))
    .sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  if (candidates.length > 0 && (host.load1 > (maxLoad ?? host.cores) || host.memFreePct < MEM_FREE_MIN_PCT)) {
    run.held.push(
      `host busy: load ${host.load1.toFixed(1)} (limit ${maxLoad ?? host.cores}), mem free ${host.memFreePct}%`,
    );
    starts = 0;
  }
  // Each start attempt uses one of this run's slots, so a broken host costs at most `starts` failures per run.
  // A failed item counts toward MAX_ATTEMPTS and then becomes a question, so it never blocks the items behind it.
  let tried = 0;
  for (; tried < Math.min(starts, candidates.length); tried++) {
    const item = candidates[tried]!;
    if (!holds(d, nonce)) {
      run.held.push("lock lost to another loop; no more starts this run");
      break;
    }
    try {
      await startLane(d, item.id, item.brief, { cwd: item.cwd });
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      const lane = d.store.lane(item.id);
      if (!lane || !isOpenLane(lane.status) || lane.createdAt < run.at) {
        item.startFailures = (item.startFailures ?? 0) + 1;
        if (item.startFailures >= MAX_ATTEMPTS)
          item.decision = `lane start failed ${item.startFailures} times (${why.slice(0, 120)}); fix the brief or cwd, or drop?`;
        log(d, item, "start", `failed: ${why}`);
        run.findings.push(`start ${item.id} failed: ${why}`);
        continue;
      }
      run.findings.push(`${item.id} started in ${refText(lane.sessionRef)} but the lead was not told: ${why}`);
    }
    item.status = "running";
    log(d, item, "start", "lane opened by the hourly loop");
    run.started.push(`${item.id} (p${item.priority})`);
  }
  const waiting = candidates.length - tried;
  if (waiting > 0) {
    run.held.push(
      `${waiting} item(s) waiting: ${Math.max(0, maxLanes - open - run.started.length)} free of ${maxLanes} lanes, max ${maxStarts}/run`,
    );
  }
}

function ask(d: Deps, run: LoopRun): void {
  const now = d.now();
  for (const item of d.store.items()) {
    if (item.status !== "open" || !item.decision) continue;
    const line = `[DECIDE ${item.id}] ${item.decision} -> dori backlog decide ${item.id} --text '...' | dori backlog drop ${item.id}`;
    if (item.askedAt === undefined) {
      item.askedAt = now;
      log(d, item, "ask", item.decision);
      run.asked.push(line);
    } else if (item.remindedAt === undefined && now - item.askedAt >= REMIND_HOURS * HOUR) {
      item.remindedAt = now;
      log(d, item, "remind", item.decision);
      run.asked.push(`(reminder) ${line}`);
    }
  }
}

export function summary(run: LoopRun): string {
  if (run.skipped) return `[LOOP ${new Date(run.at).toISOString().slice(0, 16)}Z] skipped: ${run.skipped}`;
  const s = run.status!;
  const lines = [
    `[LOOP ${new Date(run.at).toISOString().slice(0, 16)}Z] lanes ${s.lanes}/${s.maxLanes}${s.adhoc.length ? ` (not from backlog: ${s.adhoc.join(", ")})` : ""}` +
      ` | items open ${s.items.open} (decide ${s.items.decide}) running ${s.items.running}` +
      ` | load ${s.host.load1.toFixed(1)}/${s.host.cores} mem-free ${s.host.memFreePct}%`,
  ];
  for (const k of ["synced", "findings", "started", "held"] as const)
    if (run[k].length) lines.push(`${k}: ${run[k].join("; ")}`);
  lines.push(...run.asked);
  return lines.join("\n");
}

/** One hourly pass. Skipped runs (stopped, locked, too soon) change nothing and write nothing. */
export async function loopTick(d: Deps, opts: LoopOpts = {}): Promise<LoopRun> {
  const interval = opts.interval ?? HOUR;
  const maxLanes = opts.maxLanes ?? 3;
  const maxStarts = opts.maxStarts ?? 2;
  const empty = { synced: [], findings: [], started: [], held: [], asked: [] };
  const stop = d.store.stop();
  if (stop) return { at: d.now(), skipped: `stopped: ${stop.reason}`, ...empty };
  const lock = acquire(d);
  if ("holder" in lock) return { at: d.now(), skipped: lock.holder, ...empty };
  try {
    const last = d.store.lastRun();
    if (last && !opts.force && d.now() - last.at < interval) {
      return { at: d.now(), skipped: `ran ${Math.floor((d.now() - last.at) / 60_000)}m ago`, ...empty };
    }
    const run: LoopRun = { at: d.now(), synced: [], findings: [], started: [], held: [], asked: [] };
    await sync(d, run);
    await audit(d, run);
    await pull(d, run, maxLanes, maxStarts, opts.maxLoad, lock.nonce);
    ask(d, run);
    const items = d.store.items();
    const running = new Set(items.filter((i) => i.status === "running").map((i) => i.id));
    const lanes = d.store.lanes().filter((l) => isOpenLane(l.status));
    run.status = {
      lanes: lanes.length,
      maxLanes,
      adhoc: lanes.filter((l) => !running.has(l.key)).map((l) => l.key),
      items: {
        open: items.filter((i) => i.status === "open").length,
        decide: items.filter((i) => i.status === "open" && i.decision).length,
        running: running.size,
      },
      host: d.host(),
    };
    const record = d.store.saveRun(run);
    try {
      await tellLead(d, summary(run), "loop");
    } catch (e) {
      run.findings.push(`report to the lead failed: ${e instanceof Error ? e.message : String(e)}`);
      d.store.saveRun(run, record);
    }
    return run;
  } finally {
    release(d, lock.nonce);
  }
}

/**
 * How long to sleep: until the last stamp's next hour when that is still ahead (so runs keep their cadence after a
 * restart), otherwise a full interval. A stopped, locked-out or failing loop writes no stamp, so it waits an interval
 * between checks instead of spinning.
 */
export function msUntilNext(d: Deps, interval: number): number {
  const last = d.store.lastRun();
  const due = last ? last.at + interval - d.now() : 0;
  return due > 0 ? Math.max(1000, due) : interval;
}
