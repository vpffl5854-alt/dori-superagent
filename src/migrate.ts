import { readFileSync } from "node:fs";
import { join } from "node:path";
import { need, one, USAGE, type Args } from "./cli-args.ts";
import { shq } from "./delivery.ts";
import { prompt, promptsDir, type Deps } from "./harness.ts";
import { Refusal } from "./refusal.ts";
import { askCheckpoint, capture, type MigrateOpts, type Subject } from "./migrate-capture.ts";
import { swapAgent, swapLoop } from "./migrate-swap.ts";
import { refText } from "./refs.ts";
import type { RuntimeKind, SessionRef } from "./runtime/types.ts";
import {
  createJournal,
  lockMigration,
  type MigrateJournal,
  readJournal,
  removeJournal,
  writeJournal,
} from "./store-journal.ts";
import type { Lane, Role } from "./store-types.ts";

export type Target = { readonly lane?: string; readonly role?: Role; readonly all?: boolean };

const AGENT_ROLES: readonly Role[] = ["lead", "duty"];
const LOOP_ROLES: readonly Role[] = ["duty-loop", "hourly-loop"];
const isOpen = (l: Lane): boolean => l.status !== "done" && l.status !== "lost";

function laneSubject(d: Deps, key: string): Subject {
  const lane = d.store.lane(key);
  if (!lane || !isOpen(lane)) throw new Refusal(`no open lane ${key}`);
  const kickoff = (brief: string) => `Read your brief at ${brief} and execute it. Your lane key is ${key}.`;
  const save = (change: (l: Lane) => Lane): void => d.store.saveLane(change(d.store.lane(key) as Lane));
  return {
    name: key,
    kind: "lane",
    from: lane.sessionRef,
    cwd: lane.cwd,
    brief: () => readFileSync(lane.brief, "utf8"),
    footer: prompt("lane-footer.md", { key, dori: d.doriCmd }),
    logTail: lane.log.slice(-20).map((e) => `- ${new Date(e.at).toISOString()} ${e.kind}: ${e.text}`),
    ...(lane.sessionPath === undefined ? {} : { sessionPath: lane.sessionPath }),
    spec: (group) => ({
      name: key,
      role: "lane",
      container: "tab",
      cwd: lane.cwd,
      env: { DORI_LANE: key, DORI_HOME: d.store.root },
      ...(group === undefined ? {} : { group }),
    }),
    command: (brief) => `${d.agentCmd} ${shq(kickoff(brief))}`,
    setHold: (on) => save(({ migration: _, ...l }) => (on ? { ...l, migration: true } : l)),
    switchTo: (ref) =>
      save((l) => ({ ...l, sessionRef: ref, migratedFrom: [...(l.migratedFrom ?? []), l.sessionRef] })),
  };
}

function roleSubject(d: Deps, role: Role, from: SessionRef): Subject {
  const name = role === "lead" ? "lead.md" : "duty.md";
  return {
    name: role,
    kind: "role",
    from,
    cwd: process.cwd(),
    brief: () => readFileSync(join(promptsDir(), name), "utf8").replaceAll("{{dori}}", d.doriCmd),
    logTail: [],
    spec: (group) => ({
      name: role === "lead" ? "dori" : "duty",
      role,
      container: "tab",
      cwd: process.cwd(),
      env: role === "lead" ? {} : { DORI_HOME: d.store.root },
      ...(group === undefined ? {} : { group }),
    }),
    command: (brief) => `${d.agentCmd} --append-system-prompt ${shq(brief)}`,
    setHold: () => {},
    switchTo: (ref) => d.store.setRole(role, ref),
  };
}

/** --resume: only a live source that is idle or done, with its agent's session file on record. */
async function resumeCommand(d: Deps, s: Subject): Promise<string> {
  if (s.sessionPath === undefined)
    throw new Refusal(`--resume refused for ${s.name}: no recorded session path; migrate without --resume`);
  const { status } = await d.runtimes.for(s.from).probe(s.from);
  if (status !== "idle" && status !== "done")
    throw new Refusal(`--resume refused for ${s.name}: its session is ${status}, not idle or done`);
  return `${d.agentCmd} --session ${shq(s.sessionPath)}`;
}

/** Steps (1)-(3) for an agent session, then the swap. Resumes at the journal's phase. */
async function agentSession(d: Deps, s: Subject, j: MigrateJournal | undefined, opts: MigrateOpts) {
  let resume: string | undefined;
  if (j === undefined) {
    if (opts.resume) resume = await resumeCommand(d, s);
    j = { name: s.name, kind: s.kind, phase: "hold", from: s.from, to: opts.to, at: d.now() };
    if (!createJournal(d.store.root, j)) throw new Refusal(`another dori migrate of ${s.name} is running`);
    s.setHold(true);
  }
  if (j.phase === "hold" && j.briefPath === undefined) {
    const asked = resume === undefined ? await askCheckpoint(d, s, opts) : "stopped";
    if (asked === "blocked" || asked === "working") {
      removeJournal(d.store.root, s.name);
      s.setHold(false);
      opts.log(`DEFERRED ${s.name} ${asked === "blocked" ? "blocked" : `working past ${opts.waitMinutes} min`}`);
      return 0;
    }
    j = { ...j, briefPath: await capture(d, s, j, asked === "gone") };
    writeJournal(d.store.root, j);
  }
  return swapAgent(d, s, j, resume ?? s.command(j.briefPath ?? ""), opts);
}

async function migrateName(d: Deps, name: string, from: SessionRef, opts: MigrateOpts, sub: () => Subject) {
  const j = readJournal(d.store.root, name);
  if (j !== undefined && j.to !== opts.to)
    throw new Refusal(`a migration of ${name} is in progress toward ${j.to}; finish it with --to ${j.to}`);
  if (j === undefined && from.runtime === opts.to) {
    opts.log(`SKIP ${name} already on ${opts.to}`);
    return 0;
  }
  if (opts.dryRun) {
    const what = j === undefined ? `inbox entries: ${d.store.queued(from).length}` : `resume at ${j.phase}`;
    opts.log(`PLAN ${name} ${refText(from)} -> ${opts.to} (${what})`);
    return 0;
  }
  const release = lockMigration(d.store.root, name, d.now());
  if (!release) throw new Refusal(`another dori migrate of ${name} is running`);
  try {
    if (LOOP_ROLES.includes(name as Role))
      return await swapLoop(d, name as Role, j ?? fresh(d, name, from, opts), process.cwd(), opts);
    return await agentSession(d, sub(), j, opts);
  } finally {
    release();
  }
}

function fresh(d: Deps, name: string, from: SessionRef, opts: MigrateOpts): MigrateJournal {
  const j: MigrateJournal = { name, kind: "role", phase: "hold", from, to: opts.to, at: d.now() };
  if (!createJournal(d.store.root, j)) throw new Refusal(`another dori migrate of ${name} is running`);
  return j;
}

/**
 * `dori migrate`: hands sessions over to `opts.to`. `--all` = every open lane, then lead and duty, then the duty loop
 * and the hourly loop. Returns the exit code: 3 when any session rolled back, else 0.
 */
export async function migrate(d: Deps, t: Target, opts: MigrateOpts): Promise<number> {
  const lanes = t.all
    ? d.store
        .lanes()
        .filter(isOpen)
        .map((l) => l.key)
    : t.lane
      ? [t.lane]
      : [];
  const roles = t.all ? [...AGENT_ROLES, ...LOOP_ROLES] : t.role ? [t.role] : [];
  if (lanes.length + roles.length === 0) throw new Refusal(`give --lane K, --role R or --all\n\n${USAGE}`);
  let code = 0;
  for (const key of lanes) {
    const lane = d.store.lane(key);
    if (!lane || !isOpen(lane)) throw new Refusal(`no open lane ${key}`);
    code = Math.max(code, await migrateName(d, key, lane.sessionRef, opts, () => laneSubject(d, key)));
  }
  for (const role of roles) {
    const ref = d.store.roles()[role];
    if (!ref) {
      if (t.all) continue;
      throw new Refusal(`no ${role} session registered`);
    }
    code = Math.max(code, await migrateName(d, role, ref, opts, () => roleSubject(d, role, ref)));
  }
  return code;
}

const KINDS: readonly RuntimeKind[] = ["herdr", "hc"];
const ROLE_NAMES: readonly Role[] = [...AGENT_ROLES, ...LOOP_ROLES];

export async function runMigrate(d: Deps, a: Args): Promise<number> {
  const to = (one(a, "to") ?? d.choice().kind) as RuntimeKind;
  if (!KINDS.includes(to)) throw new Refusal(`--to must be herdr or hc`);
  const role = one(a, "role") as Role | undefined;
  if (role !== undefined && !ROLE_NAMES.includes(role))
    throw new Refusal(`--role must be one of ${ROLE_NAMES.join(", ")}`);
  const wait = Number(one(a, "wait-minutes") ?? "10");
  if (!(Number.isFinite(wait) && wait >= 0)) throw new Refusal("--wait-minutes must be a number of minutes, 0 or more");
  const lane = one(a, "lane");
  if (lane !== undefined) need(lane, "--lane key");
  return migrate(
    d,
    { ...(lane === undefined ? {} : { lane }), ...(role === undefined ? {} : { role }), all: one(a, "all") === "true" },
    {
      to,
      dryRun: one(a, "dry-run") === "true",
      waitMinutes: wait,
      resume: one(a, "resume") === "true",
      sleep: Bun.sleep,
      log: console.log,
    },
  );
}
