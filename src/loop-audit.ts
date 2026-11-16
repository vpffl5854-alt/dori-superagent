// The hourly loop's audit pass: open lanes whose session is gone, READY lanes left open, lanes silent for hours.
import type { Deps } from "./harness.ts";
import { refText } from "./refs.ts";
import type { AgentStatus } from "./runtime/types.ts";
import type { Lane, LoopRun } from "./store-types.ts";

export const HOUR = 3_600_000;
const STALE_HOURS = 3;
const READY_HOURS = 2;

const hours = (ms: number): number => Math.floor(ms / HOUR);

/** The last time the lane itself said something (start or report). Pane polling by the duty loop does not count. */
const lastReport = (lane: Lane): number =>
  Math.max(lane.createdAt, ...lane.log.filter((e) => e.kind === "start" || e.kind === "report").map((e) => e.at));

export async function audit(d: Deps, run: LoopRun): Promise<void> {
  const now = d.now();
  for (const lane of d.store.lanes()) {
    if (lane.status !== "working" && lane.status !== "waiting" && lane.status !== "ready") continue;
    let st: AgentStatus;
    try {
      st = (await d.runtimes.for(lane.sessionRef).probe(lane.sessionRef)).status;
    } catch (e) {
      run.findings.push(`${lane.sessionRef.runtime}: ${lane.key}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    if (st === "gone") {
      run.findings.push(`${lane.key} pane ${refText(lane.sessionRef)} is gone`);
    } else if (lane.status === "ready") {
      const age = now - (lane.final?.at ?? lane.lastActivityAt);
      if (age >= READY_HOURS * HOUR)
        run.findings.push(`${lane.key} READY ${hours(age)}h ago, not closed: dori done ${lane.key}`);
    } else if (now - lastReport(lane) >= STALE_HOURS * HOUR) {
      const age = hours(now - lastReport(lane));
      run.findings.push(
        lane.status === "waiting"
          ? `${lane.key} waiting ${age}h on: ${lane.log.at(-1)?.text.slice(0, 80) ?? "?"}`
          : `${lane.key} working, no report for ${age}h`,
      );
    }
  }
}
