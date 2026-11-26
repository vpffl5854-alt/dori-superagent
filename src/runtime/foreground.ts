import type { ForegroundProcess } from "./types.ts";

export const SHELLS: ReadonlySet<string> = new Set([
  "sh",
  "ash",
  "bash",
  "zsh",
  "fish",
  "dash",
  "ksh",
  "mksh",
  "tcsh",
  "csh",
  "nu",
  "elvish",
  "xonsh",
  "pwsh",
  "powershell",
  "busybox",
]);

const baseName = (value: string): string => value.replace(/^-/, "").split("/").pop()?.toLowerCase() ?? "";
const isPowerShell = (shell: string): boolean => shell === "pwsh" || shell === "powershell";
// A shell runs a command (not a prompt) only with an explicit command flag: -c, also inside combined short flags such
// as -lc, or PowerShell's -Command/-File/-EncodedCommand (whole words only: its other long flags contain a 'c'). Any
// other operand (a script path, --rcfile FILE, -o OPT) stays held.
const runsCommand = (shell: string, arg: string): boolean =>
  isPowerShell(shell) ? /^-(c|command|f|file|e|ec|encodedcommand)$/i.test(arg) : /^-[A-Za-z]*c[A-Za-z]*$/.test(arg);
// PowerShell's -NoExit (any prefix it accepts: -noe, -noex, -noexi, -noexit, one or two dashes) keeps an interactive
// prompt after the command runs, so that shell is held.
const keepsPrompt = (shell: string, arg: string): boolean => isPowerShell(shell) && /^--?noe(x(i(t)?)?)?$/i.test(arg);

/**
 * True when the foreground processes show an interactive shell, or cannot be read (`undefined` or empty is doubt).
 * A suspended agent leaves its shell in front while the runtime may still report it idle (#66). A shell that runs a
 * command flag (`sh -c ...`) is an agent's child, not a prompt, and does not count; any other shell, a script runner
 * such as `bash script.sh` included, is held. A runtime that reports only the group leader passes a one-element list.
 */
export function interactiveShellInFront(processes: readonly ForegroundProcess[] | undefined): boolean {
  if (processes === undefined || processes.length === 0) return true;
  for (const proc of processes) {
    let name = baseName(proc.name);
    let args = proc.argv.slice(1);
    const applet = args[0];
    if (name === "busybox" && applet !== undefined) [name, args] = [baseName(applet), args.slice(1)];
    if (!SHELLS.has(name)) continue;
    if (!args.some((a) => runsCommand(name, a)) || args.some((a) => keepsPrompt(name, a))) return true;
  }
  return false;
}

const stem = (value: string): string => baseName(value).replace(/\.[^.]*$/, "");
const isApp = (word: string, app: string): boolean => word === app || word.startsWith(`${app}-`);
const RUNS_NEXT: ReadonlySet<string> = new Set([".", "source", "exec"]);

/**
 * True when some process positively names the agent `app` (the name the program reported for itself): its executable is
 * `app` or `app-<suffix>` (a platform build), or it is a shell whose command runs `$0` (`sh -c '. "$0"' DIR/app-x.sh`)
 * and whose `$0`, the first path operand after that word, is named that way. The `$0` word counts only as the command
 * itself: the command's first word, or the word directly after `.`, `source` or `exec`. Any other program's arguments
 * never count, a shell command's included (`vim notes/omo.md`, `sh -c tail -f /var/log/omo-1.log`, `sh -c 'vim "$0"'
 * /w/omo.md`).
 * For a foreground the runtime did not name (#209): a stale report must not deliver into whatever runs in front now.
 */
export function namesAgent(processes: readonly ForegroundProcess[], app: string): boolean {
  const want = app.toLowerCase();
  return processes.some((proc) => {
    if (isApp(stem(proc.argv[0] ?? proc.name), want)) return true;
    const name = baseName(proc.name);
    const flag = proc.argv.findIndex((a, i) => i > 0 && runsCommand(name, a));
    if (!SHELLS.has(name) || flag < 0) return false;
    const zero = proc.argv.findLastIndex(
      (a, i) => i > flag && a.includes("$0") && (i === flag + 1 || RUNS_NEXT.has(proc.argv[i - 1] ?? "")),
    );
    const script = zero < 0 ? undefined : proc.argv.slice(zero + 1).find((a) => a.includes("/"));
    return script !== undefined && isApp(stem(script), want);
  });
}
