import { describe, expect, test } from "bun:test";
import { type ExecResult, ToolError } from "../src/runtime/exec.ts";
import { HerdrError, HerdrRuntime } from "../src/runtime/herdr/index.ts";
import { type CreateSpec, openSession } from "../src/runtime/types.ts";
import { fail, ok, omoFront, recorder, ref, world } from "./herdr-recorder.ts";

const pane = { pane_id: "w1:p2", tab_id: "w1:t2", workspace_id: "w1" };
const spec = (over: Partial<CreateSpec> = {}): CreateSpec => ({
  name: "dori",
  cwd: "/w",
  env: {},
  role: "lead",
  container: "workspace-root",
  ...over,
});

describe("herdr argv", () => {
  test("a named session goes in front of every call, pane read included; no session adds nothing", async () => {
    const named = recorder(() => ok({}));
    const h = new HerdrRuntime(named.exec, "iso");
    await h.read(ref("w1:p1"), 40);
    await h.close(ref("w1:p1"));
    await h.keys(ref("w1:p1"), ["escape", "enter"]);
    expect(named.calls).toEqual([
      ["--session", "iso", "pane", "read", "w1:p1", "--lines", "40", "--source", "recent"],
      ["--session", "iso", "pane", "close", "w1:p1"],
      ["--session", "iso", "pane", "send-keys", "w1:p1", "escape"],
      ["--session", "iso", "pane", "send-keys", "w1:p1", "enter"],
    ]);
    const plain = recorder();
    await new HerdrRuntime(plain.exec, "").read(ref("w1:p1"), 80);
    expect(plain.calls).toEqual([["pane", "read", "w1:p1", "--lines", "80", "--source", "recent"]]);
  });

  test("createGroup, the three create forms and start: never take focus, pass workspace and env as flags", async () => {
    const r = recorder((argv) =>
      ok(
        argv[1] === "split"
          ? { pane }
          : argv[0] === "tab"
            ? { root_pane: { pane_id: "w3:p4", workspace_id: "w3" }, tab_id: "w3:t4" }
            : { root_pane: pane },
      ),
    );
    const h = new HerdrRuntime(r.exec, "");
    expect(await h.createGroup("dori", "/w")).toBe("w1");
    expect(await h.create(spec())).toEqual(ref("w1:p2", "w1", "w1:t2"));
    await h.create(spec({ name: "solo", env: { A: "1" } }));
    expect(
      await h.create(
        spec({
          name: "fix-login",
          container: "tab",
          group: "w3",
          role: "lane",
          env: { DORI_LANE: "fix-login", NOTE: "a b" },
        }),
      ),
    ).toEqual(ref("w3:p4", "w3", "w3:t4"));
    await h.create(spec({ name: "other", container: "tab" }));
    expect(
      await h.create(
        spec({ name: "duty", container: "split-below", env: { DORI_ROLE: "duty" }, near: ref("w1:p1", "w1") }),
      ),
    ).toEqual(ref("w1:p2", "w1", "w1:t2"));
    await h.start(ref("w1:p2"), "dori duty");
    expect(r.calls).toEqual([
      ["workspace", "create", "--label", "dori", "--cwd", "/w", "--no-focus"],
      ["workspace", "create", "--label", "dori", "--cwd", "/w", "--no-focus"],
      ["workspace", "create", "--label", "solo", "--cwd", "/w", "--env", "A=1", "--no-focus"],
      [
        "tab",
        "create",
        "--label",
        "fix-login",
        "--cwd",
        "/w",
        "--no-focus",
        "--workspace",
        "w3",
        "--env",
        "DORI_LANE=fix-login",
        "--env",
        "NOTE=a b",
      ],
      ["tab", "create", "--label", "other", "--cwd", "/w", "--no-focus"],
      [
        "pane",
        "split",
        "w1:p1",
        "--direction",
        "down",
        "--ratio",
        "0.3",
        "--cwd",
        "/w",
        "--no-focus",
        "--env",
        "DORI_ROLE=duty",
      ],
      ["pane", "run", "w1:p2", "dori duty"],
    ]);
    await expect(h.create(spec({ container: "split-below" }))).rejects.toThrow("needs `near`");
  });

  test("openSession creates then starts: workspace create, then pane run in its root pane", async () => {
    const r = recorder(() => ok({ root_pane: pane }));
    expect(await openSession(new HerdrRuntime(r.exec, ""), spec(), "omo")).toEqual(ref("w1:p2", "w1", "w1:t2"));
    expect(r.calls).toEqual([
      ["workspace", "create", "--label", "dori", "--cwd", "/w", "--no-focus"],
      ["pane", "run", "w1:p2", "omo"],
    ]);
  });

  test("openSession: a failed pane run closes the pane workspace create made, then rethrows", async () => {
    const r = recorder((argv) => (argv[1] === "run" ? fail("run failed") : ok({ root_pane: pane })));
    await expect(openSession(new HerdrRuntime(r.exec, ""), spec(), "omo")).rejects.toThrow("run failed");
    expect(r.calls).toEqual([
      ["workspace", "create", "--label", "dori", "--cwd", "/w", "--no-focus"],
      ["pane", "run", "w1:p2", "omo"],
      ["pane", "close", "w1:p2"],
    ]);
  });

  test("a tab spec with an empty group is a tab with no --workspace, as an absent group", async () => {
    const r = recorder(() => ok({ root_pane: pane }));
    await new HerdrRuntime(r.exec, "").create(spec({ name: "lane", container: "tab", group: "" }));
    expect(r.calls).toEqual([["tab", "create", "--label", "lane", "--cwd", "/w", "--no-focus"]]);
  });

  test("close: session closes the pane; container closes the tab, or the pane when the ref names no tab", async () => {
    const r = recorder();
    const h = new HerdrRuntime(r.exec, "");
    await h.close(ref("w1:p2", "w1", "w1:t2"));
    await h.close(ref("w1:p2", "w1", "w1:t2"), "container");
    await h.close(ref("w1:p2", "w1"), "container");
    expect(r.calls).toEqual([
      ["pane", "close", "w1:p2"],
      ["tab", "close", "w1:t2"],
      ["pane", "close", "w1:p2"],
    ]);
  });

  test("a message is one argv element, delivered verbatim: quotes, $(...) and newlines are never expanded", async () => {
    const r = recorder((argv) =>
      ok(argv[1] === "process-info" ? omoFront : { pane: { agent: "omo", agent_status: "idle" } }),
    );
    const text = `it's "done" $(rm -rf ~) \`id\`\nline two`;
    expect(await new HerdrRuntime(r.exec, "").deliver(ref("w1:p1"), text)).toEqual({ kind: "delivered" });
    expect(r.calls).toEqual([
      ["pane", "get", "w1:p1"],
      ["pane", "process-info", "--pane", "w1:p1"],
      ["agent", "prompt", "w1:p1", text],
    ]);
  });

  test("list reads pane list and keeps only the group's panes; self comes from the pane's own env", async () => {
    const panes = [
      { ...pane, agent: "omo", agent_status: "working", title: "omo", cwd: "/w" },
      { pane_id: "w2:p1", workspace_id: "w2" },
      { pane_id: "w1:p5", workspace_id: "w1", agent: null },
    ];
    const r = recorder(() => ok({ panes }));
    const h = new HerdrRuntime(r.exec, "", { env: { HERDR_PANE_ID: "w2:p4", HERDR_WORKSPACE_ID: "w2" } });
    expect(await h.list({ group: "w1" })).toEqual([
      { ref: ref("w1:p2", "w1", "w1:t2"), title: "omo", cwd: "/w", status: "working", agent: "omo" },
      { ref: ref("w1:p5", "w1"), status: "shell" },
    ]);
    expect((await h.list()).map((s) => s.ref.id)).toEqual(["w1:p2", "w2:p1", "w1:p5"]);
    expect(r.calls).toEqual([
      ["pane", "list"],
      ["pane", "list"],
    ]);
    expect(h.kind).toBe("herdr");
    expect(h.self()).toEqual(ref("w2:p4", "w2"));
    expect(new HerdrRuntime(r.exec, "", { env: { HERDR_PANE_ID: "w2:p4" } }).self()).toEqual(ref("w2:p4"));
    expect(new HerdrRuntime(r.exec, "", { env: {} }).self()).toBeUndefined();
  });
});

describe("herdr replies", () => {
  test("a create that returns no pane id throws instead of handing back an empty pane", async () => {
    const h = new HerdrRuntime(recorder(() => ok({ root_pane: { tab_id: "w1:t2" } })).exec, "");
    await expect(h.create(spec({ container: "tab", group: "w1" }))).rejects.toThrow("herdr did not return a pane id");
    await expect(h.createGroup("dori", "/w")).rejects.toThrow("herdr did not return a workspace id");
  });

  test("a failed call throws HerdrError (a ToolError) with herdr's own reason, from stderr or else stdout", async () => {
    const onStdout = new HerdrRuntime(recorder(() => fail("", '{"error":{"code":"pane_not_found"}}\n')).exec, "iso");
    const e = await onStdout.close(ref("w1:p7")).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(HerdrError);
    expect(e).toBeInstanceOf(ToolError);
    expect((e as HerdrError).message).toBe(
      'herdr --session iso pane close w1:p7 failed (1): {"error":{"code":"pane_not_found"}}',
    );
    const onStderr = new HerdrRuntime(recorder(() => fail("socket closed", "partial")).exec, "");
    await expect(onStderr.read(ref("w1:p7"), 80)).rejects.toThrow("herdr pane read w1:p7 failed (1): socket closed");
  });

  test("a successful call whose output is not JSON reads as an empty result", async () => {
    const h = new HerdrRuntime(recorder(() => ({ code: 0, stdout: "ok\n", stderr: "" })).exec, "");
    await expect(h.close(ref("w1:p1"))).resolves.toBeUndefined();
  });

  test("probe: pane_not_found is gone, but a herdr server that is down is an error, never a lost pane", async () => {
    const probe = (reply: ExecResult) => new HerdrRuntime(recorder(() => reply).exec, "").probe(ref("w1:p1"));
    expect((await probe(fail('{"error":{"code":"pane_not_found","message":"pane w1:p1 not found"}}'))).status).toBe(
      "gone",
    );
    expect(await probe(ok({}))).toEqual({ status: "gone", shellInFront: true });
    await expect(
      probe(fail('{"error":{"code":"server_not_running","message":"no herdr server is running"}}')),
    ).rejects.toThrow("server_not_running");
  });

  test("probe: no agent is a shell; herdr's four states pass through and anything else is unknown", async () => {
    const status = async (p: Record<string, unknown>) =>
      (await new HerdrRuntime(recorder(() => ok({ pane: p })).exec, "").probe(ref("w1:p1"))).status;
    expect(await status({ agent: null, agent_status: "idle" })).toBe("shell");
    for (const s of ["idle", "working", "blocked", "done"] as const)
      expect(await status({ agent: "omo", agent_status: s })).toBe(s);
    expect(await status({ agent: "omo", agent_status: "compacting" })).toBe("unknown");
    expect(await status({ agent: "omo" })).toBe("unknown");
  });

  test("probe: one snapshot of status, agent, foreground group, root pid, processes, title and cwd", async () => {
    const { w, rt } = world();
    Object.assign(w.addPane("w1:p1", "idle"), { agent: "omo", pgid: 777 });
    expect(await rt.probe(ref("w1:p1"))).toEqual({
      status: "idle",
      agent: "omo",
      pgid: 777,
      rootPid: 100,
      shellInFront: false,
      foreground: [{ name: "omo", argv: ["omo"], pid: 101 }],
    });
    const titled = recorder((a) =>
      ok(a[1] === "get" ? { pane: { agent: "omo", agent_status: "idle", title: "fix-login", cwd: "/w" } } : {}),
    );
    expect(await new HerdrRuntime(titled.exec, "").probe(ref("w1:p1"))).toMatchObject({
      status: "idle",
      title: "fix-login",
      cwd: "/w",
    });
    w.addPane("w1:p2", "shell");
    expect(await rt.probe(ref("w1:p2"))).toMatchObject({ status: "shell", shellInFront: true });
  });
});
