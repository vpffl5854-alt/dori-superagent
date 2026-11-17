import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { World, href } from "./fake.ts";

export function setup(opts: { runtime?: "herdr" | "hc" } = {}) {
  // The lane's own runtime is read from the caller's env: clear it so a test run inside a real pane does not change what
  // `setup` builds (a leaked HC_TERMINAL_ID made startLane think it ran inside a lane, 2026-11-18).
  delete process.env["HC_TERMINAL_ID"];
  delete process.env["HERDR_PANE_ID"];
  delete process.env["HERDR_WORKSPACE_ID"];
  const w = new World();
  const d = w.deps(opts);
  const lead = w.addPane("w1:p1", "idle");
  d.store.setRole("lead", href("w1:p1"));
  const brief = join(d.store.root, "brief.md");
  writeFileSync(brief, "Fix the flaky login test.");
  return { w, d, lead, brief };
}
