import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { type Lane, statusOf } from "./registry.ts";
import type { ProgressState } from "./reports.ts";

export type Monitor = {
  readonly monitorId?: string;
  readonly sessionId?: string;
  readonly persistent?: boolean;
  readonly suspended?: boolean;
  /** Epoch ms after which the runtime ends the watch on its own. */
  readonly expiresAt?: number;
  readonly deliveryPaused?: boolean;
  readonly description?: string;
  readonly command?: string;
  readonly path?: string;
  readonly target?: string;
};
export type Manifest = {
  readonly path: string;
  readonly data: { readonly version: number; readonly sessionId: string; readonly monitors: readonly Monitor[] };
};
export type BootLane = Lane & { readonly reportState?: ProgressState | undefined };
export type Cleanup = {
  readonly monitorId: string;
  readonly sessionId: string;
  readonly metadata: string;
  readonly lanes: readonly string[];
  readonly match: readonly string[];
  readonly suspended: boolean;
  readonly deliveryPaused: boolean;
  readonly expiresAt?: number;
  readonly stop: string;
};
// The one definition of a finished lane, shared by the VANISHED filter and the cleanup check.
export const finished = (lane: BootLane): boolean =>
  ["closed", "verified-done"].includes(statusOf(lane)) || lane.reportState === "done";

// Loose: any mention of a name, prose and paths included. Used only to keep a watch that might belong to an open lane.
// A colon or a period next to the name is punctuation ("lane:api-release", "api-release.") unless the period joins
// another name ("api.v2" is not "v2").
const mentions = (text: string, value: string | undefined): boolean => {
  if (!value) return false;
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![a-zA-Z0-9_-])(?<![a-zA-Z0-9_-]\\.)${escaped}(?![a-zA-Z0-9_-])(?!\\.[a-zA-Z0-9_-])`).test(
    text,
  );
};

// Strict: the evidence that ties a watch to a lane is the lane's pane id or its key as a whole argv token of the
// command or target. A description is prose and a path segment is not the lane ("build/docs/out.log" is not "docs").
const TIED_FIELDS = ["command", "target"] as const;
const tokens = (value: unknown): string[] =>
  typeof value === "string"
    ? value
        .split(/\s+/)
        .map((t) => t.replace(/^['"]+|['"]+$/g, ""))
        .filter(Boolean)
    : [];
const tiedBy = (monitor: Monitor, lane: Lane): string | null => {
  for (const field of TIED_FIELDS) {
    const words = tokens(monitor[field]);
    if (lane.pane && words.includes(lane.pane)) return `${lane.key}:${field}:pane`;
    if (words.includes(lane.key)) return `${lane.key}:${field}:key`;
  }
  return null;
};

export const monitorCleanup = (lanes: readonly BootLane[], manifests: readonly Manifest[]): Cleanup[] => {
  const cleanup: Cleanup[] = [];
  for (const { path, data } of manifests) {
    for (const monitor of data.monitors) {
      if (!monitor.persistent || !/^mon_[A-Za-z0-9]+$/.test(monitor.monitorId ?? "")) continue;
      if (monitor.sessionId !== data.sessionId) continue;
      const tied = lanes.flatMap((lane) => {
        const match = tiedBy(monitor, lane);
        return match ? [{ lane, match }] : [];
      });
      if (!tied.length || tied.some(({ lane }) => !finished(lane))) continue;
      // Any mention of an open lane anywhere in the watch keeps it.
      const text = [monitor.description, monitor.command, monitor.path, monitor.target]
        .filter((v) => typeof v === "string")
        .join("\n");
      if (lanes.some((lane) => !finished(lane) && (mentions(text, lane.key) || mentions(text, lane.pane)))) continue;
      const monitorId = monitor.monitorId ?? "";
      cleanup.push({
        monitorId,
        sessionId: data.sessionId,
        metadata: path,
        lanes: tied.map(({ lane }) => lane.key),
        match: tied.map(({ match }) => match),
        suspended: Boolean(monitor.suspended),
        deliveryPaused: monitor.deliveryPaused === true,
        ...(typeof monitor.expiresAt === "number" ? { expiresAt: monitor.expiresAt } : {}),
        stop: `kill_bash(${JSON.stringify({ bash_id: monitorId })})`,
      });
    }
  }
  return cleanup;
};

const entries = (dir: string) => {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
};

// One unreadable file is named in errors and skipped; the other sessions' metadata is still read.
export const readMonitorManifests = (
  sessionsDir: string,
  extraDirs: readonly string[] = [],
): { manifests: Manifest[]; errors: string[] } => {
  const dirs = new Set(extraDirs);
  const manifests: Manifest[] = [];
  const errors: string[] = [];
  try {
    for (const entry of entries(sessionsDir))
      if (entry.isDirectory()) dirs.add(join(sessionsDir, entry.name, "extensions", "terminal"));
  } catch {
    errors.push(sessionsDir);
  }
  for (const dir of [...dirs].sort()) {
    let files: ReturnType<typeof entries>;
    try {
      files = entries(dir);
    } catch {
      errors.push(dir);
      continue;
    }
    for (const entry of files) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const path = join(dir, entry.name);
      try {
        const data = JSON.parse(readFileSync(path, "utf8")) as Manifest["data"];
        if (data.version !== 1 || !Array.isArray(data.monitors) || typeof data.sessionId !== "string")
          throw new Error("invalid monitor metadata");
        // A null or non-object entry makes the whole file unreadable here, never a crash in the cleanup pass.
        if (!data.monitors.every((m: unknown) => typeof m === "object" && m !== null && !Array.isArray(m)))
          throw new Error("invalid monitor entry");
        manifests.push({ path, data });
      } catch {
        errors.push(path);
      }
    }
  }
  return { manifests, errors };
};
