/** dori incidents [--report]: Dori's own logs scanned for repeating faults; with --report each becomes issue + backlog. */
import {
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  statSync,
  writeFileSync,
  closeSync,
  readFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { type Command, die } from "./cli-context.ts";
import { fill } from "./config.ts";
import { dueIncidents, type IncidentState, incidentKey, issueBody, issueTitle, scanText } from "./incidents.ts";
import { run } from "./run.ts";

export type IncidentsConfig = {
  /** `owner/repo` the issues go to. */
  readonly repo?: string;
  readonly threshold?: number;
  readonly logDir?: string;
  /** Tells the owner (`{text}`) and the lead (`{text}`) about a new incident. */
  readonly notifyArgv?: readonly string[];
  readonly leadArgv?: readonly string[];
  /** The harness CLI argv prefix for `backlog add` (for example env DORI_HOME=… bun …/src/cli.ts). */
  readonly harness?: readonly string[];
  readonly noise?: readonly string[];
};

/** A first look reads only the last part of a long log: years of old noise are not today's fault. */
const FIRST_LOOK = 200_000;
const MAX_REPORTS_PER_RUN = 3;
const STALE_MS = 2 * 86_400_000;

const readFrom = (path: string, offset: number): { text: string; size: number } => {
  const size = statSync(path).size;
  const start = offset > size ? 0 : offset;
  if (size === start) return { text: "", size };
  const buf = Buffer.alloc(size - start);
  const fd = openSync(path, "r");
  readSync(fd, buf, 0, buf.length, start);
  closeSync(fd);
  return { text: buf.toString("utf8"), size };
};

const incidents: Command = async ({ values, config }) => {
  const cfg = (config as { incidents?: IncidentsConfig }).incidents ?? {};
  const logDir = cfg.logDir ?? join(dirname(config.stateDir), "logs");
  const statePath = join(config.stateDir, "incidents.json");
  let state: IncidentState = existsSync(statePath)
    ? JSON.parse(readFileSync(statePath, "utf8"))
    : { offsets: {}, seen: {} };
  const at = new Date().toISOString();
  for (const f of existsSync(logDir) ? readdirSync(logDir).filter((n) => n.endsWith(".log")) : []) {
    const path = join(logDir, f);
    const known = state.offsets[path];
    const st = statSync(path);
    // On a first look a log untouched for two days holds history, not a fault happening now: start at its end.
    const firstAt = Date.now() - st.mtimeMs > STALE_MS ? st.size : Math.max(0, st.size - FIRST_LOOK);
    const { text, size } = readFrom(path, known ?? firstAt);
    state = { ...scanText(state, f, text, at, cfg.noise), offsets: { ...state.offsets, [path]: size } };
  }
  const due = dueIncidents(state, cfg.threshold ?? 3);
  for (const sig of due)
    console.log(
      `INCIDENT ${incidentKey(sig)} ${state.seen[sig]?.count}x ${state.seen[sig]?.file} ${JSON.stringify(sig)}`,
    );
  if (values["report"] === true && due.length > 0) {
    const repo = cfg.repo ?? die("no incidents.repo configured");
    const briefs = join(config.stateDir, "incidents");
    mkdirSync(briefs, { recursive: true });
    for (const sig of due.slice(0, MAX_REPORTS_PER_RUN)) {
      const seen = state.seen[sig];
      if (!seen) continue;
      const key = incidentKey(sig);
      const body = issueBody(sig, seen);
      const r = await run(
        ["gh", "issue", "create", "-R", repo, "--title", issueTitle(sig), "--body", body, "--label", "auto-incident"],
        { timeoutMs: 60_000 },
      );
      if (r.code !== 0) {
        console.log(`INCIDENT_REPORT_FAILED ${key} ${r.err.slice(0, 160)}`);
        continue;
      }
      const url = r.out.trim().split("\n").pop() ?? "";
      state = { ...state, seen: { ...state.seen, [sig]: { ...seen, issue: url } } };
      const brief = join(briefs, `${key}.md`);
      writeFileSync(brief, `# ${key}: ${issueTitle(sig)}\n\n이슈: ${url}\n\n${body}\n`);
      if (cfg.harness?.length)
        await run(
          [...cfg.harness, "backlog", "add", key, "--brief", brief, "--title", issueTitle(sig), "--priority", "3"],
          { timeoutMs: 60_000 },
        );
      const text = `🚨 [고장 신고] ${seen.file}에서 같은 고장이 ${seen.count}번 났다:\n${sig.slice(0, 160)}\n이슈: ${url}\n고칠까? 지브가 "ㅇㅇ"하면 리드가 레인을 열어 고친다 (${key}).`;
      for (const argv of [cfg.notifyArgv, cfg.leadArgv])
        if (argv?.length) await run(fill(argv, { text }), { timeoutMs: 60_000 });
      console.log(`INCIDENT_REPORTED ${key} ${url}`);
    }
  }
  writeFileSync(statePath, JSON.stringify(state, null, 2));
};

export const incidentsCommands: Readonly<Record<string, Command>> = { incidents };
