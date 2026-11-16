import { readFileSync, statSync } from "node:fs";

/** A write holds the lock for milliseconds, so a lock this old was left behind even if its pid is alive again (pid reuse). */
export const LOCK_STALE_MS = 2 * 60_000;
export type LockOwner = { readonly pid: number; readonly host: string; readonly at: string; readonly nonce: string };
export type LockSeen = { readonly raw: string | null; readonly ino: number; readonly mtimeMs: number };

// raw is null for the lock directory an earlier build used; null overall when there is no lock.
export const inspect = (lock: string): LockSeen | null => {
  try {
    const stat = statSync(lock);
    return { raw: stat.isDirectory() ? null : readFileSync(lock, "utf8"), ino: stat.ino, mtimeMs: stat.mtimeMs };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
};
export const ownerOf = (raw: string | null): LockOwner | null => {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<LockOwner> | null;
    return typeof v?.pid === "number" &&
      typeof v.host === "string" &&
      typeof v.at === "string" &&
      typeof v.nonce === "string"
      ? (v as LockOwner)
      : null;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return null; // a writer stopped between creating the lock and writing its record
  }
};
export const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};
