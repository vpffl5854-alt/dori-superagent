import { describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { dutyTick } from "../src/duty.ts";
import { flushInbox } from "../src/inbox.ts";
import { inboxList, releaseHeld } from "../src/inbox-held.ts";
import type { SessionRef } from "../src/runtime/types.ts";
import { terminal } from "./fake-hc.ts";
import { World, href } from "./fake.ts";

const NEW: SessionRef = { runtime: "hc", id: "t7" };
const OLD = href("w1:p3");
const m = (text: string, at = 1) => ({ at, from: "cli", text });

/** A herdr pane whose session moved to hc:t7: its old inbox carries a .forward marker naming the new ref. */
function setup(state: "idle" | "working" = "idle") {
  const w = new World();
  const d = w.deps();
  w.hc.terminals.set("t7", state === "idle" ? terminal() : terminal({ status: { state: "working", app: "omo" } }));
  const old = d.store.inboxPath(OLD);
  writeFileSync(`${old}.forward`, "hc:t7\n");
  /** What an older binary still does: append to the old file, knowing nothing of the marker. */
  const oldWriter = (msg: ReturnType<typeof m>) => appendFileSync(old, `${JSON.stringify(msg)}\n`);
  return { w, d, old, oldWriter };
}

describe("a forwarded inbox (.forward marker)", () => {
  test("new messages for the old ref go to the new inbox; old-path entries are merged by the next flush, once", async () => {
    const { w, d, old, oldWriter } = setup();
    d.store.enqueue(OLD, m("via new binary", 2));
    expect(d.store.queued(NEW).map((x) => x.text)).toEqual(["via new binary"]);
    oldWriter(m("via old binary", 1));
    expect(await flushInbox(d, NEW)).toBe("delivered");
    expect(w.hc.sent).toHaveLength(1);
    expect(w.hc.sent[0]!.text).toContain("via new binary");
    expect(w.hc.sent[0]!.text).toContain("via old binary");
    expect(d.store.queued(NEW)).toEqual([]);
    expect(d.store.queued(OLD)).toEqual([]);
    expect(existsSync(`${old}.forward`)).toBe(true);
    expect(await flushInbox(d, NEW)).toBe("delivered");
    expect(w.hc.sent).toHaveLength(1);
  });

  test("an entry already merged by a merge cut short is not added twice", async () => {
    const { d, old, oldWriter } = setup("working");
    d.store.saveInbox(NEW, [m("first", 1)]);
    oldWriter(m("first", 1));
    oldWriter(m("second", 2));
    writeFileSync(`${old}.merging`, `${JSON.stringify(m("first", 1))}\n`);
    expect(await flushInbox(d, NEW)).toBe("queued");
    expect(d.store.queued(NEW).map((x) => x.text)).toEqual(["first", "second"]);
    expect(existsSync(`${old}.merging`)).toBe(false);
  });

  test("inbox list <old ref> shows the moved entries plus those still at the old path, merged once", () => {
    const { d, old, oldWriter } = setup("working");
    d.store.saveInbox(NEW, [m("moved", 1)]);
    oldWriter(m("late", 2));
    const listed = inboxList(d, "w1:p3");
    expect(listed.paneId).toBe("hc:t7");
    expect(listed.entries.map((e) => e.preview)).toEqual(['"moved"', '"late"']);
    expect(d.store.queued(OLD)).toEqual([]);
    expect(existsSync(`${old}.forward`)).toBe(true);
    expect(inboxList(d, "w1:p3").entries).toHaveLength(2);
  });

  test("inbox ack and resend <old ref> <n> act on the moved held entries", () => {
    const { d, oldWriter } = setup("working");
    const held = { at: 3, state: "ambiguous" as const, detail: "timeout" };
    d.store.saveInbox(NEW, [{ ...m("held-a", 1), attempt: held }]);
    oldWriter({ ...m("held-b", 2), attempt: held } as ReturnType<typeof m>);
    expect(releaseHeld(d, "w1:p3", 1, "ack")).toBe("hc:t7");
    expect(d.store.queued(NEW).map((x) => x.text)).toEqual(["held-b"]);
    expect(releaseHeld(d, "w1:p3", 1, "resend")).toBe("hc:t7");
    expect(d.store.queued(NEW)).toEqual([m("held-b", 2)]);
    expect(d.store.queued(OLD)).toEqual([]);
  });

  test("the duty pass counts kept and held entries where they live now, not at the old path", async () => {
    const { w, d, oldWriter } = setup();
    w.hc.terminals.set(
      "t7",
      terminal({ status: null, reported: false, foreground: { name: "-bash", argv: ["-bash"], pid: 7 } }),
    );
    d.store.saveInbox(NEW, [{ ...m("held", 1), attempt: { at: 3, state: "ambiguous", detail: "timeout" } }]);
    oldWriter(m("waiting", 2));
    const events = await dutyTick(d);
    expect(events).toContainEqual({
      pane: "w1:p3",
      action: "inbox-held",
      detail: "no agent in front; 2 message(s) kept",
    });
    expect(events).toContainEqual({
      pane: "w1:p3",
      action: "delivery-ambiguous",
      detail: "1 message(s) held, not resent",
    });
    expect(w.hc.sent).toEqual([]);
  });

  test("the duty pass finds the old file and flushes it at the new ref", async () => {
    const { w, d, oldWriter } = setup();
    oldWriter(m("left behind"));
    await dutyTick(d);
    expect(w.hc.sent.map((x) => x.text)).toEqual(["left behind"]);
    expect(d.store.inboxPanes()).toEqual([]);
  });
});
