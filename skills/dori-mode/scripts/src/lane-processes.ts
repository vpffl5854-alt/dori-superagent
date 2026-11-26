import type { SessionRef, TerminalKind } from "../../../../src/runtime/types.ts";
import type { ChosenRuntimes, Runner } from "./run.ts";
import { descendants, PS_ARGV, type Proc, parseProcs } from "./session-id.ts";

/** A string is why the table could not be read. */
type Snapshot = readonly Proc[] | string;

const readTable = async (run: Runner): Promise<Snapshot> => {
  const r = await run(PS_ARGV);
  return r.code === 0 ? parseProcs(r.out) : r.err || `ps exited ${r.code}`;
};

/** The variable each runtime sets to the session's own id in the environment of the session's processes. */
const SESSION_VAR: Readonly<Record<TerminalKind, string>> = { herdr: "HERDR_PANE_ID", hc: "HC_TERMINAL_ID" };

/**
 * The root pid comes from the runtime, which may run the session on another host, while `ps` reads this host. The root
 * counts as the session's only when the process with that pid here carries the session's own id; undefined when it
 * does, else why not. Only the lane's own runtime variable counts: a process can inherit the other runtime's id.
 */
const notOwnedHere = async (run: Runner, ref: SessionRef, root: number): Promise<string | undefined> => {
  const env = await run(["ps", "eww", "-o", "command=", "-p", String(root)]);
  if (env.code !== 0 || !env.out.trim()) return `session root ${root} could not be read on this host`;
  // An omo-host session runs inside the shared engine host: no process there belongs to this lane alone.
  if (ref.runtime === "omo-host")
    return "an omo-host session shares the engine host's processes; none is the lane's own";
  const marker = `${SESSION_VAR[ref.runtime]}=${ref.id}`;
  return env.out.split(/\s+/).includes(marker)
    ? undefined
    : `session root ${root} on this host does not carry ${marker} (the session may run on another host)`;
};

/**
 * The lane pane's root process and every process under it, read while the pane is still open. Watches an agent starts
 * in the background (a `tail -F | grep` pipeline, a background shell) are in this tree until the pane closes; after
 * that they are re-parented to init and nothing else ties them to the lane.
 */
export const laneProcesses = async (rts: ChosenRuntimes, run: Runner, ref: SessionRef): Promise<Snapshot> => {
  const root = await rts
    .for(ref)
    .probe(ref)
    .then(
      (p) => p.rootPid,
      () => undefined,
    );
  if (root === undefined) return "the session reported no root process";
  const doubt = await notOwnedHere(run, ref, root);
  if (doubt) return doubt;
  const table = await readTable(run);
  if (typeof table === "string") return table;
  return [...table.filter((p) => p.pid === root), ...descendants(table, root)];
};

/**
 * After the pane is closed: SIGTERM to each recorded process that is still running with the same command line, by
 * exact pid. A pid that now runs another command was reused and is left alone. Never throws; the result is one receipt line.
 */
export const stopLeftovers = async (run: Runner, before: Snapshot): Promise<string> => {
  if (typeof before === "string") return `lane processes not checked: ${before}`;
  const after = before.length ? await readTable(run) : [];
  if (typeof after === "string") return `lane processes not checked: ${after}`;
  const alive = before.filter((p) => after.some((a) => a.pid === p.pid && a.cmd === p.cmd)).map((p) => String(p.pid));
  if (!alive.length) return "no lane process outlived the pane";
  const r = await run(["kill", "-TERM", ...alive]);
  const what = `${alive.length} lane processes outlived the pane`;
  return r.code === 0
    ? `${what}, stopped: ${alive.join(" ")}`
    : `${what}, stop incomplete (${r.err.slice(0, 120)}): ${alive.join(" ")}`;
};
