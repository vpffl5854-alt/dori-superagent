import { formatRef, type SessionInfo } from "../../../../src/runtime/types.ts";
import { type Lane, sessionOf, statusOf } from "./registry.ts";

export type PaneState = "live" | "vanished" | "unassigned";

/** Each lane against the live sessions (live, vanished or never assigned), and the live sessions no open lane owns. */
export const reconcilePanes = (
  lanes: readonly Lane[],
  sessions: readonly SessionInfo[],
): { lanes: { key: string; status: string; pane: string | null; paneState: PaneState }[]; unregistered: string[] } => {
  const live = new Set(sessions.map((s) => formatRef(s.ref)));
  const refOf = (lane: Lane) => sessionOf(lane);
  // A closed lane owns no pane: one left open by a failed close is unregistered, as in sync.
  const registered = new Set(
    lanes.flatMap((l) => (refOf(l) && statusOf(l) !== "closed" ? [formatRef(refOf(l)!)] : [])),
  );
  return {
    lanes: lanes.map((lane) => ({
      key: lane.key,
      status: statusOf(lane),
      pane: lane.pane ?? null,
      paneState: !refOf(lane) ? "unassigned" : live.has(formatRef(refOf(lane)!)) ? "live" : "vanished",
    })),
    unregistered: sessions.filter((s) => !registered.has(formatRef(s.ref))).map((s) => s.ref.id),
  };
};
