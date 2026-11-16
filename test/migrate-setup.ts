import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MigrateOpts } from "../src/migrate-capture.ts";
import type { AgentStatus, SessionRef } from "../src/runtime/types.ts";
import type { Lane, QueuedMessage } from "../src/store-types.ts";
import { World, href } from "./fake.ts";

export const OLD = href("w1:p3");
export const FOOTER = "## Lane rules (added by dori for lane `k`)\n\nrules";
export const msg = (text: string, at: number, attempt?: QueuedMessage["attempt"]): QueuedMessage => ({
  at,
  from: "cli",
  text,
  ...(attempt ? { attempt } : {}),
});

/**
 * A herdr lane `k` in pane w1:p3 (the lead is w1:p1), selected runtime hc. `sleep` advances the fake clock and, unless
 * `state.newSilent`, marks every hc terminal that has not reported yet as an idle omo (the new agent came up).
 */
export function migrateWorld(status: AgentStatus = "idle") {
  const w = new World();
  const d = w.deps({ runtime: "hc" });
  w.addPane("w1:p1", "idle");
  d.store.setRole("lead", href("w1:p1"));
  const pane = w.addPane("w1:p3", status);
  pane.screen = "screen line 1\nscreen line 2\n";
  writeFileSync(d.store.briefPath("k"), `Fix the flaky login test.\n\n${FOOTER}\n`);
  const lane: Lane = {
    key: "k",
    sessionRef: OLD,
    paneId: OLD.id,
    tabId: "w1:t3",
    brief: d.store.briefPath("k"),
    cwd: "/w",
    status: "working",
    createdAt: 1,
    lastActivityAt: w.clock,
    nudges: 0,
    log: [{ at: 1, kind: "start", text: "brief.md" }],
  };
  d.store.saveLane(lane);
  const lines: string[] = [];
  const state = { newSilent: false, onSleep: (): void => {} };
  const opts = (over: Partial<MigrateOpts> = {}): MigrateOpts => ({
    to: "hc",
    dryRun: false,
    waitMinutes: 10,
    resume: false,
    sleep: async (ms) => {
      w.clock += ms;
      state.onSleep();
      if (state.newSilent) return;
      for (const t of w.hc.terminals.values()) if (t.status === null) t.status = { state: "idle", app: "omo" };
    },
    log: (l) => lines.push(l),
    ...over,
  });
  return { w, d, pane, lane, lines, state, opts };
}

export const NEW: SessionRef = { runtime: "hc", id: "t1" };

/** Every file under the home with its size and mtime: equal snapshots mean nothing was written. */
export function snapshot(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const f of readdirSync(dir).sort()) {
      const p = join(dir, f);
      const s = statSync(p);
      if (s.isDirectory()) walk(p);
      else out.push(`${p} ${s.size} ${s.mtimeMs} ${readFileSync(p, "utf8").length}`);
    }
  };
  walk(root);
  return out;
}
