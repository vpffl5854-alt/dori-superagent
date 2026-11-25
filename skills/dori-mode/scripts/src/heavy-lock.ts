import { dlopen, FFIType } from "bun:ffi";
import { closeSync, openSync } from "node:fs";
import { join } from "node:path";

const LOCK_POLL_MS = 50;
// Same values in glibc <sys/file.h> and xnu <sys/fcntl.h>.
const LOCK_EX = 2,
  LOCK_NB = 4,
  LOCK_UN = 8;
const LIBC: Readonly<Record<string, string>> = { linux: "libc.so.6", darwin: "/usr/lib/libSystem.B.dylib" };

export type Flock = (fd: number, operation: number) => number;

export class HeavyAdmissionError extends Error {}

// No lock means no heavy admission: a platform or libc without flock(2) stops `dori heavy` with this error instead of
// admitting jobs unguarded.
export const loadFlock = (platform: string = process.platform, path = LIBC[platform]): Flock => {
  if (path === undefined)
    throw new HeavyAdmissionError(`dori heavy needs flock(2); it supports linux (glibc) and macOS, not ${platform}`);
  try {
    const lib = dlopen(path, { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } });
    return (fd, operation) => lib.symbols.flock(fd, operation);
  } catch (e) {
    throw new HeavyAdmissionError(
      `dori heavy needs flock(2) from ${path} on ${platform} and could not load it: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
};

let systemFlock: Flock | undefined;
const defaultFlock = (): Flock => (systemFlock ??= loadFlock());

// Sampling the host, counting, deciding and claiming (a takeover included) run under one flock(2) on <dir>/.lock, so
// no two waiters decide on the same count, take the same orphaned slot, or decide on memory sampled before a long wait
// for the lock. The kernel drops the lock only when its holder exits, so a paused holder keeps it and a dead one never
// leaves it behind; no age or pid guess is involved.
export const underLock = async <T>(
  dir: string,
  section: () => T | Promise<T>,
  load: () => Flock = defaultFlock,
): Promise<T> => {
  const flock = load();
  const fd = openSync(join(dir, ".lock"), "a");
  try {
    while (flock(fd, LOCK_EX | LOCK_NB) !== 0) await Bun.sleep(LOCK_POLL_MS);
    try {
      return await section();
    } finally {
      flock(fd, LOCK_UN);
    }
  } finally {
    closeSync(fd);
  }
};
