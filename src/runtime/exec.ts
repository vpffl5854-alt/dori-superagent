// One injectable process runner shared by every runtime adapter, so tests replace the runtime binary with a recorder
// and end-to-end tests point it at an isolated session.

export type ExecResult = { readonly code: number; readonly stdout: string; readonly stderr: string };
/** `onSpawn` gets the running process, so a caller that gives up on it can kill it. */
export type ExecOptions = { readonly onSpawn?: (proc: { kill(): void }) => void };
export type Exec = (cmd: string, argv: readonly string[], options?: ExecOptions) => Promise<ExecResult>;

export const spawnExec: Exec = async (cmd, argv, options) => {
  const proc = Bun.spawn([cmd, ...argv], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  options?.onSpawn?.(proc);
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
};

/** A runtime CLI call that exited non-zero; the message carries the tool, its argv and the tool's own reason. */
export class ToolError extends Error {
  constructor(
    readonly argv: readonly string[],
    readonly result: ExecResult,
    tool: string,
  ) {
    super(`${tool} ${argv.join(" ")} failed (${result.code}): ${(result.stderr || result.stdout).trim()}`);
  }
}
