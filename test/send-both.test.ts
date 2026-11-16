import { describe, expect, test } from "bun:test";
import { dutyTick } from "../src/duty.ts";
import { Refusal } from "../src/refusal.ts";
import { send } from "../src/inbox.ts";
import { parseRef, type RuntimeKind } from "../src/runtime/types.ts";
import { terminal } from "./fake-hc.ts";
import { World } from "./fake.ts";

type State = "idle" | "working" | "shell" | "gone";

/** One session in the given state on either runtime, and what reached it. */
function rig(kind: RuntimeKind) {
  const w = new World();
  const d = w.deps({ runtime: kind });
  const place = (state: State): { target: string; set: (s: State) => void; received: () => string[] } => {
    if (kind === "herdr") {
      if (state !== "gone") w.addPane("w1:p7", state);
      return {
        target: "w1:p7",
        set: (s) => {
          const p = w.panes.get("w1:p7");
          if (p && s !== "gone") p.status = s;
        },
        received: () => w.panes.get("w1:p7")?.received ?? [],
      };
    }
    const shape = {
      idle: terminal(),
      working: terminal({ status: { state: "working", app: "omo" } }),
      shell: terminal({ status: null, reported: false, foreground: { name: "bash", argv: ["bash"], pid: 7 } }),
    };
    if (state !== "gone") w.hc.terminals.set("t7", shape[state]);
    return {
      target: "hc:t7",
      set: (s) => void (s !== "gone" && w.hc.terminals.set("t7", { ...shape[s], turn: 9 })),
      received: () => w.hc.sent.filter((m) => m.id === "t7").map((m) => m.text),
    };
  };
  return { w, d, place };
}

describe.each(["herdr", "hc"] as const)("send on %s (IS-2)", (kind) => {
  test("an idle agent: DELIVERED at once", async () => {
    const { d, place } = rig(kind);
    const s = place("idle");
    expect(await send(d, s.target, "hello", "cli")).toBe("DELIVERED");
    expect(s.received()).toEqual(["hello"]);
  });

  test("a working agent: QUEUED, nothing typed, delivered by the duty pass once it is idle", async () => {
    const { d, place } = rig(kind);
    const s = place("working");
    expect(await send(d, s.target, "later", "cli")).toBe("QUEUED");
    expect(s.received()).toEqual([]);
    s.set("idle");
    expect(await dutyTick(d)).toContainEqual({ pane: s.target, action: "flushed" });
    expect(s.received()).toEqual(["later"]);
  });

  test("a bare shell: held in the inbox as no-agent, never typed (#66)", async () => {
    const { d, place } = rig(kind);
    const s = place("shell");
    expect(await send(d, s.target, "rm -rf nothing", "cli")).toBe("QUEUED");
    expect(s.received()).toEqual([]);
    const events = await dutyTick(d);
    expect(events).toContainEqual(expect.objectContaining({ pane: s.target, action: "inbox-held" }));
    expect(d.store.queued(parseRef(s.target)!).map((m) => m.text)).toEqual(["rm -rf nothing"]);
  });

  test("a gone session: Refusal, the message kept in its inbox", async () => {
    const { d, place } = rig(kind);
    const s = place("gone");
    const target = kind === "herdr" ? "w1:p9" : "hc:t9";
    await expect(send(d, target, "anyone?", "cli")).rejects.toThrow(Refusal);
    expect(s.received()).toEqual([]);
    expect(d.store.queued(parseRef(target)!)).toHaveLength(1);
  });
});
