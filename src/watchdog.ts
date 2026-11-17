import { cpSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Deps } from "./harness.ts";
import { tellLead } from "./inbox.ts";
import type { Lane } from "./store-types.ts";
import { budgetOverrun, findingText, repeatedScratch, type WatchdogFinding } from "./watchdog-rules.ts";

const BACKUP_FILE_LIMIT = 200;
const BACKUP_BYTES_LIMIT = 20 * 1024 * 1024;

export type WatchdogOutcome = { readonly finding: WatchdogFinding; readonly backup: string; readonly notice: string };

const stamp = (at: number): string => new Date(at).toISOString().replace(/[:.]/g, "-");

// `git status --porcelain -z` entries: "XY path", and a rename or copy names its source in the next entry.
const touched = (out: string): string[] => {
  const paths: string[] = [];
  const entries = out.split("\0");
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i] ?? "";
    if (entry.length < 4) continue;
    paths.push(entry.slice(3));
    if (entry[0] === "R" || entry[0] === "C" || entry[1] === "R" || entry[1] === "C") i++;
  }
  return paths;
};

// The brief and the files the lane made, copied out before its session is closed: the lead can read them afterwards.
export async function backupLane(d: Deps, lane: Lane, at: number): Promise<string> {
  const dir = join(d.store.root, "backups", `watchdog-${lane.key}-${stamp(at)}`);
  mkdirSync(dir, { recursive: true });
  if (existsSync(lane.brief)) cpSync(lane.brief, join(dir, basename(lane.brief)));
  const status = await d
    .exec("git", ["-C", lane.cwd, "status", "--porcelain=v1", "-z", "--untracked-files=normal"])
    .catch(() => ({
      code: 1,
      stdout: "",
      stderr: "",
    }));
  const paths = status.code === 0 ? touched(status.stdout) : [];
  const copied: string[] = [];
  let bytes = 0;
  for (const path of paths.slice(0, BACKUP_FILE_LIMIT)) {
    const from = join(lane.cwd, path);
    try {
      const size = statSync(from).size;
      if (bytes + size > BACKUP_BYTES_LIMIT) continue;
      const to = join(dir, "files", path);
      mkdirSync(join(to, ".."), { recursive: true });
      cpSync(from, to);
      bytes += size;
      copied.push(path);
    } catch {
      copied.push(`${path} (not copied: unreadable)`);
    }
  }
  writeFileSync(
    join(dir, "lane.json"),
    `${JSON.stringify({ lane, at: new Date(at).toISOString(), touched: paths, copied }, null, 2)}\n`,
  );
  return dir;
}

// The finding for a lane this tick, if any. A lane already closed by the watchdog is never a finding again.
export async function watchdogFinding(d: Deps, lane: Lane): Promise<WatchdogFinding | undefined> {
  if (lane.watchdog) return undefined;
  const over = budgetOverrun(lane, d.now());
  if (over) return over;
  // A screen that cannot be read is no evidence of a loop; the budget rule above still applies.
  const screen = await d.runtimes
    .for(lane.sessionRef)
    .read(lane.sessionRef, 200)
    .catch(() => "");
  const repeat = repeatedScratch(screen);
  return repeat ? { ...repeat, key: lane.key } : undefined;
}

// Closes the lane's session (hc: kill then rm; herdr: pane close), backs it up, and tells the lead once.
export async function tripWatchdog(d: Deps, lane: Lane, finding: WatchdogFinding): Promise<WatchdogOutcome> {
  const now = d.now();
  let note: string | undefined;
  try {
    await d.runtimes.for(lane.sessionRef).close(lane.sessionRef);
  } catch (e) {
    note = `판 종료 실패: ${e instanceof Error ? e.message : String(e)}`;
  }
  let backup = "";
  try {
    backup = await backupLane(d, lane, now);
  } catch (e) {
    note = `${note ? `${note}; ` : ""}백업 실패: ${e instanceof Error ? e.message : String(e)}`;
  }
  const notice = findingText(finding, `${note ? `${note}; ` : ""}백업 ${backup}`);
  lane.watchdog = { ...finding, at: now };
  lane.status = "lost";
  lane.log.push({ at: now, kind: "lost", text: notice });
  d.store.saveLane(lane);
  await tellLead(d, notice, "duty");
  return { finding, backup, notice };
}
