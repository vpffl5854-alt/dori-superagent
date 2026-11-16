import { existsSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { appendQueue, readQueue } from "./inbox-files.ts";
import type { Deps } from "./harness.ts";
import type { MigrateOpts } from "./migrate-capture.ts";
import { refText } from "./refs.ts";
import type { SessionRef } from "./runtime/types.ts";
import type { QueuedMessage } from "./store-types.ts";

const LOCK_TRIES = 30;
const LOCK_RETRY_MS = 1_000;
const GONE_INPUT = "typed into the session it was migrated from; that input is gone";

const keyOf = (m: QueuedMessage): string => `${m.at}\u0000${m.from}\u0000${m.text}`;

/** A typed attempt's input stays behind in the old session, so on the new one it is held like an ambiguous delivery. */
const carried = (m: QueuedMessage): QueuedMessage =>
  m.attempt?.state === "typed" ? { ...m, attempt: { at: m.attempt.at, state: "ambiguous", detail: GONE_INPUT } } : m;

/** Runs `body` under the inbox locks of every ref (in the order given), retrying while another flush holds one. */
async function underLocks(d: Deps, refs: readonly SessionRef[], opts: MigrateOpts, body: () => void): Promise<void> {
  for (let tries = 0; ; tries++) {
    const held: (() => void)[] = [];
    for (const ref of refs) {
      const release = d.store.lockInbox(ref, d.now());
      if (!release) break;
      held.push(release);
    }
    try {
      if (held.length === refs.length) {
        body();
        return;
      }
    } finally {
      for (const release of held.reverse()) release();
    }
    if (tries >= LOCK_TRIES) throw new Error(`the inboxes of ${refs.map(refText).join(", ")} stay locked`);
    await opts.sleep(LOCK_RETRY_MS);
  }
}

/**
 * Appends every entry of `src` (and a `.merging` copy a cut-short run left) to `dst`, never rename-overwriting `dst`.
 * The source is renamed aside first, so an append racing the move lands in a fresh source file for a later merge; an
 * entry `dst` already holds (keyed by at+from+text) is not added again, so a re-run after a crash adds no duplicates.
 */
function mergeFile(src: string, dst: string, map: (m: QueuedMessage) => QueuedMessage): void {
  const aside = `${src}.merging`;
  if (!existsSync(aside) && existsSync(src)) renameSync(src, aside);
  const seen = new Set(readQueue(dst).map(keyOf));
  for (const m of readQueue(aside)) {
    if (seen.has(keyOf(m))) continue;
    seen.add(keyOf(m));
    appendQueue(dst, map(m));
  }
  rmSync(aside, { force: true });
}

/**
 * Step (6): writes the `.forward` marker on the old inbox naming the new ref, then merges the old entries into the new
 * inbox under both inbox locks. Plain entries stay queued, held stay held, typed become held.
 */
export async function moveInbox(d: Deps, from: SessionRef, to: SessionRef, opts: MigrateOpts): Promise<void> {
  const old = d.store.inboxPath(from);
  await underLocks(d, [from, to], opts, () => {
    const marker = `${old}.forward`;
    writeFileSync(`${marker}.tmp`, `${refText(to)}\n`);
    renameSync(`${marker}.tmp`, marker);
    mergeFile(old, d.store.inboxPath(to), carried);
  });
}

/** Step (8): drains what late senders appended to the old path into the new inbox, then removes the marker. */
export async function drainForward(d: Deps, from: SessionRef, to: SessionRef, opts: MigrateOpts): Promise<void> {
  const old = d.store.inboxPath(from);
  await underLocks(d, [to], opts, () => {
    d.store.mergeForwarded(to);
    rmSync(`${old}.forward`, { force: true });
  });
}

/** Rollback after step (6) ran: the entries go back to the old inbox (unchanged, held entries still held). */
export async function moveBack(d: Deps, from: SessionRef, to: SessionRef, opts: MigrateOpts): Promise<void> {
  const old = d.store.inboxPath(from);
  if (!existsSync(`${old}.forward`)) return;
  await underLocks(d, [from, to], opts, () => {
    rmSync(`${old}.forward`, { force: true });
    mergeFile(d.store.inboxPath(to), old, (m) => m);
  });
}
