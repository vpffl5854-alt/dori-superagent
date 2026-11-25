import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { Exec } from "../exec.ts";
import type { AgentStatus, CreateSpec, Probe, SessionInfo, SessionRef } from "../types.ts";
import { hostCall, isReason, rec, str } from "./exec.ts";

const DEFAULT_GROUP = "dori";

/** The host has no labels: a Dori session's name carries its group, `dori/<group>/<name>`, so list can filter on it. */
export const sessionName = (spec: Pick<CreateSpec, "name" | "group">): string =>
  `dori/${spec.group ?? DEFAULT_GROUP}/${spec.name}`;
const nameParts = (name: string | undefined): { readonly group: string; readonly name: string } | undefined => {
  const m = name === undefined ? null : /^dori\/([^/]+)\/(.+)$/.exec(name);
  return m?.[1] === undefined || m[2] === undefined ? undefined : { group: m[1], name: m[2] };
};

/**
 * `open --cwd --model --name`: an idle agent session the host retains after this call exits. The ref id is the durable
 * session id (it survives a park or a host restart; the routing handle does not), which is also PI_SESSION_ID inside it.
 * A host session runs in the host's own environment, so an env cannot be applied: it is refused, never dropped.
 */
export async function create(exec: Exec, spec: CreateSpec): Promise<SessionRef> {
  const keys = Object.keys(spec.env);
  if (keys.length > 0)
    throw new Error(`an omo-host session cannot carry env (${keys.join(", ")}); pass it in the agent's commands`);
  const opened = await hostCall(exec, [
    "open",
    "--cwd",
    spec.cwd,
    ...(spec.model === undefined ? [] : ["--model", spec.model]),
    "--name",
    sessionName(spec),
  ]);
  const id = str(opened["durableSessionId"]);
  if (id === undefined) throw new Error("omo host session open did not return a durableSessionId");
  return { runtime: "omo-host", id, group: spec.group ?? DEFAULT_GROUP };
}

const rows = (listed: Record<string, unknown>): Record<string, unknown>[] =>
  Array.isArray(listed["sessions"]) ? listed["sessions"].map(rec) : [];

/** The host's live sessions (`list` only observes: it never resumes a parked session or counts as occupancy). */
export async function list(exec: Exec, group: string | undefined): Promise<SessionInfo[]> {
  const out: SessionInfo[] = [];
  for (const row of rows(await hostCall(exec, ["list"]))) {
    const id = str(row["durableSessionId"]);
    if (id === undefined || row["archived"] === true) continue;
    const parts = nameParts(str(row["name"]));
    if (group !== undefined && parts?.group !== group) continue;
    const [name, cwd] = [parts?.name ?? str(row["name"]), str(row["cwd"])];
    out.push({
      ref: { runtime: "omo-host", id, ...(parts === undefined ? {} : { group: parts.group }) },
      ...(name === undefined ? {} : { name }),
      ...(cwd === undefined ? {} : { cwd }),
      status: row["activity"] === "running" ? "working" : "idle",
      agent: "omo",
    });
  }
  return out;
}

/** `state` of one session, or undefined when the host knows no such session. A parked one is resumed by the call. */
export async function stateOf(exec: Exec, id: string): Promise<Record<string, unknown> | undefined> {
  try {
    return rec((await hostCall(exec, ["state", id]))["state"]);
  } catch (e) {
    if (isReason(e, "unknown_session")) return undefined;
    throw e;
  }
}

/**
 * working: a turn or compaction runs; else idle. A pending question or dialog is idle too, never blocked: in a host
 * session the agent's question tool answers "the answer will arrive as a user message", so the next prompt is the answer.
 */
export function statusOf(state: Record<string, unknown>): AgentStatus {
  return state["isStreaming"] === true || state["isCompacting"] === true ? "working" : "idle";
}

/**
 * omo's goal record for the session: `<session dir>/extensions/goal/<session id>.json` holding `{ goal: { status } }`,
 * the record omo's own goal footer is drawn from. `none` when the session has no goal (or no record yet).
 */
export function goalOf(state: Record<string, unknown>): string {
  const [file, id] = [str(state["sessionFile"]), str(state["sessionId"])];
  if (file === undefined || id === undefined) return "none";
  try {
    const record = rec(
      JSON.parse(readFileSync(join(dirname(file), "extensions", "goal", `${encodeURIComponent(id)}.json`), "utf8")),
    );
    return str(rec(record["goal"])["status"]) ?? "none";
  } catch {
    return "none";
  }
}

export function probeOf(state: Record<string, unknown> | undefined): Probe {
  if (state === undefined) return { status: "gone", shellInFront: false };
  const [title, cwd] = [str(state["sessionName"]), str(state["cwd"])];
  return {
    status: statusOf(state),
    agent: "omo",
    ...(title === undefined ? {} : { title }),
    ...(cwd === undefined ? {} : { cwd }),
    shellInFront: false,
    goal: goalOf(state),
  };
}

/**
 * `close`. `closed: false` means another client (a `dori attach` view) still holds the session, and the host never
 * forces it: the running turn is stopped and the close fails with the way out, so the lane's receipt says not closed.
 */
export async function close(exec: Exec, id: string): Promise<void> {
  let closed: Record<string, unknown>;
  try {
    closed = await hostCall(exec, ["close", id]);
  } catch (e) {
    if (isReason(e, "unknown_session")) return;
    throw e;
  }
  if (closed["closed"] !== false) return;
  await hostCall(exec, ["abort", id]);
  throw new Error(`omo host session ${id} is still attached by a viewer: quit it, then omo host session close ${id}`);
}

/** The caller's own host session: PI_SESSION_ID, only inside a host (SENPI_RPC_HOST_PUBLIC_SOCKET set). */
export function selfRef(env: Readonly<Record<string, string | undefined>>): SessionRef | undefined {
  const [socket, id] = [env["SENPI_RPC_HOST_PUBLIC_SOCKET"], env["PI_SESSION_ID"]];
  return socket && id ? { runtime: "omo-host", id } : undefined;
}
