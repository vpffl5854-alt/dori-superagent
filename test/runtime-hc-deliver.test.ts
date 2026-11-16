import { describe, expect, test } from "bun:test";
import type { DeliverOutcome } from "../src/runtime/types.ts";
import { type FakeHc, terminal } from "./fake-hc.ts";
import { rig, T1 } from "./hc-rig.ts";

describe("deliver", () => {
  test("idle: send --if idle once, delivered with turn and started", async () => {
    const { fake, rt } = rig({ t1: terminal() });
    expect(await rt.deliver(T1, "hello")).toEqual({ kind: "delivered", turn: 4, started: true });
    expect(fake.calls.filter((c) => c[0] === "send")).toEqual([["send", "t1", "--if", "idle", "--", "hello"]]);
  });

  test("done: a plain send (the agent finished its turn and waits)", async () => {
    const { fake, rt } = rig({ t1: terminal({ status: { state: "done", app: "omo" } }) });
    expect((await rt.deliver(T1, "next")).kind).toBe("delivered");
    expect(fake.calls.filter((c) => c[0] === "send")).toEqual([["send", "t1", "--", "next"]]);
  });

  test("started:false is still delivered; started:null leaves started out", async () => {
    const a = rig({ t1: terminal() });
    a.fake.knobs.started = false;
    expect(await a.rt.deliver(T1, "x")).toEqual({ kind: "delivered", turn: 4, started: false });
    const b = rig({ t1: terminal() });
    b.fake.knobs.started = null;
    expect(await b.rt.deliver(T1, "x")).toEqual({ kind: "delivered", turn: 4 });
  });

  test.each([
    [
      "shell in front, unreported",
      terminal({ status: null, reported: false, foreground: { name: "bash", argv: ["bash"], pid: 1 } }),
      { kind: "no-agent" },
    ],
    [
      "shell in front while the agent last reported idle (suspended agent)",
      terminal({ foreground: { name: "zsh", argv: ["-zsh"], pid: 1 } }),
      { kind: "no-agent" },
    ],
    ["finished", terminal({ state: "finished" }), { kind: "no-agent" }],
    ["blocked without force", terminal({ status: { state: "blocked" } }), { kind: "not-ready", status: "blocked" }],
    ["error without force", terminal({ status: { state: "error" } }), { kind: "not-ready", status: "error" }],
  ] as const)("pre-probe %s: no send at all", async (_, term, want) => {
    const { fake, rt } = rig({ t1: term });
    expect(await rt.deliver(T1, "secret text")).toEqual(want);
    expect(fake.calls.some((c) => c[0] === "send")).toBe(false);
  });

  test("working under the default when=idle: hc refuses the compare-and-send, nothing typed", async () => {
    const { fake, rt } = rig({ t1: terminal({ status: { state: "working" } }) });
    expect(await rt.deliver(T1, "x")).toEqual({ kind: "not-ready", status: "working" });
    expect(fake.calls.filter((c) => c[0] === "send")).toEqual([["send", "t1", "--if", "idle", "--", "x"]]);
    expect(fake.sent).toEqual([]);
  });

  test.each(["idle", "any"] as const)(
    "an unreported program (status null, no shell in front) under when=%s: held as unknown, no send at all",
    async (when) => {
      const { fake, rt } = rig({
        t1: terminal({ status: null, reported: false, foreground: { name: "node", argv: ["node"], pid: 1 } }),
      });
      expect(await rt.deliver(T1, "x", { when })).toEqual({ kind: "not-ready", status: "unknown" });
      expect(fake.calls.some((c) => c[0] === "send")).toBe(false);
      expect(fake.sent).toEqual([]);
    },
  );

  test("when=working sends --if working", async () => {
    const { fake, rt } = rig({ t1: terminal({ status: { state: "working", app: "omo" } }) });
    expect((await rt.deliver(T1, "/goal pause", { when: "working" })).kind).toBe("delivered");
    expect(fake.calls.filter((c) => c[0] === "send")).toEqual([["send", "t1", "--if", "working", "--", "/goal pause"]]);
  });

  test("when=any sends with no status gate", async () => {
    const { fake, rt } = rig({ t1: terminal({ status: { state: "working", app: "omo" } }) });
    expect((await rt.deliver(T1, "x", { when: "any" })).kind).toBe("delivered");
    expect(fake.calls.filter((c) => c[0] === "send")).toEqual([["send", "t1", "--", "x"]]);
  });

  test("force types into a blocked agent with --force", async () => {
    const { fake, rt } = rig({ t1: terminal({ status: { state: "blocked", app: "omo" } }) });
    expect((await rt.deliver(T1, "y", { when: "any", force: true })).kind).toBe("delivered");
    expect(fake.calls.filter((c) => c[0] === "send")).toEqual([["send", "t1", "--force", "--", "y"]]);
  });

  test.each([
    ["status_mismatch", "not-ready"],
    ["blocked", "not-ready"],
    ["not_found", "no-agent"],
    ["finished", "no-agent"],
    ["unavailable", "ambiguous"],
  ] as const)("send answering %s -> %s", async (kind, want) => {
    const { fake, rt } = rig({ t1: terminal() });
    fake.knobs.sendError = kind;
    const out = await rt.deliver(T1, "secret text");
    expect(out.kind).toBe(want);
    expect(fake.sent).toEqual([]);
  });

  test("not-ready after a refused send carries the status hc reports now", async () => {
    const { fake, rt } = rig({ t1: terminal() });
    fake.knobs.sendError = "blocked";
    expect(await rt.deliver(T1, "x")).toEqual({ kind: "not-ready", status: "blocked" });
  });

  const transport: [string, (f: FakeHc) => void][] = [
    [
      "a non-JSON failure",
      (f) => {
        f.knobs.sendGarbled = true;
      },
    ],
    [
      "a runner that throws",
      (f) => {
        f.knobs.sendThrows = true;
      },
    ],
    [
      "an unavailable core",
      (f) => {
        f.knobs.sendError = "unavailable";
      },
    ],
  ];
  test.each(transport)("%s is ambiguous and never carries the text", async (_, arm) => {
    const { fake, rt } = rig({ t1: terminal() });
    arm(fake);
    const out: DeliverOutcome = await rt.deliver(T1, "secret text");
    if (out.kind !== "ambiguous") throw new Error(`expected ambiguous, got ${out.kind}`);
    expect(out.detail.length).toBeGreaterThan(0);
    expect(out.detail).not.toContain("secret text");
    expect(String(out.failure instanceof Error ? out.failure.message : out.failure)).not.toContain("secret text");
  });
});
