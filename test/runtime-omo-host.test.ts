import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OmoHostRuntime } from "../src/runtime/omo-host/index.ts";
import { Runtimes } from "../src/runtime/registry.ts";
import { ConfigError, readRuntimeChoice } from "../src/runtime/select.ts";
import { type CreateSpec, formatRef, parseRef, type SessionRef } from "../src/runtime/types.ts";
import { FakeOmoHost, SOCKET, writeGoal } from "./fake-omo-host.ts";

const ID = "01a1f6ab-7887-758f-95b1-7bff93e12f0e";
const REF: SessionRef = { runtime: "omo-host", id: ID };
const NOW = Date.parse("2026-11-20T02:00:00.000Z");
const spec: CreateSpec = {
  name: "fix-x",
  cwd: "/w",
  env: {},
  role: "lane",
  container: "tab",
  group: "g1",
  model: "a/m",
};

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const rig = (sessionsDir = "/nonexistent") => {
  const host = new FakeOmoHost(sessionsDir);
  const logs: string[] = [];
  const rt = new OmoHostRuntime(host.exec, { env: {}, log: (l) => void logs.push(l), now: () => NOW });
  return { host, rt, logs };
};

describe("create / start / list", () => {
  test("create opens the agent with cwd, model and a name carrying the group; the ref is the durable id", async () => {
    const { host, rt } = rig();
    const ref = await rt.create(spec);
    expect(host.calls).toEqual([["open", "--cwd", "/w", "--model", "a/m", "--name", "dori/g1/fix-x"]]);
    expect(ref).toEqual({ runtime: "omo-host", id: "00000000-0000-4000-8000-000000000001", group: "g1" });
    expect(parseRef(formatRef(ref))).toEqual({ runtime: "omo-host", id: ref.id });
  });

  test("an env is refused before anything opens: a host session runs in the host's environment", async () => {
    const { host, rt } = rig();
    await expect(rt.create({ ...spec, env: { DORI_CONFIG: "/c.json" } })).rejects.toThrow(/cannot carry env/);
    expect(host.calls).toEqual([]);
  });

  test("start sends the first prompt; a text the CLI would read as a file or a flag gets one leading space", async () => {
    const { host, rt } = rig();
    host.add({ id: ID });
    await rt.start(REF, "ulw set goal and work");
    host.sessions.get(ID)!.state["isStreaming"] = false;
    await rt.start(REF, "-x");
    expect(host.calls).toEqual([
      ["prompt", ID, "ulw set goal and work"],
      ["prompt", ID, " -x"],
    ]);
  });

  test("list maps activity to status and keeps only the asked group's Dori sessions", async () => {
    const { host, rt } = rig();
    host.add({ id: ID, name: "dori/g1/fix-x", state: { isStreaming: true } });
    host.add({ id: "11111111-1111-4111-8111-111111111111", name: "dori/g2/other" });
    host.add({ id: "22222222-2222-4222-8222-222222222222", name: "someone's own session" });
    expect(await rt.list({ group: "g1" })).toEqual([
      { ref: { ...REF, group: "g1" }, name: "fix-x", cwd: "/repo", status: "working", agent: "omo" },
    ]);
    expect((await rt.list()).map((s) => [s.name, s.status])).toEqual([
      ["fix-x", "working"],
      ["other", "idle"],
      ["someone's own session", "idle"],
    ]);
  });
});

describe("probe and deliver", () => {
  test("probe: a turn is working, else idle, an open question too (its answer is the next prompt); unknown is gone", async () => {
    const { host, rt } = rig();
    const s = host.add({ id: ID });
    expect(await rt.probe(REF)).toMatchObject({ status: "idle", shellInFront: false, goal: "none" });
    s.state = { ...s.state, isStreaming: true };
    expect((await rt.probe(REF)).status).toBe("working");
    s.state = { ...s.state, isStreaming: false, pendingDialogs: [{ title: "How should I proceed?" }] };
    expect((await rt.probe(REF)).status).toBe("idle");
    expect(await rt.probe({ runtime: "omo-host", id: "33333333-3333-4333-8333-333333333333" })).toEqual({
      status: "gone",
      shellInFront: false,
    });
  });

  test("probe reads the goal from omo's record next to the session file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omo-host-"));
    dirs.push(dir);
    const { host, rt } = rig(dir);
    writeGoal(host.add({ id: ID }), "paused");
    expect((await rt.probe(REF)).goal).toBe("paused");
  });

  test("idle gets a prompt; a working session gets nothing under `idle` and a steer under `working`", async () => {
    const { host, rt } = rig();
    const s = host.add({ id: ID });
    expect(await rt.deliver(REF, "hi")).toEqual({ kind: "delivered", started: true });
    expect(await rt.deliver(REF, "again")).toEqual({ kind: "not-ready", status: "working" });
    expect(await rt.deliver(REF, "more", { when: "working" })).toEqual({ kind: "delivered", started: false });
    s.state = { ...s.state, isStreaming: false };
    expect(await rt.deliver(REF, "x", { when: "working" })).toEqual({ kind: "not-ready", status: "idle" });
    expect(host.calls.filter((c) => c[0] !== "state")).toEqual([
      ["prompt", ID, "hi"],
      ["steer", ID, "more"],
    ]);
  });

  test("`any`: a turn that started after the probe refuses the prompt (busy), so the text is steered instead", async () => {
    const { host, rt } = rig();
    host.add({ id: ID });
    host.refuseNext.set("prompt", "busy");
    host.sessions.get(ID)!.state["isStreaming"] = false;
    const out = await rt.deliver(REF, "hi", { when: "any" });
    expect(host.calls.map((c) => c[0])).toEqual(["state", "prompt", "steer"]);
    // The fake's session is idle, so the steer is parked: reported ambiguous, never sent again.
    expect(out.kind).toBe("ambiguous");
  });

  test("busy under `idle` is not-ready; an open question takes the answer as a prompt; gone is no-agent", async () => {
    const { host, rt } = rig();
    const s = host.add({ id: ID });
    host.refuseNext.set("prompt", "busy");
    expect(await rt.deliver(REF, "hi")).toEqual({ kind: "not-ready", status: "working" });
    s.state = { ...s.state, pendingDialogs: [{ title: "Which one?", options: ["a", "b"] }] };
    expect(await rt.read(REF, 3)).toBe("? Which one? [a / b]\n❯");
    expect(await rt.deliver(REF, "a")).toEqual({ kind: "delivered", started: true });
    host.sessions.clear();
    expect(await rt.deliver(REF, "hi")).toEqual({ kind: "no-agent" });
  });

  test("a question-tool request draws one `? ` line per question, with the option labels", async () => {
    const { host, rt } = rig();
    const questions = [{ header: "진행", question: "어떻게 진행할까요?", options: [{ label: "A" }, { label: "B" }] }];
    host.add({ id: ID, state: { pendingQuestions: [{ method: "question", questions }] } });
    expect(await rt.read(REF, 3)).toBe("? 어떻게 진행할까요? [A / B]\n❯");
  });

  test("a failure after the gate is ambiguous and never carries the text", async () => {
    const { host, rt } = rig();
    host.add({ id: ID });
    host.refuseNext.set("prompt", "transport_gone");
    const out = await rt.deliver(REF, "secret words");
    expect(out.kind).toBe("ambiguous");
    expect(JSON.stringify(out)).not.toContain("secret words");
  });
});

describe("keys, close, self, attach", () => {
  test("escape aborts the turn; enter sends nothing", async () => {
    const { host, rt } = rig();
    host.add({ id: ID, state: { isStreaming: true } });
    await rt.keys(REF, ["enter"]);
    await rt.keys(REF, ["escape"]);
    expect(host.calls).toEqual([["abort", ID]]);
    expect(host.sessions.get(ID)?.state["isStreaming"]).toBe(false);
  });

  test("close ends the session; an unknown one is already closed; one a viewer still holds stops its turn and fails", async () => {
    const { host, rt } = rig();
    host.add({ id: ID });
    await rt.close(REF);
    expect(await rt.list()).toEqual([]);
    host.sessions.clear();
    await rt.close(REF);
    const verbs: string[] = [];
    const viewed = new OmoHostRuntime(async (_cmd, argv) => {
      verbs.push(argv[2] ?? "");
      return { code: 0, stdout: JSON.stringify({ action: argv[2], closed: false }), stderr: "" };
    });
    await expect(viewed.close(REF)).rejects.toThrow(
      `still attached by a viewer: quit it, then omo host session close ${ID}`,
    );
    expect(verbs).toEqual(["close", "abort"]);
  });

  test("selfAny: inside a host session PI_SESSION_ID wins over an HC_TERMINAL_ID the host inherited", () => {
    const rts = new Runtimes("hc", () => {
      throw new Error("selfAny builds no runtime");
    });
    const hosted = { SENPI_RPC_HOST_PUBLIC_SOCKET: SOCKET, PI_SESSION_ID: ID, HC_TERMINAL_ID: "t3" };
    expect(rts.selfAny(hosted)).toEqual(REF);
    expect(rts.selfAny({ PI_SESSION_ID: ID, HC_TERMINAL_ID: "t3" })).toEqual({ runtime: "hc", id: "t3" });
    expect(new OmoHostRuntime(async () => ({ code: 1, stdout: "", stderr: "" }), { env: hosted }).self()).toEqual(REF);
  });

  test("read never resumes a session the host does not list: a closed lane is not brought back by a screen read", async () => {
    const { host, rt } = rig();
    host.add({ id: ID, parked: true, entries: [{ type: "message", message: { role: "user", content: "hi" } }] });
    expect(await rt.read(REF, 40)).toBe("");
    expect(host.calls).toEqual([["list"]]);
    expect(host.sessions.get(ID)?.parked).toBe(true);
    host.sessions.get(ID)!.parked = false;
    expect(await rt.read(REF, 40)).toBe("> hi\n❯");
  });

  test("a tail the CLI cut off at the pipe (exit 0, no whole JSON line) is read again with half as many entries", async () => {
    const host = new FakeOmoHost();
    const say = (text: string) => ({
      type: "message",
      message: { role: "assistant", content: [{ type: "text", text }] },
    });
    host.add({ id: ID, entries: [say("one"), say("two"), say("three")] });
    const tails: number[] = [];
    const rt = new OmoHostRuntime(
      async (cmd, argv) => {
        if (argv[2] !== "read") return host.exec(cmd, argv);
        const n = Number(argv[argv.indexOf("--tail") + 1]);
        tails.push(n);
        return n > 3
          ? { code: 0, stdout: '{"action":"read","entries":[{"type":"mess', stderr: "" }
          : host.exec(cmd, argv);
      },
      { env: {}, now: () => NOW },
    );
    expect((await rt.read(REF, 60)).split("\n")).toEqual(["one", "two", "three", "❯"]);
    expect(tails).toEqual([120, 60, 30, 15, 7, 3]);
  });

  test("attachArgv is omo's TUI client on the host's socket for the session", async () => {
    const { host, rt } = rig();
    host.add({ id: ID });
    expect(await rt.attachArgv(REF)).toEqual(["omo", "--attach", `unix://${SOCKET}`, "--session", ID]);
  });

  test("attachArgv names omo by its absolute path on this PATH, since the hc core starts the view with its own PATH", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omo-bin-"));
    dirs.push(dir);
    writeFileSync(join(dir, "omo"), "#!/bin/sh\n");
    chmodSync(join(dir, "omo"), 0o755);
    const host = new FakeOmoHost();
    host.add({ id: ID });
    const rt = new OmoHostRuntime(host.exec, { env: { PATH: `/nonexistent:${dir}` }, now: () => NOW });
    expect((await rt.attachArgv(REF))[0]).toBe(join(dir, "omo"));
  });

  test("a bare UUID is no ref, and omo-host is never the runtime the lead opens on", () => {
    expect(parseRef(ID)).toBeUndefined();
    expect(() =>
      readRuntimeChoice({ env: { DORI_RUNTIME: "omo-host" }, configPath: "/nonexistent/config.json" }),
    ).toThrow(ConfigError);
  });
});
