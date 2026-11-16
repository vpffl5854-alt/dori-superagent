import { describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dutyTick } from "../src/duty.ts";
import { flushInbox } from "../src/inbox.ts";
import { migrate } from "../src/migrate.ts";
import { readJournal, writeJournal } from "../src/store-journal.ts";
import { migrateWorld, msg, NEW, OLD, snapshot } from "./migrate-setup.ts";

const HELD = { at: 5, state: "ambiguous" as const, detail: "timeout" };

describe("dori migrate: one lane herdr -> hc", () => {
  test("happy: MIGRATED, checkpoint asked, handoff brief, queued stay queued, held stays held, old closed", async () => {
    const { w, d, lines, opts } = migrateWorld();
    d.store.saveInbox(OLD, [msg("one", 1), msg("two", 2), msg("held", 3, HELD)]);
    expect(await migrate(d, { lane: "k" }, opts())).toBe(0);
    expect(lines).toEqual(["MIGRATED k w1:p3 -> hc:t1"]);
    expect(w.panes.get("w1:p1")).toBeDefined();
    expect(w.panes.has("w1:p3")).toBe(false);
    const lane = d.store.lane("k")!;
    expect(lane.sessionRef.id).toBe("t1");
    expect(lane.migratedFrom).toEqual([OLD]);
    expect(lane.migration).toBeUndefined();
    expect(readJournal(d.store.root, "k")).toBeUndefined();
    const q = d.store.queued(NEW);
    expect(q.map((m) => [m.text, m.attempt?.state])).toEqual([
      ["one", undefined],
      ["two", undefined],
      ["held", "ambiguous"],
    ]);
    expect(existsSync(d.store.inboxPath(OLD))).toBe(false);
    expect(existsSync(`${d.store.inboxPath(OLD)}.forward`)).toBe(false);
    const start = w.hc.sent[0]!.text;
    const handoff = /Read your brief at (\S+) and execute it/.exec(start)![1]!;
    const text = readFileSync(handoff, "utf8");
    expect(text).toStartWith("Fix the flaky login test.");
    expect(text).toContain("## Handoff");
    expect(text).toContain("screen line 2");
    expect(text).toContain("may already have reached the previous session; see dori inbox list");
    expect(text.match(/## Lane rules/g)).toHaveLength(1);
    expect(w.hc.terminals.get("t1")!.labels["dori.lane"]).toBe("k");
    expect(await flushInbox(d, NEW)).toBe("delivered");
    expect(w.hc.sent.at(-1)!.text).toContain("one");
    expect(w.hc.sent.at(-1)!.text).not.toContain("held");
    expect(d.store.queued(NEW).map((m) => m.text)).toEqual(["held"]);
  });

  test("the checkpoint ask goes to the old pane with the fixed text", async () => {
    const { w, d, opts } = migrateWorld();
    await migrate(d, { lane: "k" }, opts());
    const asks = w.calls.filter((c) => c.argv[0] === "agent" && c.argv[1] === "prompt").map((c) => String(c.argv[3]));
    expect(asks).toEqual([
      `[MIGRATE k] write a handoff checkpoint now (goal, open todos, last state) to ${join(d.store.root, "briefs", "k.handoff.md")}, then stop`,
    ]);
  });

  test("a typed entry is held on the new session (its input is gone); never delivered automatically", async () => {
    const { d, opts } = migrateWorld();
    d.store.saveInbox(OLD, [msg("typed", 1, { at: 2, state: "typed", agent: "pi", pgid: 101 })]);
    await migrate(d, { lane: "k" }, opts());
    expect(d.store.queued(NEW).map((m) => m.attempt?.state)).toEqual(["ambiguous"]);
    expect(await flushInbox(d, NEW)).toBe("held");
  });

  test("rollback: the new probe never leaves unknown -> MIGRATE_ROLLBACK, old lane untouched, no journal", async () => {
    const { w, d, lines, state, opts } = migrateWorld();
    state.newSilent = true;
    d.store.saveInbox(OLD, [msg("one", 1)]);
    const before = readFileSync(join(d.store.root, "lanes", "k.json"), "utf8");
    expect(await migrate(d, { lane: "k" }, opts())).toBe(3);
    expect(lines).toEqual(["MIGRATE_ROLLBACK k hc:t1 never reached idle or working within 3 min (last: unknown)"]);
    expect(readFileSync(join(d.store.root, "lanes", "k.json"), "utf8")).toBe(before);
    expect(readJournal(d.store.root, "k")).toBeUndefined();
    expect(w.hc.terminals.has("t1")).toBe(false);
    expect(w.panes.has("w1:p3")).toBe(true);
    expect(d.store.queued(OLD).map((m) => m.text)).toEqual(["one"]);
  });

  test.each(["hold", "opened", "switched"] as const)("resumes from a journal in phase %s", async (phase) => {
    const { w, d, lines, opts } = migrateWorld();
    const lane = d.store.lane("k")!;
    d.store.saveLane({ ...lane, migration: true });
    const briefPath = join(d.store.root, "briefs", "k.migrate-1.md");
    writeFileSync(briefPath, "handoff");
    if (phase !== "hold") w.hc.terminals.set("t9", fakeTerminal());
    const newRef = { runtime: "hc" as const, id: "t9" };
    if (phase === "switched") d.store.saveLane({ ...lane, migration: true, sessionRef: newRef, migratedFrom: [OLD] });
    writeJournal(d.store.root, {
      name: "k",
      kind: "lane",
      phase,
      from: OLD,
      to: "hc",
      at: 1,
      briefPath,
      ...(phase === "hold" ? {} : { newRef }),
    });
    expect(await migrate(d, { lane: "k" }, opts())).toBe(0);
    const want = phase === "hold" ? "hc:t1" : "hc:t9";
    expect(lines).toEqual([`MIGRATED k w1:p3 -> ${want}`]);
    expect(d.store.lane("k")!.sessionRef.id).toBe(want.slice(3));
    expect(d.store.lane("k")!.migratedFrom).toEqual([OLD]);
    expect(w.panes.has("w1:p3")).toBe(false);
    expect(readJournal(d.store.root, "k")).toBeUndefined();
    const asks = w.calls.filter((c) => c.argv[0] === "agent" && c.argv[1] === "prompt");
    expect(asks).toHaveLength(0);
  });

  test("a sender appending to the old inbox after the switch is merged into the new one, once", async () => {
    const { w, d, opts } = migrateWorld();
    const real = w.exec;
    w.exec = async (cmd, argv) => {
      if (cmd === "herdr" && argv[0] === "pane" && argv[1] === "close")
        appendFileSync(d.store.inboxPath(OLD), `${JSON.stringify(msg("late", 9))}\n`);
      return real(cmd, argv);
    };
    expect(await migrate(d, { lane: "k" }, opts())).toBe(0);
    expect(d.store.queued(NEW).map((m) => m.text)).toEqual(["late"]);
    expect(existsSync(d.store.inboxPath(OLD))).toBe(false);
  });

  test("a crash between the inbox move and the switch: the re-run merges again without duplicates", async () => {
    const { w, d, opts } = migrateWorld();
    w.hc.terminals.set("t9", fakeTerminal());
    const newRef = { runtime: "hc" as const, id: "t9" };
    d.store.saveLane({ ...d.store.lane("k")!, migration: true });
    d.store.saveInbox(newRef, [msg("one", 1), msg("held", 3, HELD)]);
    d.store.saveInbox(OLD, [msg("one", 1), msg("held", 3, HELD), msg("two", 4)]);
    writeFileSync(`${d.store.inboxPath(OLD)}.forward`, "hc:t9\n");
    writeJournal(d.store.root, { name: "k", kind: "lane", phase: "opened", from: OLD, to: "hc", at: 1, newRef });
    expect(await migrate(d, { lane: "k" }, opts())).toBe(0);
    expect(d.store.queued(newRef).map((m) => m.text)).toEqual(["one", "held", "two"]);
    expect(d.store.queued(newRef)[1]!.attempt?.state).toBe("ambiguous");
  });

  test("--dry-run prints the plan and writes nothing", async () => {
    const { w, d, lines, opts } = migrateWorld();
    d.store.saveInbox(OLD, [msg("one", 1)]);
    const before = snapshot(d.store.root);
    expect(await migrate(d, { lane: "k" }, opts({ dryRun: true }))).toBe(0);
    expect(lines).toEqual(["PLAN k w1:p3 -> hc (inbox entries: 1)"]);
    expect(snapshot(d.store.root)).toEqual(before);
    expect(w.calls.filter((c) => c.cmd === "hc" || c.argv[0] === "agent")).toEqual([]);
  });

  test("SKIP when the lane is already on the target", async () => {
    const { d, lines, opts } = migrateWorld();
    expect(await migrate(d, { lane: "k" }, opts({ to: "herdr" }))).toBe(0);
    expect(lines).toEqual(["SKIP k already on herdr"]);
  });

  test("DEFERRED when the lane keeps working past the wait: journal gone, nothing else changed", async () => {
    const { w, d, lines, opts } = migrateWorld("working");
    const before = readFileSync(join(d.store.root, "lanes", "k.json"), "utf8");
    expect(await migrate(d, { lane: "k" }, opts({ waitMinutes: 1 }))).toBe(0);
    expect(lines).toEqual(["DEFERRED k working past 1 min"]);
    expect(readFileSync(join(d.store.root, "lanes", "k.json"), "utf8")).toBe(before);
    expect(readJournal(d.store.root, "k")).toBeUndefined();
    expect(w.hc.terminals.size).toBe(0);
    expect(w.panes.get("w1:p3")!.received).toHaveLength(1);
  });

  test("DEFERRED blocked: nothing is delivered to a blocked agent", async () => {
    const { w, d, lines, opts } = migrateWorld("blocked");
    expect(await migrate(d, { lane: "k" }, opts())).toBe(0);
    expect(lines).toEqual(["DEFERRED k blocked"]);
    expect(w.panes.get("w1:p3")!.received).toEqual([]);
    expect(d.store.lane("k")!.migration).toBeUndefined();
    expect(readJournal(d.store.root, "k")).toBeUndefined();
  });

  test("dutyTick leaves a migrating lane's record untouched and holds its inbox", async () => {
    const { w, d } = migrateWorld();
    w.clock += 60 * 60_000;
    d.store.saveLane({ ...d.store.lane("k")!, migration: true });
    writeJournal(d.store.root, { name: "k", kind: "lane", phase: "hold", from: OLD, to: "hc", at: 1 });
    d.store.saveInbox(OLD, [msg("wait", 1)]);
    const before = readFileSync(join(d.store.root, "lanes", "k.json"), "utf8");
    await dutyTick(d);
    expect(readFileSync(join(d.store.root, "lanes", "k.json"), "utf8")).toBe(before);
    expect(w.panes.get("w1:p3")!.received).toEqual([]);
    expect(d.store.queued(OLD).map((m) => m.text)).toEqual(["wait"]);
  });
});

function fakeTerminal() {
  return {
    state: "live" as const,
    pid: 900,
    status: { state: "idle", app: "omo" },
    reported: true,
    turn: 1,
    foreground: { name: "omo", argv: ["omo"], pid: 4242 },
    labels: { "dori.lane": "k" },
  };
}
