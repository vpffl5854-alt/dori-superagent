import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { sessionDirFor, sessionFileStart } from "./session-id.ts";

// omo keeps each session's goal in <session dir>/extensions/goal/<session id>.json as { version: 1, goal: { status } },
// the record its "Pursuing goal" footer is drawn from. The footer depends on the pane's width (a narrow pane cuts it to
// "Pur..."); the record does not. A session is the lane's when it was created by this launch and its first user message
// is the launch prompt naming the lane, so another lane started in the same cwd at the same time never counts.
const CLOCK_SLACK_MS = 5_000;

type Entry = { readonly type?: unknown; readonly message?: { readonly role?: unknown; readonly content?: unknown } };

const firstUserText = (jsonl: string): string => {
  for (const line of jsonl.split("\n")) {
    let entry: Entry;
    try {
      entry = JSON.parse(line) as Entry;
    } catch {
      continue; // a blank line, or the last line while omo is still writing it
    }
    if (entry?.type !== "message" || entry.message?.role !== "user") continue;
    const content = entry.message.content;
    if (typeof content === "string") return content;
    return Array.isArray(content)
      ? content.map((part: { text?: unknown }) => (typeof part?.text === "string" ? part.text : "")).join("\n")
      : "";
  }
  return "";
};

const readText = (path: string): string | undefined => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
};

/** True when the omo session this launch started for lane `key` in `cwd` holds an active goal. */
export const laneGoalActive = (sessionsDir: string, cwd: string, key: string, since: number): boolean => {
  const dir = sessionDirFor(sessionsDir, cwd);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return false; // no omo session store for this cwd: another agent, or omo has not written the session yet
  }
  const lane = `You are the ${key} lane`;
  for (const name of names) {
    const session = sessionFileStart(name);
    if (!session || session.at < since - CLOCK_SLACK_MS) continue;
    if (!firstUserText(readText(join(dir, name)) ?? "").includes(lane)) continue;
    const record = readText(join(dir, "extensions", "goal", `${encodeURIComponent(session.id)}.json`));
    if (record === undefined) return false;
    try {
      return (JSON.parse(record) as { goal?: { status?: unknown } | null }).goal?.status === "active";
    } catch {
      return false; // a record caught mid-write reads as no goal here; the next check reads it again
    }
  }
  return false;
};
