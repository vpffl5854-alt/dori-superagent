import { describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { main } from "../src/cli.ts";
import { flushInbox } from "../src/inbox.ts";
import { dropQueued } from "../src/inbox-held.ts";
import type { SessionRef } from "../src/runtime/types.ts";
import { terminal } from "./fake-hc.ts";
import { World, href } from "./fake.ts";
import { captureIo, setup } from "./inbox-setup.ts";

const P = href("w1:p2");
const q = (text: string, at: number) => ({ at, from: "cli", text });
const held = { at: 3, state: "ambiguous" as const, detail: "timeout" };

describe("dori inbox drop: throwing away a queued entry that must never be delivered", () => {
  test("drop takes one queued entry out and leaves the rest in order", () => {
    const s = setup();
    s.d.store.saveInbox(P, [q("one", 1), q("two", 2), q("three", 3)]);
    expect(dropQueued(s.d, "w1:p2", 2, false)).toEqual({ paneId: "w1:p2", dropped: 1 });
    expect(s.d.store.queued(P).map((m) => m.text)).toEqual(["one", "three"]);
    expect(dropQueued(s.d, "w1:p2", 1, false)).toEqual({ paneId: "w1:p2", dropped: 1 });
    expect(s.d.store.queued(P).map((m) => m.text)).toEqual(["three"]);
  });

  test("a held entry is refused and nothing changes: it may have reached the pane, so ack settles it", () => {
    const s = setup();
    s.d.store.saveInbox(P, [{ ...q("held", 1), attempt: held }, q("plain", 2)]);
    expect(() => dropQueued(s.d, "w1:p2", 1, false)).toThrow(/held.*dori inbox ack/);
    expect(s.d.store.queued(P).map((m) => m.text)).toEqual(["held", "plain"]);
  });

  test("a typed entry is refused and nothing changes: it is in the pane's input already", () => {
    const s = setup();
    s.d.store.saveInbox(P, [{ ...q("typed", 1), attempt: { at: 2, state: "typed" as const } }, q("plain", 2)]);
    expect(() => dropQueued(s.d, "w1:p2", 1, false)).toThrow(/typed into the pane/);
    expect(s.d.store.queued(P).map((m) => m.text)).toEqual(["typed", "plain"]);
  });

  test("an index that is not in the inbox is refused, and so is one that is not a number", () => {
    const s = setup();
    s.d.store.saveInbox(P, [q("only", 1)]);
    expect(() => dropQueued(s.d, "w1:p2", 2, false)).toThrow(/no entry 2/);
    expect(() => dropQueued(s.d, "w1:p2", Number.NaN, false)).toThrow(/no entry NaN/);
    expect(s.d.store.queued(P).map((m) => m.text)).toEqual(["only"]);
  });

  test("a flush holding the inbox lock makes drop refuse without touching the inbox", async () => {
    const s = setup();
    s.d.store.saveInbox(P, [q("one", 1)]);
    const release = s.d.store.lockInbox(P, s.w.clock)!;
    expect(() => dropQueued(s.d, "w1:p2", 1, false)).toThrow(/being flushed/);
    expect(() => dropQueued(s.d, "w1:p2", Number.NaN, true)).toThrow(/being flushed/);
    expect(s.d.store.queued(P).map((m) => m.text)).toEqual(["one"]);
    release();
  });

  test("--all drops every queued entry and keeps held and typed ones", () => {
    const s = setup();
    s.d.store.saveInbox(P, [
      { ...q("held", 1), attempt: held },
      q("plain-a", 2),
      { ...q("typed", 3), attempt: { at: 4, state: "typed" as const } },
      q("plain-b", 5),
    ]);
    expect(dropQueued(s.d, "w1:p2", Number.NaN, true)).toEqual({ paneId: "w1:p2", dropped: 2 });
    expect(s.d.store.queued(P).map((m) => m.text)).toEqual(["held", "typed"]);
    expect(() => dropQueued(s.d, "w1:p2", Number.NaN, true)).toThrow(/no queued entry/);
    expect(s.d.store.queued(P).map((m) => m.text)).toEqual(["held", "typed"]);
  });
});

describe("dori inbox drop on a forwarded inbox", () => {
  const NEW: SessionRef = { runtime: "hc", id: "t7" };
  const OLD = href("w1:p3");
  const m = (text: string, at: number) => ({ at, from: "cli", text });

  function forwarded() {
    const w = new World();
    const d = w.deps();
    w.hc.terminals.set("t7", terminal());
    const old = d.store.inboxPath(OLD);
    writeFileSync(`${old}.forward`, "hc:t7\n");
    /** What an older binary still does: append at the old path, knowing nothing of the marker. */
    const oldWriter = (msg: object) => appendFileSync(old, `${JSON.stringify(msg)}\n`);
    return { w, d, old, oldWriter };
  }

  test("the index is read where the entries live: the old path is merged, then the merged entry is dropped", () => {
    const { d, old, oldWriter } = forwarded();
    d.store.saveInbox(NEW, [m("moved", 1)]);
    oldWriter(m("late", 2));
    expect(dropQueued(d, "w1:p3", 2, false)).toEqual({ paneId: "hc:t7", dropped: 1 });
    expect(d.store.queued(NEW).map((x) => x.text)).toEqual(["moved"]);
    expect(d.store.queued(OLD)).toEqual([]);
    expect(existsSync(`${old}.forward`)).toBe(true);
  });
});

describe("dori inbox drop on the command line", () => {
  test("prints DROPPED, and the dropped entry is never delivered", async () => {
    const s = setup();
    s.d.store.saveInbox(P, [q("stale", 1), q("keep", 2)]);
    const r = await captureIo(() => main(["inbox", "drop", "w1:p2", "1"], s.d));
    expect(r).toEqual({ code: 0, out: "DROPPED w1:p2 1" });
    expect(await flushInbox(s.d, P)).toBe("delivered");
    expect(s.pane.received).toEqual(["keep"]);
  });

  test("--all prints the count, and an index together with --all is refused", async () => {
    const s = setup();
    s.d.store.saveInbox(P, [q("a", 1), { ...q("held", 2), attempt: held }, q("b", 3)]);
    const r = await captureIo(() => main(["inbox", "drop", "w1:p2", "--all"], s.d));
    expect(r).toEqual({ code: 0, out: "DROPPED w1:p2 2 queued entries" });
    expect(s.d.store.queued(P).map((m) => m.text)).toEqual(["held"]);
    await expect(main(["inbox", "drop", "w1:p2", "2", "--all"], s.d)).rejects.toThrow(/not both/);
  });

  test("a dropped entry of a role target acts on that role's pane", async () => {
    const s = setup();
    s.d.store.setRole("duty", P);
    s.d.store.saveInbox(P, [q("stale", 1), q("keep", 2)]);
    const r = await captureIo(() => main(["inbox", "drop", "duty", "1"], s.d));
    expect(r).toEqual({ code: 0, out: "DROPPED w1:p2 1" });
    expect(s.d.store.queued(P).map((m) => m.text)).toEqual(["keep"]);
  });
});
