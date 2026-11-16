import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { World, href } from "./fake.ts";

export function setup(opts: { runtime?: "herdr" | "hc" } = {}) {
  const w = new World();
  const d = w.deps(opts);
  const lead = w.addPane("w1:p1", "idle");
  d.store.setRole("lead", href("w1:p1"));
  const brief = join(d.store.root, "brief.md");
  writeFileSync(brief, "Fix the flaky login test.");
  return { w, d, lead, brief };
}
