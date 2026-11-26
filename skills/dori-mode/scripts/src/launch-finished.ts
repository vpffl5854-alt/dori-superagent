import type { Runtimes } from "../../../../src/runtime/registry.ts";
import { isKind } from "../../../../src/runtime/hc/exec.ts";
import type { SessionRef } from "../../../../src/runtime/types.ts";
import { finished } from "./boot-monitors.ts";
import type { FlowDeps } from "./done-flow.ts";
import { Reports } from "./reports.ts";
import { startupScreen } from "./startup-screen.ts";

export const launchFinished = async (deps: FlowDeps, key: string): Promise<boolean> => {
  const lane = await deps.registry.read(key);
  return lane !== null && finished({ ...lane, reportState: new Reports(deps.config.stateDir).read(key)?.state });
};

export const launchScreen = async (
  deps: FlowDeps,
  rts: Runtimes,
  ref: SessionRef,
  key: string,
): Promise<string | null> => {
  try {
    return await startupScreen(rts, ref);
  } catch (error) {
    if (isKind(error, "not_found") && (await launchFinished(deps, key))) return null;
    throw error;
  }
};

/**
 * The runtime's own status word for the lane's session. Unlike agentStatus it keeps `shell` (no agent in the session)
 * apart from no status yet: herdr lists an agent that has not reported as `unknown` and a pane with no agent as `shell`.
 * hc lists both with no status, so a session listed with none is probed, which names a shell in front. A session missing
 * from the list is `gone`.
 */
export const launchStatus = async (rts: Runtimes, ref: SessionRef): Promise<{ status?: string; error?: string }> => {
  try {
    const found = (await rts.for(ref).list()).find((s) => s.ref.id === ref.id);
    if (!found) return { status: "gone" };
    if (found.status !== undefined) return { status: found.status };
    const probed = (await rts.for(ref).probe(ref)).status;
    // `unknown` stays unreported (the screen gave no verdict either); any other probed status is evidence enough —
    // on hc it is the screen classification for agents that never emit OSC 7501 (herdr's list always carries a
    // status, so this fallback only ever runs for hc terminals).
    return probed === "unknown" ? {} : { status: probed };
  } catch (e) {
    if (isKind(e, "not_found")) return { status: "gone" };
    return { error: e instanceof Error ? e.message : String(e) };
  }
};
