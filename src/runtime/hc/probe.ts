import { interactiveShellInFront, namesAgent } from "../foreground.ts";
import { omoScreenIdle } from "../herdr/probe.ts";
import type { AgentStatus, ForegroundProcess, Probe } from "../types.ts";
import type { Exec } from "../exec.ts";
import { hcCall, isKind } from "./exec.ts";
import { foregroundGroup } from "./front.ts";

/** Recent lines read to look for omo's idle input box (the same window the herdr runtime reads). */
const SCREEN_LINES = 30;

const REPORTED: ReadonlySet<string> = new Set(["idle", "working", "blocked", "error", "done"]);

const rec = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
const text = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);
const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

function foregroundOf(value: unknown): ForegroundProcess | undefined {
  const fg = rec(value);
  const name = text(fg?.["name"]);
  if (fg === undefined || name === undefined) return undefined;
  const argv = Array.isArray(fg["argv"]) ? fg["argv"].filter((a): a is string => typeof a === "string") : [name];
  const pid = num(fg["pid"]);
  return { name, argv, ...(pid === undefined ? {} : { pid }) };
}

/** The status word of hc's `status` field (an object `{state}`, or a bare word in `ls` rows); undefined when it never reported. */
export function statusWord(value: unknown): AgentStatus | undefined {
  const word = typeof value === "string" ? value : text(rec(value)?.["state"]);
  if (word === undefined) return undefined;
  return REPORTED.has(word) ? (word as AgentStatus) : "unknown";
}

/**
 * One `hc get` record as a Probe. The status is the program's own OSC 7501 word; a program that never reported is a
 * `shell` when an interactive shell leads the foreground, else `unknown`. The screen check is applied by `probe`.
 */
export function parseProbe(terminal: unknown): Probe {
  const t = rec(terminal) ?? {};
  if (t["state"] === "finished") return { status: "gone", shellInFront: false };
  const fg = foregroundOf(t["foreground"]);
  const foreground = fg === undefined ? undefined : [fg];
  const shellInFront = interactiveShellInFront(foreground);
  const status = statusWord(t["status"]) ?? (shellInFront ? "shell" : "unknown");
  const agent = text(rec(t["status"])?.["app"]) ?? fg?.name;
  const [rootPid, turn, title, cwd] = [num(t["pid"]), num(t["turn"]), text(t["title"]), text(t["cwd"])];
  return {
    status,
    ...(agent === undefined ? {} : { agent }),
    ...(fg?.pid === undefined ? {} : { pgid: fg.pid }),
    ...(rootPid === undefined ? {} : { rootPid }),
    ...(turn === undefined ? {} : { turn }),
    ...(title === undefined ? {} : { title }),
    ...(cwd === undefined ? {} : { cwd }),
    shellInFront,
    ...(foreground === undefined ? {} : { foreground }),
  };
}

/** #62 on hc: believe the screen only when it positively shows omo's idle input; a failed read is doubt and stays working. */
async function screenShowsIdle(exec: Exec, id: string): Promise<boolean> {
  try {
    const result = await hcCall(exec, ["read", id, "--lines", String(SCREEN_LINES)]);
    return typeof result["text"] === "string" && omoScreenIdle(result["text"]);
  } catch {
    return false;
  }
}

/**
 * #209: hc can report a status with no `foreground` (seen for up to ~0.5 s after a first report). Naming no foreground,
 * it has not cleared a stale status either (a suspended agent, #66), so the report alone proves nothing. The OS process
 * table is read instead: the agent is in front only when that group holds no interactive shell and a member names the
 * app hc reported. Anything less leaves the probe's doubt (`shellInFront`) as it was.
 */
async function withOsForeground(exec: Exec, parsed: Probe): Promise<Probe> {
  const { foreground, agent, rootPid } = parsed;
  if (foreground !== undefined || agent === undefined || rootPid === undefined) return parsed;
  const group = await foregroundGroup(exec, rootPid);
  if (group === undefined || interactiveShellInFront(group.processes) || !namesAgent(group.processes, agent))
    return parsed;
  return { ...parsed, pgid: group.pgid, shellInFront: false, foreground: group.processes };
}

/**
 * An agent that never reports OSC 7501 (omo) is classified off its screen — the same evidence the herdr runtime
 * scrapes. `esc to interrupt` positively marks a turn (a false positive only ever reads as working, the safe
 * direction); omo's idle input marks idle; anything else is undefined so doubt stays `unknown` and callers keep
 * queueing. A failed read is doubt too.
 */
async function screenStatus(exec: Exec, id: string): Promise<AgentStatus | undefined> {
  try {
    const result = await hcCall(exec, ["read", id, "--lines", String(SCREEN_LINES)]);
    const screen = typeof result["text"] === "string" ? result["text"] : "";
    if (screen.includes("esc to interrupt")) return "working";
    if (omoScreenIdle(screen)) return "idle";
    return undefined;
  } catch {
    return undefined;
  }
}

/** A probe plus hc's own status word, which `deliver` needs for its compare-and-send gate. */
export type HcProbe = { readonly probe: Probe; readonly word: AgentStatus };

/**
 * `hc get`, then the #62 screen check: omo reports `working` over OSC 7501 for as long as any monitor or background
 * session is live, even between turns (#178), so a `working` word with no shell in front reads `idle` when the screen
 * positively shows the idle input. A terminal hc no longer knows is `gone`; any other `get` failure throws.
 */
export async function probeWithWord(exec: Exec, id: string): Promise<HcProbe> {
  let parsed: Probe;
  try {
    parsed = await withOsForeground(exec, parseProbe(await hcCall(exec, ["get", id])));
  } catch (e) {
    if (isKind(e, "not_found")) return { probe: { status: "gone", shellInFront: false }, word: "gone" };
    throw e;
  }
  const word = parsed.status;
  // Never reported (status null, no shell in front): the screen is the only evidence, as on herdr.
  if (word === "unknown" && !parsed.shellInFront) {
    const seen = await screenStatus(exec, id);
    return { probe: seen === undefined ? parsed : { ...parsed, status: seen }, word };
  }
  if (word !== "working" || parsed.shellInFront || !(await screenShowsIdle(exec, id))) return { probe: parsed, word };
  return { probe: { ...parsed, status: "idle" }, word };
}

export async function probe(exec: Exec, id: string): Promise<Probe> {
  return (await probeWithWord(exec, id)).probe;
}
