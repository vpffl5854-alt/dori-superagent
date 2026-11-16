import { describe, expect, test } from "bun:test";
import { main } from "../src/cli.ts";
import { dutyTick } from "../src/duty.ts";
import { captureIo, setup, typedEntry } from "./inbox-setup.ts";
import { href } from "./fake.ts";

// #108: follow-ups to #89 (PR 102).

describe("a typed entry whose pane's agent changed is held, never Entered (#108 1)", () => {
  test("the typed attempt records the agent name and foreground process group herdr reported", async () => {
    const s = setup();
    s.pane.agent = "omo";
    s.pane.pgid = 4242;
    await typedEntry(s);
    expect(s.d.store.queued(href("w1:p2"))[0]!.attempt).toMatchObject({ state: "typed", agent: "omo", pgid: 4242 });
  });

  test("the agent exits (no agent in the pane): held, the lead is told once, and no Enter when an agent comes back", async () => {
    const s = setup();
    await typedEntry(s);
    s.pane.status = "shell";
    expect(await dutyTick(s.d)).toContainEqual(
      expect.objectContaining({ pane: "w1:p2", action: "delivery-ambiguous" }),
    );
    expect(s.d.store.queued(href("w1:p2")).map((m) => m.attempt?.state)).toEqual(["ambiguous"]);

    s.pane.status = "idle";
    s.pane.pgid = 202;
    for (let i = 0; i < 2; i++) {
      expect(await dutyTick(s.d)).toContainEqual(
        expect.objectContaining({ pane: "w1:p2", action: "delivery-ambiguous" }),
      );
    }
    expect(s.count("w1:p2", "pane", "send-keys")).toBe(3);
    expect(s.count("w1:p2", "pane", "send-text")).toBe(1);
    expect(s.notices()).toHaveLength(1);
    expect(s.notices()[0]).not.toContain("SECRET");
    expect(s.notices()[0]).toContain("dori inbox resend w1:p2");
  });

  test("another agent process in front (foreground process group changed between ticks): held, no Enter, one notice", async () => {
    const s = setup();
    await typedEntry(s);
    s.pane.pgid = 777;
    expect(await dutyTick(s.d)).toContainEqual(
      expect.objectContaining({ pane: "w1:p2", action: "delivery-ambiguous" }),
    );
    await dutyTick(s.d);
    expect(s.count("w1:p2", "pane", "send-keys")).toBe(3);
    expect(s.d.store.queued(href("w1:p2")).map((m) => m.attempt?.state)).toEqual(["ambiguous"]);
    expect(s.notices()).toHaveLength(1);
  });

  test("another agent name in the pane: held, no Enter", async () => {
    const s = setup();
    await typedEntry(s);
    s.pane.agent = "claude";
    await dutyTick(s.d);
    expect(s.count("w1:p2", "pane", "send-keys")).toBe(3);
    expect(s.d.store.queued(href("w1:p2")).map((m) => m.attempt?.state)).toEqual(["ambiguous"]);
    expect(s.notices()).toHaveLength(1);
  });

  test("control: the same agent is still in front: only Enter is pressed and the entry is delivered", async () => {
    const s = setup();
    await typedEntry(s);
    expect(await dutyTick(s.d)).toEqual([{ pane: "w1:p2", action: "flushed" }]);
    expect(s.count("w1:p2", "pane", "send-keys")).toBe(4);
    expect(s.d.store.queued(href("w1:p2"))).toEqual([]);
    expect(s.notices()).toEqual([]);
  });
});

describe("releasing held entries: dori inbox list | ack | resend (#108 2)", () => {
  function heldInbox(s: ReturnType<typeof setup>) {
    const long = `SECRET "quoted"\n${"x".repeat(100)}`;
    s.d.store.saveInbox(href("w1:p2"), [
      { at: 0, from: "lane-a", text: long, attempt: { at: 1, state: "ambiguous", detail: "timeout" } },
      { at: 60_000, from: "cli", text: "typed one", attempt: { at: 60_001, state: "typed" } },
      { at: 120_000, from: "duty", text: "plain" },
    ]);
    return long;
  }

  test("list prints index, state, sender and queued time, and at most the first 60 characters JSON-escaped", async () => {
    const s = setup();
    const long = heldInbox(s);
    const r = await captureIo(() => main(["inbox", "list", "w1:p2"], s.d));
    expect(r.code).toBe(0);
    expect(r.out.split("\n")).toEqual([
      `1 held from lane-a queued 1970-01-01T00:00:00.000Z ${JSON.stringify(long.slice(0, 60))}...`,
      `2 typed from cli queued 1970-01-01T00:01:00.000Z "typed one"`,
      `3 queued from duty queued 1970-01-01T00:02:00.000Z "plain"`,
    ]);
    expect(r.out).not.toContain("x".repeat(61));
  });

  test("ack drops the held entry and nothing else; a role name resolves to its pane", async () => {
    const s = setup();
    heldInbox(s);
    s.d.store.setRole("duty", href("w1:p2"));
    const r = await captureIo(() => main(["inbox", "ack", "duty", "1"], s.d));
    expect(r).toEqual({ code: 0, out: "ACKED w1:p2 1" });
    expect(s.d.store.queued(href("w1:p2")).map((m) => m.text)).toEqual(["typed one", "plain"]);
  });

  test("ack and resend refuse an entry that is not held, and an index out of range", async () => {
    const s = setup();
    heldInbox(s);
    await expect(main(["inbox", "ack", "w1:p2", "2"], s.d)).rejects.toThrow(/not held/);
    await expect(main(["inbox", "resend", "w1:p2", "3"], s.d)).rejects.toThrow(/not held/);
    await expect(main(["inbox", "ack", "w1:p2", "4"], s.d)).rejects.toThrow(/no entry 4/);
    await expect(main(["inbox", "ack", "w1:p2", "x"], s.d)).rejects.toThrow(/no entry/);
    expect(s.d.store.queued(href("w1:p2"))).toHaveLength(3);
  });

  test("resend clears the attempt, and the next flush delivers it exactly once", async () => {
    const s = setup();
    s.d.store.saveInbox(href("w1:p2"), [
      { at: 0, from: "cli", text: "again", attempt: { at: 1, state: "ambiguous", detail: "timeout" } },
    ]);
    expect(await dutyTick(s.d)).toContainEqual(
      expect.objectContaining({ pane: "w1:p2", action: "delivery-ambiguous" }),
    );
    expect(s.pane.received).toEqual([]);
    const r = await captureIo(() => main(["inbox", "resend", "w1:p2", "1"], s.d));
    expect(r.out).toBe("RELEASED w1:p2 1: the next flush delivers it");
    expect(s.d.store.queued(href("w1:p2"))).toEqual([{ at: 0, from: "cli", text: "again" }]);
    expect(await dutyTick(s.d)).toEqual([{ pane: "w1:p2", action: "flushed" }]);
    expect(await dutyTick(s.d)).toEqual([]);
    expect(s.pane.received).toEqual(["again"]);
  });

  test("a gone pane with only held entries reports inbox-target-gone, not delivery-ambiguous", async () => {
    const s = setup();
    s.d.store.saveInbox(href("w1:p2"), [{ at: 0, from: "cli", text: "held", attempt: { at: 1, state: "ambiguous" } }]);
    s.w.panes.delete("w1:p2");
    expect(await dutyTick(s.d)).toEqual([{ pane: "w1:p2", action: "inbox-target-gone" }]);
  });
});
