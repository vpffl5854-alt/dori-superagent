import { linkSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { INBOX_LOCK_STALE_MS } from "./store-types.ts";

const readOrUndefined = (path: string): string | undefined => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
};

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** An unreadable lock (a holder that died between create and write) is judged by the file's age. */
function lockStale(path: string, content: string, now: number, staleMs: number): boolean {
  let lock: { pid?: unknown; host?: unknown; at?: unknown } = {};
  try {
    lock = JSON.parse(content) as typeof lock;
  } catch {
    // fall through to the file's mtime
  }
  // On this host the pid decides: a live holder keeps its lock however long an operation takes, or a second holder
  // would act on state the first is still changing. The age rule is only for locks from another host or locks that can't be read.
  if (lock.host === hostname() && typeof lock.pid === "number") return !pidAlive(lock.pid);
  const at =
    typeof lock.at === "number"
      ? lock.at
      : (() => {
          try {
            return statSync(path).mtimeMs;
          } catch {
            return now;
          }
        })();
  return now - at > staleMs;
}

/** Creates an exclusive lock and returns its release, or undefined while another live holder has it. */
export function takeLock(path: string, now: number, staleMs: number): (() => void) | undefined {
  const mine = JSON.stringify({ pid: process.pid, host: hostname(), at: now });
  for (let tries = 0; tries < 2; tries++) {
    try {
      writeFileSync(path, mine, { flag: "wx" });
      return () => {
        if (readOrUndefined(path) === mine) rmSync(path, { force: true });
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    const seen = readOrUndefined(path);
    if (seen === undefined) continue;
    if (!lockStale(path, seen, now, staleMs)) return undefined;
    const aside = `${path}.${process.pid}.stale`;
    try {
      renameSync(path, aside);
    } catch {
      continue;
    }
    if (readOrUndefined(aside) !== seen) {
      try {
        linkSync(aside, path);
      } catch {
        // a third process holds the lock now; either way it is not ours
      }
      rmSync(aside, { force: true });
      return undefined;
    }
    rmSync(aside, { force: true });
  }
  return undefined;
}

export function takeInboxLock(path: string, now: number): (() => void) | undefined {
  return takeLock(path, now, INBOX_LOCK_STALE_MS);
}
