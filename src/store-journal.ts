import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { takeInboxLock } from "./inbox-lock.ts";
import { sameSession } from "./refs.ts";
import type { RuntimeKind, SessionRef } from "./runtime/types.ts";

/**
 * The durable record of one `dori migrate` of a lane or role (`DORI_HOME/migrate/<name>.json`), rewritten tmp+rename
 * before each phase so a crashed run resumes where it stopped. `hold`: the session is held (no flush, no nudge);
 * `opened`: the replacement `newRef` exists; `switched`: the record points at it and only the old close is left.
 */
export type MigrateJournal = {
  readonly name: string;
  readonly kind: "lane" | "role";
  readonly phase: "hold" | "opened" | "switched";
  readonly from: SessionRef;
  readonly to: RuntimeKind;
  readonly newRef?: SessionRef;
  readonly at: number;
  readonly briefPath?: string;
};

const dir = (root: string): string => join(root, "migrate");
const pathOf = (root: string, name: string): string => join(dir(root), `${name}.json`);

export function readJournal(root: string, name: string): MigrateJournal | undefined {
  const path = pathOf(root, name);
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as MigrateJournal) : undefined;
}

export function writeJournal(root: string, journal: MigrateJournal): void {
  mkdirSync(dir(root), { recursive: true });
  const path = pathOf(root, journal.name);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(journal, null, 2)}\n`);
  renameSync(tmp, path);
}

/** The first journal of a run, created O_EXCL: a second migration that raced to the same name is refused. */
export function createJournal(root: string, journal: MigrateJournal): boolean {
  mkdirSync(dir(root), { recursive: true });
  try {
    writeFileSync(pathOf(root, journal.name), `${JSON.stringify(journal, null, 2)}\n`, { flag: "wx" });
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  }
}

export const removeJournal = (root: string, name: string): void => rmSync(pathOf(root, name), { force: true });

/** One live run per name: the inbox lock's rules (a dead holder on this host frees it). Undefined while held. */
export function lockMigration(root: string, name: string, now: number): (() => void) | undefined {
  mkdirSync(dir(root), { recursive: true });
  return takeInboxLock(join(dir(root), `${name}.lock`), now);
}

/** True while a migration journal names `ref` as its source or its replacement: its inbox is held, not flushed. */
export function migrating(root: string, ref: SessionRef): boolean {
  if (!existsSync(dir(root))) return false;
  return readdirSync(dir(root))
    .filter((f) => f.endsWith(".json"))
    .some((f) => {
      const j = readJournal(root, f.slice(0, -".json".length));
      return j !== undefined && (sameSession(j.from, ref) || (j.newRef !== undefined && sameSession(j.newRef, ref)));
    });
}
