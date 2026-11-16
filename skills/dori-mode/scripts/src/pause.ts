import type { SessionRef } from "../../../../src/runtime/types.ts";
import type { FlowDeps } from "./done-flow.ts";
import { runtimesOf } from "./run.ts";
import { readScreen, sendVerified, statusLookup } from "./sessions.ts";
import { type Lane, type LaneStatus, sessionOf, statusOf, withStatus } from "./registry.ts";

/**
 * One state for "wait": a paused lane is skipped by the freshness sweep and its agent's goal is paused,
 * so neither a nudge nor goal continuation wakes it until it is resumed (issue #11). The lane is marked
 * paused only once the pane shows the goal paused: a silenced lane whose goal still runs is the bug itself.
 */
export type PauseResult = { readonly lane: Lane; readonly lines: readonly string[]; readonly code: 0 | 2 | 3 };

const PAUSABLE: ReadonlySet<LaneStatus> = new Set(["working", "not-done"]);
// What the goal command prints (senpi goal/command-registration.ts): its new status, or that there is no goal,
// in which case nothing can auto-continue either.
// Whole lines only, so a lane's own output that merely mentions them does not count.
const PAUSED_SHOWN = /^\s*(?:Goal paused|cannot update goal: no goal exists)\s*$/gm;
const RESUMED_SHOWN = /^\s*(?:Goal active|cannot update goal: no goal exists)\s*$/gm;
const READ_BACK_TRIES = 8;

const count = (screen: string, shown: RegExp): number => screen.match(shown)?.length ?? 0;

/** Sends a goal command and confirms it from the screen: one more matching line than before it was sent. */
const goalCommand = async (
  deps: FlowDeps,
  ref: SessionRef,
  text: string,
  shown: RegExp,
): Promise<"confirmed" | "unconfirmed" | "failed"> => {
  const rts = runtimesOf(deps);
  const before = count(await readScreen(rts, ref, 200), shown);
  if ((await sendVerified(rts, deps.clock, ref, text)) === "failed") return "failed";
  for (let attempt = 0; attempt < READ_BACK_TRIES; attempt++) {
    if (count(await readScreen(rts, ref, 200), shown) > before) return "confirmed";
    await deps.clock.sleep(700);
  }
  return "unconfirmed";
};

/** The status a paused lane had before its pause. */
const beforePause = (lane: Lane): LaneStatus =>
  lane.pausedFrom && PAUSABLE.has(lane.pausedFrom) ? lane.pausedFrom : "working";

export const pauseLane = async (deps: FlowDeps, lane: Lane, note: string): Promise<PauseResult> => {
  const status = statusOf(lane);
  if (status === "paused") return { lane, lines: [`PAUSED ${lane.key} already`], code: 0 };
  if (!PAUSABLE.has(status)) return { lane, lines: [`NOT_PAUSED ${lane.key} is ${status}, not working`], code: 2 };
  const ref = sessionOf(lane);
  if (!ref) return { lane, lines: [`PAUSE_UNVERIFIED ${lane.key} has no pane, so its goal cannot be paused`], code: 3 };
  // The goal first: stopping the running turn must not hand off to a goal continuation. sendVerified delivers it under
  // the status it reads, so a working agent gets it as queued input ("working"), an idle one under "idle".
  const goal = await goalCommand(deps, ref, "/goal pause", PAUSED_SHOWN);
  if (goal !== "confirmed")
    return { lane, lines: [`PAUSE_UNVERIFIED ${lane.key} /goal pause ${goal}; lane left ${status}`], code: 3 };
  const at = new Date(deps.clock.now()).toISOString();
  const paused = withStatus(lane, "paused", note, at, {
    pausedFrom: status,
    pausedSeenWorking: undefined,
    lastFreshnessNote: undefined,
  });
  await deps.registry.write(paused);
  const rts = runtimesOf(deps);
  const running = (await statusLookup(rts, ref)).status === "working";
  if (running) await rts.for(ref).keys(ref, ["escape"]);
  return {
    lane: paused,
    lines: [`PAUSED ${lane.key} goal paused${running ? ", running turn interrupted" : ""}`],
    code: 0,
  };
};

export const resumeLane = async (deps: FlowDeps, lane: Lane, note: string): Promise<PauseResult> => {
  if (statusOf(lane) !== "paused")
    return { lane, lines: [`NOT_RESUMED ${lane.key} is ${statusOf(lane)}, not paused`], code: 2 };
  const ref = sessionOf(lane);
  if (!ref)
    return { lane, lines: [`RESUME_UNVERIFIED ${lane.key} has no pane, so its goal cannot be resumed`], code: 3 };
  const goal = await goalCommand(deps, ref, "/goal resume", RESUMED_SHOWN);
  if (goal !== "confirmed")
    return { lane, lines: [`RESUME_UNVERIFIED ${lane.key} /goal resume ${goal}; lane left paused`], code: 3 };
  const now = deps.clock.now();
  // Quiet time starts again at the resume: a long pause must not turn into an instant nudge.
  const resumed = withStatus(lane, beforePause(lane), note, new Date(now).toISOString(), {
    lastReplyAt: now,
    pausedFrom: undefined,
    pausedSeenWorking: undefined,
    lastFreshnessNote: undefined,
  });
  await deps.registry.write(resumed);
  return { lane: resumed, lines: [`RESUMED ${lane.key} as ${statusOf(resumed)}, goal resumed`], code: 0 };
};

export type PausedCheck = { readonly lane: Lane; readonly outcome: "working-while-paused" } | null;

/**
 * Resume is explicit only: `dori resume`, on the owner's word. Activity never ends a pause, because a paused
 * lane can still be woken (a background result, a queued message, a turn after Escape) and its owner said
 * wait. A paused lane whose pane reads working on two ticks in a row is reported so the lead can ask; it
 * stays paused.
 */
export const checkPausedLane = async (deps: FlowDeps, lane: Lane): Promise<PausedCheck> => {
  const ref = sessionOf(lane);
  if (statusOf(lane) !== "paused" || !ref) return null;
  const working = (await statusLookup(runtimesOf(deps), ref)).status === "working";
  if (!working) {
    // Idle again: the next working stretch is new information and is reported again.
    if (lane.pausedSeenWorking || lane.lastFreshnessNote)
      await deps.registry.write({ ...lane, pausedSeenWorking: undefined, lastFreshnessNote: undefined });
    return null;
  }
  if (!lane.pausedSeenWorking) {
    await deps.registry.write({ ...lane, pausedSeenWorking: true });
    return null;
  }
  return { lane, outcome: "working-while-paused" };
};
