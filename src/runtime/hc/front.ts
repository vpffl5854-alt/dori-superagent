import type { Exec } from "../exec.ts";
import type { ForegroundProcess } from "../types.ts";

/** The same columns on macOS and Linux (procps); `-ww` keeps each command line whole. */
const PS_ARGV: readonly string[] = ["-A", "-ww", "-o", "pid=,pgid=,tpgid=,tty=,args="];
/** One row: pid, process group, the foreground group of its terminal, the terminal, then the command line. */
const ROW = /^\s*(\d+)\s+(\d+)\s+(-?\d+)\s+(\S+)\s+(.*)$/;

type ForegroundGroup = { readonly pgid: number; readonly processes: readonly ForegroundProcess[] };

/**
 * The process group in front of the terminal whose root process is `rootPid`, from one `ps` snapshot of the OS process
 * table: the root's terminal and its foreground group id (TPGID), then every process of that group on that terminal.
 * ps joins argv with spaces, so an argument holding a space reads as several. Undefined when nothing is provable: ps
 * failed, the root is not listed or has no terminal, or no process is in that group.
 */
export async function foregroundGroup(exec: Exec, rootPid: number): Promise<ForegroundGroup | undefined> {
  let stdout: string;
  try {
    const result = await exec("ps", PS_ARGV);
    if (result.code !== 0) return undefined;
    stdout = result.stdout;
  } catch {
    return undefined;
  }
  const rows = stdout.split("\n").flatMap((line) => {
    const [, pid, pgid, tpgid, tty = "", args = ""] = ROW.exec(line) ?? [];
    return pid === undefined ? [] : [{ pid: Number(pid), pgid: Number(pgid), tpgid: Number(tpgid), tty, args }];
  });
  const root = rows.find((r) => r.pid === rootPid);
  if (root === undefined || root.tpgid <= 0 || root.tty.startsWith("?")) return undefined;
  const processes = rows
    .filter((r) => r.pgid === root.tpgid && r.tty === root.tty)
    .map((r) => {
      const argv = r.args.split(/\s+/).filter(Boolean);
      return { name: argv[0] ?? "", argv, pid: r.pid };
    });
  return processes.length === 0 ? undefined : { pgid: root.tpgid, processes };
}
