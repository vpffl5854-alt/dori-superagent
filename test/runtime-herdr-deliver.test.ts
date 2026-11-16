import { describe, expect, spyOn, test } from "bun:test";
import { HerdrError, HerdrRuntime } from "../src/runtime/herdr/index.ts";
import { fail, ok, omoFront, recorder, ref, world } from "./herdr-recorder.ts";

describe("deliver outcomes", () => {
  test("agent prompt accepted: delivered, nothing typed", async () => {
    const { w, rt, herdr } = world();
    const p = w.addPane("w1:p1");
    expect(await rt.deliver(ref("w1:p1"), "hi")).toEqual({ kind: "delivered" });
    expect(p.received).toEqual(["hi"]);
    expect(herdr()).toEqual([
      ["pane", "get", "w1:p1"],
      ["pane", "process-info", "--pane", "w1:p1"],
      ["agent", "prompt", "w1:p1", "hi"],
    ]);
  });

  test("a shell in front: no-agent, nothing sent", async () => {
    const { w, rt, herdr } = world();
    w.addPane("w1:p1").foreground = "-bash";
    expect(await rt.deliver(ref("w1:p1"), "hi")).toEqual({ kind: "no-agent" });
    expect(herdr()).toEqual([
      ["pane", "get", "w1:p1"],
      ["pane", "process-info", "--pane", "w1:p1"],
    ]);
  });

  test("a gone pane: no-agent after one pane get, nothing sent", async () => {
    const { rt, herdr } = world();
    expect(await rt.deliver(ref("w1:p1"), "hi")).toEqual({ kind: "no-agent" });
    expect(herdr()).toEqual([["pane", "get", "w1:p1"]]);
  });

  test("when and force change nothing on herdr: a shell in front is no-agent whatever herdr's status word says", async () => {
    const { w, rt, herdr } = world();
    const p = w.addPane("w1:p1", "working");
    p.foreground = "-bash";
    expect(await rt.deliver(ref("w1:p1"), "hi", { when: "working", force: true })).toEqual({ kind: "no-agent" });
    p.foreground = "omo";
    expect(await rt.deliver(ref("w1:p1"), "hi", { when: "any" })).toEqual({ kind: "delivered" });
    expect(herdr().slice(2)).toEqual([
      ["pane", "get", "w1:p1"],
      ["pane", "process-info", "--pane", "w1:p1"],
      ["agent", "prompt", "w1:p1", "hi"],
    ]);
    expect(herdr().some((a) => a[1] === "read")).toBe(false);
  });

  test("any prompt failure other than agent_not_ready is ambiguous, and its detail never carries the text", async () => {
    const { w, rt } = world();
    w.addPane("w1:p1");
    w.promptFails.set("w1:p1", "timed out");
    const out = await rt.deliver(ref("w1:p1"), "secret words");
    expect(out).toMatchObject({ kind: "ambiguous", detail: "herdr agent prompt failed: timed out" });
    expect(out.kind === "ambiguous" && out.failure).toBeInstanceOf(HerdrError);
  });

  test("agent_not_ready: re-read, type one flattened line, settle 400 ms, press Enter: delivered", async () => {
    const { w, rt, herdr, sleeps } = world();
    const p = w.addPane("w1:p1");
    w.promptFails.set("w1:p1", "agent_not_ready");
    expect(await rt.deliver(ref("w1:p1"), "  one\n\n  two \n")).toEqual({ kind: "delivered" });
    expect(p.received).toEqual(["one / two"]);
    expect(sleeps).toEqual([400]);
    expect(herdr().slice(3)).toEqual([
      ["pane", "get", "w1:p1"],
      ["pane", "process-info", "--pane", "w1:p1"],
      ["pane", "send-text", "w1:p1", "one / two"],
      ["pane", "send-keys", "w1:p1", "enter"],
    ]);
  });

  test("agent_not_ready and the agent left (shell, gone, or a shell in front): no-agent, nothing typed", async () => {
    for (const change of ["shell", "front"] as const) {
      const { w, rt } = world();
      const p = w.addPane("w1:p1");
      w.promptFails.set("w1:p1", "agent_not_ready");
      w.getHook.set("w1:p1", (n) => {
        if (n !== 2) return;
        if (change === "shell") p.status = "shell";
        else p.foreground = "-zsh";
      });
      expect(await rt.deliver(ref("w1:p1"), "hi")).toEqual({ kind: "no-agent" });
      expect(p.received).toEqual([]);
    }
    let gets = 0;
    const live = { pane: { agent: "omo", agent_status: "idle" } };
    const gone = recorder((a) =>
      a[0] === "agent"
        ? fail("agent_not_ready")
        : a[1] === "get"
          ? ++gets === 1
            ? ok(live)
            : fail("pane_not_found")
          : ok(omoFront),
    );
    expect(await new HerdrRuntime(gone.exec, "").deliver(ref("w1:p1"), "hi")).toEqual({ kind: "no-agent" });
    expect(gone.calls.filter((a) => a[1] === "get")).toHaveLength(2);
    expect(gone.calls.some((a) => a[1] === "send-text")).toBe(false);
  });

  test("a failed send-text may have typed some of it: ambiguous", async () => {
    const r = recorder((a) =>
      a[0] === "agent"
        ? fail("agent_not_ready")
        : a[1] === "send-text"
          ? fail("broken pipe")
          : ok(a[1] === "get" ? { pane: { agent: "omo", agent_status: "idle" } } : omoFront),
    );
    const out = await new HerdrRuntime(r.exec, "", { sleep: async () => {} }).deliver(ref("w1:p1"), "hi");
    expect(out).toMatchObject({ kind: "ambiguous", detail: "herdr pane send-text failed: broken pipe" });
  });

  test("Enter fails twice then works: delivered; fails three times: typed into the agent and group it went to", async () => {
    const { w, rt, herdr } = world();
    Object.assign(w.addPane("w1:p1"), { pgid: 777 });
    w.promptFails.set("w1:p1", "agent_not_ready");
    w.keyFails = 2;
    expect(await rt.deliver(ref("w1:p1"), "hi")).toEqual({ kind: "delivered" });
    w.keyFails = 3;
    const out = await rt.deliver(ref("w1:p1"), "hi");
    expect(out).toMatchObject({ kind: "typed", into: { agent: "pi", pgid: 777 } });
    expect(out.kind === "typed" && out.failure).toBeInstanceOf(HerdrError);
    expect(herdr().filter((a) => a[1] === "send-keys")).toHaveLength(6);
  });

  test("process-info fails: no-agent, and stderr says delivery is held", async () => {
    const { w, rt } = world();
    w.addPane("w1:p1");
    w.processInfoFails = true;
    const err = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(await rt.deliver(ref("w1:p1"), "hi")).toEqual({ kind: "no-agent" });
      expect(String(err.mock.calls[0]?.[0])).toBe(
        "dori: herdr pane process-info failed for w1:p1 (process-info failed); holding delivery\n",
      );
    } finally {
      err.mockRestore();
    }
  });
});

describe("a failed lookup holds the delivery, and only deliver says so", () => {
  const stderrOf = async (run: () => Promise<unknown>): Promise<{ result: unknown; lines: string[] }> => {
    const err = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const result = await run();
      return { result, lines: err.mock.calls.map((c) => String(c[0])) };
    } finally {
      err.mockRestore();
    }
  };

  test("pane get failing with anything but not-found: not-ready unknown, nothing typed, one stderr line", async () => {
    const r = recorder(() => fail('{"error":{"code":"server_not_running"}}'));
    const { result, lines } = await stderrOf(() => new HerdrRuntime(r.exec, "").deliver(ref("w1:p1"), "secret text"));
    expect(result).toEqual({ kind: "not-ready", status: "unknown" });
    expect(r.calls).toEqual([["pane", "get", "w1:p1"]]);
    expect(lines).toEqual([
      'dori: herdr pane get failed for w1:p1 ({"error":{"code":"server_not_running"}}); holding delivery\n',
    ]);
  });

  test("a probe outside delivery reads a failed process-info as doubt, without saying it holds anything", async () => {
    const { w, rt } = world();
    w.addPane("w1:p1");
    w.processInfoFails = true;
    const { result, lines } = await stderrOf(() => rt.probe(ref("w1:p1")));
    expect(result).toMatchObject({ status: "idle", shellInFront: true });
    expect(lines).toEqual([
      "dori: herdr pane process-info failed for w1:p1 (process-info failed); status read as doubt\n",
    ]);
  });
});

describe("submitTyped and typeIntoShell", () => {
  test("submitTyped presses only Enter for the same agent and group; changed or wait otherwise", async () => {
    const { w, rt, herdr } = world();
    const p = Object.assign(w.addPane("w1:p1"), { pgid: 777 });
    expect(await rt.submitTyped(ref("w1:p1"), { agent: "pi", pgid: 777 })).toBe("submitted");
    expect(herdr().at(-1)).toEqual(["pane", "send-keys", "w1:p1", "enter"]);
    expect(await rt.submitTyped(ref("w1:p1"), { agent: "omo" })).toBe("changed");
    expect(await rt.submitTyped(ref("w1:p1"), { pgid: 1 })).toBe("changed");
    p.foreground = "-bash";
    expect(await rt.submitTyped(ref("w1:p1"), {})).toBe("wait");
    p.status = "shell";
    expect(await rt.submitTyped(ref("w1:p1"), {})).toBe("changed");
    expect(await rt.submitTyped(ref("w9:p9"), {})).toBe("wait");
    expect(herdr().filter((a) => a[1] === "send-keys")).toHaveLength(1);
  });

  test("submitTyped whose Enter fails three times throws herdr's error", async () => {
    const { w, rt } = world();
    w.addPane("w1:p1");
    w.keyFails = 3;
    await expect(rt.submitTyped(ref("w1:p1"), {})).rejects.toBeInstanceOf(HerdrError);
  });

  test("typeIntoShell types text and Enter only into a pane with no agent", async () => {
    const { w, rt, herdr } = world();
    const sh = w.addPane("w1:p1", "shell");
    expect(await rt.typeIntoShell(ref("w1:p1"), "ls -la")).toBe(true);
    expect(sh.received).toEqual(["ls -la"]);
    expect(herdr().slice(1)).toEqual([
      ["pane", "send-text", "w1:p1", "ls -la"],
      ["pane", "send-keys", "w1:p1", "enter"],
    ]);
    w.addPane("w1:p2", "idle");
    expect(await rt.typeIntoShell(ref("w1:p2"), "ls")).toBe(false);
  });
});
