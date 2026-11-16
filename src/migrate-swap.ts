import type { Deps } from "./harness.ts";
import { POLL_MS, type MigrateOpts, type Subject } from "./migrate-capture.ts";
import { drainForward, moveBack, moveInbox } from "./migrate-inbox.ts";
import { refText } from "./refs.ts";
import { groupId } from "./runtime/group.ts";
import { formatRef, openSession, type RuntimeKind, type SessionRef, type SessionRuntime } from "./runtime/types.ts";
import { type MigrateJournal, removeJournal, writeJournal } from "./store-journal.ts";
import type { Role } from "./store-types.ts";

export const VERIFY_MS = 3 * 60_000;

export const runtimeOf = (d: Deps, kind: RuntimeKind): SessionRuntime => d.runtimes.for({ runtime: kind, id: "" });

/** The group new sessions join on the target: this home's group label on hc, a new "dori" workspace on herdr. */
const targetGroup = async (d: Deps, rt: SessionRuntime, cwd: string): Promise<string> =>
  rt.kind === "hc" ? groupId(d.store.root) : rt.createGroup("dori", cwd);

/** Step (4): opens the replacement on the target; the journal records it before anything else moves. */
async function open(d: Deps, s: Subject, j: MigrateJournal, command: string): Promise<MigrateJournal> {
  const rt = runtimeOf(d, j.to);
  const newRef = await openSession(rt, s.spec(await targetGroup(d, rt, s.cwd)), command);
  const next: MigrateJournal = { ...j, phase: "opened", newRef };
  writeJournal(d.store.root, next);
  return next;
}

/** Step (5): the new session's probe reaches idle or working within VERIFY_MS, polled every POLL_MS. */
async function verify(d: Deps, ref: SessionRef, opts: MigrateOpts): Promise<string | undefined> {
  const rt = d.runtimes.for(ref);
  const deadline = d.now() + VERIFY_MS;
  for (;;) {
    const { status } = await rt.probe(ref);
    if (status === "idle" || status === "working") return undefined;
    if (d.now() >= deadline) return `never reached idle or working within 3 min (last: ${status})`;
    await opts.sleep(POLL_MS);
  }
}

async function closeQuietly(d: Deps, ref: SessionRef): Promise<void> {
  const rt = d.runtimes.for(ref);
  if ((await rt.probe(ref).catch(() => undefined))?.status === "gone") return;
  await rt.close(ref);
}

/**
 * Steps (4)-(8) for an agent session, resuming at the journal's phase: open, verify (rollback on failure: close the
 * new one, put the inbox back, clear the hold, exit 3), move the inbox, switch the record, close the old one.
 */
export async function swapAgent(d: Deps, s: Subject, j: MigrateJournal, command: string, opts: MigrateOpts) {
  if (j.phase === "hold") j = await open(d, s, j, command);
  const newRef = j.newRef as SessionRef;
  if (j.phase === "opened") {
    const why = await verify(d, newRef, opts);
    if (why !== undefined) {
      await closeQuietly(d, newRef).catch(() => undefined);
      await moveBack(d, j.from, newRef, opts);
      removeJournal(d.store.root, s.name);
      s.setHold(false);
      opts.log(`MIGRATE_ROLLBACK ${s.name} ${formatRef(newRef)} ${why}`);
      return 3;
    }
    await moveInbox(d, j.from, newRef, opts);
    s.switchTo(newRef);
    j = { ...j, phase: "switched" };
    writeJournal(d.store.root, j);
  }
  await closeQuietly(d, j.from);
  await drainForward(d, j.from, newRef, opts);
  removeJournal(d.store.root, s.name);
  s.setHold(false);
  opts.log(`MIGRATED ${s.name} ${refText(j.from)} -> ${formatRef(newRef)}`);
  return 0;
}

/**
 * A loop session is a plain process with no state. duty-loop: the old loop is closed FIRST (the duty lock allows one
 * loop per home anyway), then the new one opens; hourly-loop: the new one opens, then the old one closes (its own lock
 * serialises the two). Resumes at the journal's phase; there is no inbox and no agent to verify.
 */
export async function swapLoop(d: Deps, role: Role, j: MigrateJournal, cwd: string, opts: MigrateOpts) {
  const closeFirst = role === "duty-loop";
  const command = role === "duty-loop" ? `${d.doriCmd} duty --interval 60` : `${d.doriCmd} loop`;
  if (j.phase === "hold") {
    if (closeFirst) await closeQuietly(d, j.from);
    const rt = runtimeOf(d, j.to);
    const group = await targetGroup(d, rt, cwd);
    const spec = { name: role, role, container: "tab", cwd, env: { DORI_HOME: d.store.root }, group } as const;
    j = { ...j, phase: "opened", newRef: await openSession(rt, spec, command) };
    writeJournal(d.store.root, j);
  }
  const newRef = j.newRef as SessionRef;
  if (j.phase === "opened") {
    d.store.setRole(role, newRef);
    j = { ...j, phase: "switched" };
    writeJournal(d.store.root, j);
  }
  if (!closeFirst) await closeQuietly(d, j.from);
  removeJournal(d.store.root, role);
  opts.log(`MIGRATED ${role} ${refText(j.from)} -> ${formatRef(newRef)}`);
  return 0;
}
