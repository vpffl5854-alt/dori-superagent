/**
 * The session log an agent writes: the newest `.jsonl` for the directory it runs in. The lead path and a bot post
 * that called Dori both read the answer from this log, so both find it the same way.
 */
import type { Ran } from "../run.ts";

export const newestSessionLog = async (
  run: (argv: readonly string[]) => Promise<Ran>,
  sessionsDir: string,
  cwd: string,
): Promise<string | undefined> => {
  const dir = `${sessionsDir}/--${cwd.replace(/^\//, "").replace(/\//g, "-")}--`;
  const list = await run(["ls", "-t", dir]);
  if (list.code !== 0) return undefined;
  const newest = list.out
    .split("\n")
    .map((name) => name.trim())
    .find((name) => /^\d{4}-\d\d-\d\dT[\d-]+Z_[0-9a-f-]{36}\.jsonl$/.test(name));
  return newest ? `${dir}/${newest}` : undefined;
};
