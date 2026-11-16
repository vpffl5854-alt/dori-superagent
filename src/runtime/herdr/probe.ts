import { interactiveShellInFront } from "../foreground.ts";
import type { AgentStatus, ForegroundProcess, Probe } from "../types.ts";
import { type HerdrCli, reasonOf, ToolError } from "./exec.ts";

const INPUT_RULE = /^─{10,}$/;
/** Lines omo prints below its input box (cwd/model line, status line); more than this and the box is not at the bottom. */
const FOOTER_MAX_LINES = 3;
/** Recent lines read to look for omo's idle input box. */
const SCREEN_LINES = 30;
/** What a failed lookup means outside a delivery: the status is read as doubt, and nothing is held by the probe itself. */
const AS_DOUBT = "status read as doubt";
const HERDR_STATES: ReadonlySet<string> = new Set(["idle", "working", "blocked", "done"]);

/**
 * True only when an omo screen positively shows its idle input at the bottom: a bare rule, an empty `❯`
 * line, a bare rule, and no `esc to interrupt` anywhere. Anything else (a turn, a dialog, a draft in the
 * input, an unknown layout) is false, so the caller keeps queueing. Stopgap for #62: herdr reports an omo
 * whose live monitors or background cells are running as `working` even between turns.
 */
export function omoScreenIdle(screen: string): boolean {
  if (screen.includes("esc to interrupt")) return false;
  const lines = screen.split("\n").map((l) => l.trimEnd());
  while (lines.length > 0 && lines.at(-1) === "") lines.pop();
  const input = lines.lastIndexOf("❯");
  if (input < 1 || input + 1 >= lines.length) return false;
  if (!INPUT_RULE.test(lines[input - 1] ?? "") || !INPUT_RULE.test(lines[input + 1] ?? "")) return false;
  return lines.length - 1 - (input + 1) <= FOOTER_MAX_LINES;
}

export type PaneAgent = { status: AgentStatus; agent?: string; title?: string; cwd?: string };

const text = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);

/** herdr's status word for a pane record: no agent is a shell; herdr's four states pass through, anything else unknown. */
export function paneStatus(pane: Record<string, unknown>): AgentStatus {
  if (!pane["agent"]) return "shell";
  const s = String(pane["agent_status"] ?? "unknown");
  return HERDR_STATES.has(s) ? (s as AgentStatus) : "unknown";
}

/** `pane get`: the agent status, the agent name when one is detected, and the pane's title and cwd. */
export async function paneAgent(cli: HerdrCli, paneId: string): Promise<PaneAgent> {
  let pane: Record<string, unknown> | undefined;
  try {
    pane = (await cli.call(["pane", "get", paneId]))["pane"] as Record<string, unknown> | undefined;
  } catch (e) {
    if (e instanceof ToolError && /not.?found/i.test(e.message)) return { status: "gone" };
    throw e;
  }
  if (!pane) return { status: "gone" };
  const title = text(pane["title"]);
  const cwd = text(pane["cwd"]);
  const where = { ...(title !== undefined ? { title } : {}), ...(cwd !== undefined ? { cwd } : {}) };
  const status = paneStatus(pane);
  return status === "shell" ? { status, ...where } : { status, agent: String(pane["agent"]), ...where };
}

export type Front = {
  readonly shell: boolean;
  readonly pgid?: number;
  readonly rootPid?: number;
  readonly processes?: readonly ForegroundProcess[];
};

const toProcess = (value: unknown): ForegroundProcess => {
  const p = (value ?? {}) as { name?: unknown; argv?: unknown; pid?: unknown };
  const argv = Array.isArray(p.argv) ? p.argv.map(String) : [];
  return { name: String(p.name ?? ""), argv, ...(typeof p.pid === "number" ? { pid: p.pid } : {}) };
};

/**
 * `pane process-info`: whether an interactive shell is in front (#66, see interactiveShellInFront) and the foreground
 * process group. A failed or unreadable lookup is doubt (a shell in front) and is one stderr line ending in `onFail`:
 * what the caller does about it ("holding delivery" from deliver, "status read as doubt" from a plain probe).
 */
export async function foreground(cli: HerdrCli, paneId: string, onFail: string = AS_DOUBT): Promise<Front> {
  try {
    const info = (await cli.call(["pane", "process-info", "--pane", paneId]))["process_info"] as
      | { foreground_process_group_id?: unknown; foreground_processes?: unknown; shell_pid?: unknown }
      | undefined;
    const pgid = info?.foreground_process_group_id;
    const rootPid = info?.shell_pid;
    const procs = info?.foreground_processes;
    const processes = Array.isArray(procs) ? procs.map(toProcess) : undefined;
    return {
      shell: interactiveShellInFront(processes),
      ...(typeof pgid === "number" ? { pgid } : {}),
      ...(typeof rootPid === "number" ? { rootPid } : {}),
      ...(processes ? { processes } : {}),
    };
  } catch (e) {
    process.stderr.write(`dori: herdr pane process-info failed for ${paneId} (${reasonOf(e)}); ${onFail}\n`);
    return { shell: true };
  }
}

/** #62: believe the screen only when it positively shows the idle input; a failed read is doubt and stays working. */
async function screenShowsIdle(cli: HerdrCli, paneId: string): Promise<boolean> {
  try {
    return omoScreenIdle(await cli.read(paneId, SCREEN_LINES));
  } catch {
    return false;
  }
}

/**
 * One snapshot of a pane: herdr's status (with the #62 screen check), the agent, its foreground, title and cwd.
 * `screenCheck: false` skips the #62 screen read, for callers that act the same whether the agent is idle or working.
 * `onFail` ends the stderr line of a failed process-info lookup (see foreground).
 */
export async function probe(cli: HerdrCli, paneId: string, screenCheck = true, onFail = AS_DOUBT): Promise<Probe> {
  const { status, agent, title, cwd } = await paneAgent(cli, paneId);
  if (status === "gone") return { status, shellInFront: true };
  const seen: AgentStatus =
    screenCheck && status === "working" && (await screenShowsIdle(cli, paneId)) ? "idle" : status;
  const front = await foreground(cli, paneId, onFail);
  return {
    status: seen,
    ...(agent !== undefined ? { agent } : {}),
    ...(front.pgid !== undefined ? { pgid: front.pgid } : {}),
    ...(front.rootPid !== undefined ? { rootPid: front.rootPid } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
    shellInFront: front.shell,
    ...(front.processes ? { foreground: front.processes } : {}),
  };
}
