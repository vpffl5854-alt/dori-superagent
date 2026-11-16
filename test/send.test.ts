import { describe, expect, test } from "bun:test";
import { main } from "../src/cli.ts";
import { dutyTick } from "../src/duty.ts";
import { send } from "../src/inbox.ts";
import { report, startLane } from "../src/lanes.ts";
import { setup } from "./harness-setup.ts";
import { href } from "./fake.ts";

const lead1 = href("w1:p1");

describe("pane messaging", () => {
  test("a busy lead is never interrupted: messages queue and arrive as one batch when it goes idle", async () => {
    const { d, lead, brief } = setup();
    await startLane(d, "a-lane", brief, { group: "w1" });
    lead.received.length = 0;
    lead.status = "working";
    await report(d, "a-lane", "tests red, investigating");
    expect(await send(d, "lead", "second note", "a-lane")).toBe("QUEUED");
    expect(lead.received).toEqual([]);
    lead.status = "idle";
    const events = await dutyTick(d);
    expect(events).toContainEqual({ pane: "w1:p1", action: "flushed" });
    expect(lead.received).toHaveLength(1);
    expect(lead.received[0]).toContain("2 messages arrived while you were busy");
    expect(lead.received[0]).toContain("[REPORT a-lane] tests red, investigating");
    expect(lead.received[0]).toContain("second note");
  });

  test("an omo pane that herdr refuses `agent prompt` for (agent_not_ready) still gets the text typed in", async () => {
    const { w, d, lead } = setup();
    w.promptFails.set("w1:p1", '{"error":{"code":"agent_not_ready"}}');
    expect(await send(d, "lead", "hello\n\nlead", "cli")).toBe("DELIVERED");
    expect(lead.received).toEqual(["hello / lead"]);
    expect(w.calls).toContainEqual({ cmd: "herdr", argv: ["pane", "send-keys", "w1:p1", "enter"] });
  });

  test("a failing Enter is retried without typing the text again; after 3 failures the text is reported typed", async () => {
    const { w, d, lead } = setup();
    const enters = () => w.calls.filter((c) => c.argv[1] === "send-keys").length;
    w.promptFails.set("w1:p1", '{"error":{"code":"agent_not_ready"}}');
    w.keyFails = 2;
    expect(await d.runtimes.for(lead1).deliver(lead1, "once")).toEqual({ kind: "delivered" });
    expect(lead.received).toEqual(["once"]);
    expect(enters()).toBe(3);
    w.keyFails = 5;
    const twice = await d.runtimes.for(lead1).deliver(lead1, "twice");
    expect(twice.kind).toBe("typed");
    expect(twice.kind === "typed" && String(twice.failure)).toContain("key press failed");
    expect(lead.received).toEqual(["once", "twice"]);
    expect(enters()).toBe(6);
  });

  test("another `agent prompt` failure for a message that merely mentions agent_not_ready is ambiguous", async () => {
    const { w, d, lead } = setup();
    w.promptFails.set("w1:p1", "herdr exploded");
    const out = await d.runtimes.for(lead1).deliver(lead1, "a lane quoted agent_not_ready here");
    expect(out.kind === "ambiguous" && out.detail).toContain("herdr exploded");
    expect(lead.received).toEqual([]);
  });

  test("the typed fallback trims leading and trailing newlines instead of leaving a dangling ' / '", async () => {
    const { w, d, lead } = setup();
    w.promptFails.set("w1:p1", '{"error":{"code":"agent_not_ready"}}');
    await d.runtimes.for(lead1).deliver(lead1, "\n\nhello\nworld\n\n");
    expect(lead.received).toEqual(["hello / world"]);
  });

  test("agent_not_ready on a pane that is now a plain shell types nothing and reports not delivered", async () => {
    const { w, d } = setup();
    const shell = w.addPane("w1:p7", "shell");
    w.promptFails.set("w1:p7", '{"error":{"code":"agent_not_ready"}}');
    expect(await d.runtimes.for(href("w1:p7")).deliver(href("w1:p7"), "rm -rf nothing")).toEqual({ kind: "no-agent" });
    expect(shell.received).toEqual([]);
  });

  test("an empty or blank --text is refused by send, report and ready; nothing is queued or typed", async () => {
    const { d, lead, brief } = setup();
    await startLane(d, "a-lane", brief, { group: "w1" });
    lead.received.length = 0;
    for (const argv of [
      ["send", "lead", "--text", ""],
      ["send", "lead", "--text", "  \n "],
      ["report", "a-lane", "--text", ""],
      ["ready", "a-lane", "--text", " ", "--evidence", "https://example.com/pr/1"],
    ]) {
      await expect(main(argv, d)).rejects.toThrow("the message is empty");
    }
    expect(lead.received).toEqual([]);
    expect(d.store.queued(lead1)).toEqual([]);
  });

  test("unknown targets are refused instead of guessed", async () => {
    const { d } = setup();
    await expect(send(d, "nobody", "hi", "cli")).rejects.toThrow("unknown target");
  });
});
