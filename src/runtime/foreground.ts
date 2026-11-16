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
