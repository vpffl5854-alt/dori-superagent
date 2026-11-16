import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { migrate } from "../src/migrate.ts";
import { refText } from "../src/refs.ts";
import { readJournal, writeJournal } from "../src/store-journal.ts";
import { href } from "./fake.ts";
import { migrateWorld, OLD } from "./migrate-setup.ts";

/** migrateWorld plus duty (w1:p2), the duty loop (w1:p4) and the hourly loop (w1:p5), all on herdr. */
function rolesWorld() {
  const m = migrateWorld();
  m.w.addPane("w1:p2", "idle");
  m.w.addPane("w1:p4", "shell");
  m.w.addPane("w1:p5", "shell");
  m.d.store.setRole("duty", href("w1:p2"));
  m.d.store.setRole("duty-loop", href("w1:p4"));
  m.d.store.setRole("hourly-loop", href("w1:p5"));
  const order = () =>
    m.w.calls.flatMap((c) =>
      c.cmd === "hc" && c.argv[1] === "run"
        ? [`open ${c.argv.find((a) => a.startsWith("dori.role="))}`]
        : c.cmd === "herdr" && c.argv[1] === "close"
          ? [`close ${c.argv[2]}`]
          : [],
    );
  return { ...m, order };
}

describe("dori migrate: roles and loops", () => {
  test("duty-loop: the old loop is closed before the new one opens", async () => {
    const { d, lines, opts, order } = rolesWorld();
    expect(await migrate(d, { role: "duty-loop" }, opts())).toBe(0);
    expect(order()).toEqual(["close w1:p4", "open dori.role=duty-loop"]);
    expect(lines).toEqual(["MIGRATED duty-loop w1:p4 -> hc:t1"]);
    expect(refText(d.store.roles()["duty-loop"]!)).toBe("hc:t1");
    expect(readJournal(d.store.root, "duty-loop")).toBeUndefined();
  });

  test("hourly-loop: the new loop opens before the old one is closed", async () => {
    const { w, d, opts, order } = rolesWorld();
    expect(await migrate(d, { role: "hourly-loop" }, opts())).toBe(0);
    expect(order()).toEqual(["open dori.role=hourly-loop", "close w1:p5"]);
    expect(w.hc.sent[0]!.text).toBe("dori loop");
  });

  test("lead: handoff from its prompt file, roles.json switched, its inbox moved", async () => {
    const { w, d, lines, opts } = rolesWorld();
    d.store.saveInbox(href("w1:p1"), [{ at: 1, from: "k", text: "[REPORT k] hi" }]);
    expect(await migrate(d, { role: "lead" }, opts())).toBe(0);
    expect(lines).toEqual(["MIGRATED lead w1:p1 -> hc:t1"]);
    expect(refText(d.store.roles().lead!)).toBe("hc:t1");
    const start = w.hc.sent[0]!.text;
    expect(start).toStartWith("omo --append-system-prompt ");
    const brief = start.split(" ").at(-1)!.replaceAll("'", "");
    expect(readFileSync(brief, "utf8")).toContain("## Handoff");
    expect(d.store.queued({ runtime: "hc", id: "t1" }).map((m) => m.text)).toEqual(["[REPORT k] hi"]);
  });

  test("--all: lanes first, then lead and duty, the loops last", async () => {
    const { d, lines, opts } = rolesWorld();
    expect(await migrate(d, { all: true }, opts())).toBe(0);
    expect(lines.map((l) => l.split(" ").slice(0, 2).join(" "))).toEqual([
      "MIGRATED k",
      "MIGRATED lead",
      "MIGRATED duty",
      "MIGRATED duty-loop",
      "MIGRATED hourly-loop",
    ]);
  });
});

describe("dori migrate --resume and refusals", () => {
  test("--resume is refused when no session path is recorded", async () => {
    const { w, d, opts } = migrateWorld();
    await expect(migrate(d, { lane: "k" }, opts({ resume: true }))).rejects.toThrow(/no recorded session path/);
    expect(readJournal(d.store.root, "k")).toBeUndefined();
    expect(w.hc.terminals.size).toBe(0);
  });

  test("--resume is refused on a working source, never retried as a resume", async () => {
    const { w, d, opts } = migrateWorld("working");
    d.store.saveLane({ ...d.store.lane("k")!, sessionPath: "/s/k.jsonl" });
    await expect(migrate(d, { lane: "k" }, opts({ resume: true }))).rejects.toThrow(/is working/);
    expect(w.panes.get("w1:p3")!.received).toEqual([]);
    expect(w.hc.terminals.size).toBe(0);
  });

  test("--resume on an idle source opens the agent on its recorded session, no checkpoint ask", async () => {
    const { w, d, lines, opts } = migrateWorld();
    d.store.saveLane({ ...d.store.lane("k")!, sessionPath: "/s/k.jsonl" });
    expect(await migrate(d, { lane: "k" }, opts({ resume: true }))).toBe(0);
    expect(w.hc.sent[0]!.text).toBe("omo --session '/s/k.jsonl'");
    expect(w.panes.get("w1:p3")).toBeUndefined();
    expect(lines).toEqual(["MIGRATED k w1:p3 -> hc:t1"]);
  });

  test("a migration already running for the name is refused", async () => {
    const { d, opts } = migrateWorld();
    mkdirSync(join(d.store.root, "migrate"), { recursive: true });
    writeFileSync(
      join(d.store.root, "migrate", "k.lock"),
      JSON.stringify({ pid: process.pid, host: hostname(), at: 1 }),
    );
    await expect(migrate(d, { lane: "k" }, opts())).rejects.toThrow(/another dori migrate of k is running/);
  });

  test("a journal toward another runtime is refused, not overwritten", async () => {
    const { d, opts } = migrateWorld();
    writeJournal(d.store.root, { name: "k", kind: "lane", phase: "hold", from: OLD, to: "herdr", at: 1 });
    await expect(migrate(d, { lane: "k" }, opts())).rejects.toThrow(/in progress toward herdr/);
    expect(readJournal(d.store.root, "k")!.to).toBe("herdr");
  });
});
