import { afterEach, beforeEach, expect, test } from "bun:test";

import type { SessionRef } from "../../../../src/runtime/types.ts";
import type { FlowDeps } from "../src/done-flow.ts";
import { runtimesFor, runtimesOf } from "../src/run.ts";
import { listSessions, sendVerified, shellInFront, UnsafeTextError } from "../src/sessions.ts";
import { depsFor, fakeClock, hcSent, newWorld, sent, withState, type World } from "./fakes.ts";
import { hcTerm } from "./hc-runner.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const P1: SessionRef = { runtime: "herdr", id: "w:p1" };
const T1: SessionRef = { runtime: "hc", id: "t1" };

let state: ReturnType<typeof withState>;
let world: World;
const at = (ms: number, patch: Partial<FlowDeps["config"]> = {}) => depsFor(world, fakeClock(ms), state.dir, patch);
const send = (text: string, ref: SessionRef = P1) => sendVerified(runtimesOf(at(T0)), at(T0).clock, ref, text);
const typedKeys = () => world.calls.filter((c) => c[2] === "send-text" || c[2] === "send-keys");

beforeEach(() => {
  state = withState();
  world = newWorld();
});
afterEach(() => state.done());

test("delivery is confirmed by the pane's agent status moving to working, with exactly one Enter", async () => {
  world.panes = [{ pane_id: "w:p1", workspace_id: "w", agent: "pi", agent_status: "idle" }];
  world.onEnterStatus = "working";
  expect(await send("[LEAD] please report")).toBe("delivered");
  expect(world.calls.filter((c) => c[2] === "send-keys")).toHaveLength(1);
  expect(sent(world)).toEqual(["[LEAD] please report"]);
});

test("a screen that still shows the text never causes another Enter; no status change is unconfirmed", async () => {
  world.panes = [{ pane_id: "w:p1", workspace_id: "w", agent: "pi", agent_status: "idle" }];
  world.stuckReads = 10;
  expect(await send("[LEAD] stuck text still here")).toBe("unconfirmed");
  expect(world.calls.filter((c) => c[2] === "send-keys")).toHaveLength(1);
});

test("a pane that was already working cannot show a change, so the send is unconfirmed, not delivered", async () => {
  world.panes = [{ pane_id: "w:p1", workspace_id: "w", agent: "pi", agent_status: "working" }];
  expect(await send("[LEAD] queued while busy")).toBe("unconfirmed");
  expect(world.calls.filter((c) => c[2] === "send-keys")).toHaveLength(1);
});

test("a pane with no running agent is a bare shell: nothing is typed, the send fails", async () => {
  world.panes = [{ pane_id: "w:p1", workspace_id: "w" }];
  expect(await send("[LEAD] please report")).toBe("failed");
  world.panes = [];
  expect(await send("[LEAD] please report")).toBe("failed");
  expect(typedKeys()).toHaveLength(0);
});

test("an agent suspended with Ctrl+Z is still reported idle, but the shell is in front: nothing is typed", async () => {
  world.panes = [{ pane_id: "w:p1", workspace_id: "w", agent: "opencode", agent_status: "idle", foreground: "-zsh" }];
  expect(await shellInFront(runtimesOf(at(T0)), P1)).toBe(true);
  expect(await send("[LEAD] please report")).toBe("failed");
  expect(typedKeys()).toHaveLength(0);
});

test("an agent with a non-interactive sh -c child in front is delivered to; an empty foreground group is doubt", async () => {
  const pi = { pane_id: "w:p1", workspace_id: "w", agent: "pi", agent_status: "idle" };
  world.panes = [
    {
      ...pi,
      foreground: [
        { name: "pi", argv: ["pi"] },
        { name: "sh", argv: ["sh", "-c", "true"] },
      ],
    },
  ];
  world.onEnterStatus = "working";
  expect(await shellInFront(runtimesOf(at(T0)), P1)).toBe(false);
  expect(await send("[LEAD] one")).toBe("delivered");
  world.panes = [{ ...pi, foreground: [] }];
  const before = sent(world).length;
  expect(await send("[LEAD] two")).toBe("failed");
  expect(sent(world).length).toBe(before);
});

test("a failed pane lookup is doubt: nothing is typed, the send fails", async () => {
  const deps = at(T0);
  const typed: (readonly string[])[] = [];
  const run = async (argv: readonly string[]) => {
    if (argv[1] === "pane" && argv[2] === "list") return { code: 1, out: "", err: "herdr down" };
    if (argv[2] === "send-text" || argv[2] === "send-keys") typed.push(argv);
    return deps.run(argv);
  };
  const rts = runtimesFor(deps.config, {}, run, deps.clock);
  expect(await sendVerified(rts, deps.clock, P1, "[LEAD] please report")).toBe("failed");
  expect(typed).toHaveLength(0);
});

test("text with a backtick never reaches a session on either runtime", async () => {
  for (const ref of [P1, T1]) await expect(send("run `rm -rf`", ref)).rejects.toBeInstanceOf(UnsafeTextError);
  expect(world.calls).toHaveLength(0);
});

test("on hc a send is delivered once the agent's status flips to working, gated on the status read before it", async () => {
  world.terminals = { t1: hcTerm() };
  world.onEnterStatus = "working";
  expect(await send("[LEAD] please report", T1)).toBe("delivered");
  expect(hcSent(world)).toEqual(["[LEAD] please report"]);
  expect(world.calls.find((c) => c[2] === "send")).toEqual([
    "hc",
    "--json",
    "send",
    "t1",
    "--if",
    "idle",
    "--",
    "[LEAD] please report",
  ]);
});

test("on hc a working agent gets the text gated on working and the send is unconfirmed", async () => {
  world.terminals = { t1: hcTerm({ status: { state: "working", app: "omo" } }) };
  expect(await send("[LEAD] queued while busy", T1)).toBe("unconfirmed");
  expect(world.calls.find((c) => c[2] === "send")).toContain("working");
});

test("on hc a shell in front fails the send and types nothing, whatever the status word says", async () => {
  world.terminals = { t1: hcTerm({ foreground: { name: "zsh", argv: ["-zsh"], pid: 9 } }) };
  expect(await shellInFront(runtimesOf(at(T0)), T1)).toBe(true);
  expect(await send("[LEAD] please report", T1)).toBe("failed");
  expect(hcSent(world)).toEqual([]);
  world.terminals = { t1: hcTerm() };
  expect(await shellInFront(runtimesOf(at(T0)), T1)).toBe(false);
});

test("on hc a terminal that is gone or blocked gets nothing", async () => {
  expect(await send("[LEAD] please report", T1)).toBe("failed");
  world.terminals = { t1: hcTerm({ status: { state: "blocked", app: "omo" } }) };
  expect(await send("[LEAD] please report", T1)).toBe("failed");
  expect(hcSent(world)).toEqual([]);
});

test("a mixed registry lists the herdr lane and the hc lane together, whichever runtime is selected", async () => {
  world.panes = [{ pane_id: "w:p1", workspace_id: "w", agent: "pi", agent_status: "idle", title: "pane lane" }];
  world.terminals = { t1: hcTerm() };
  const lanes = [{ sessionRef: P1 }, { sessionRef: T1 }];
  for (const runtime of ["herdr", "hc"] as const) {
    const listed = await listSessions(runtimesOf(at(T0, { runtime })), { lanes });
    expect(listed.map((s) => `${s.ref.runtime}:${s.ref.id}:${s.status}`).sort()).toEqual([
      "hc:t1:idle",
      "herdr:w:p1:idle",
    ]);
  }
  // Without a lane on hc only the selected runtime is asked.
  world.calls = [];
  expect((await listSessions(runtimesOf(at(T0)))).map((s) => s.ref.id)).toEqual(["w:p1"]);
  expect(world.calls.some((c) => c[0] === "hc")).toBe(false);
});

test("a failed runtime choice still lists a stored herdr lane; with no lane the failure is thrown", async () => {
  world.panes = [{ pane_id: "w:p1", workspace_id: "w", agent: "pi", agent_status: "idle" }];
  const deps = { ...at(T0), env: { DORI_RUNTIME: "tmux" } };
  const listed = await listSessions(runtimesOf(deps), { lanes: [{ sessionRef: P1 }] });
  expect(listed.map((s) => `${s.ref.runtime}:${s.ref.id}`)).toEqual(["herdr:w:p1"]);
  expect(world.calls.some((c) => c[0] === "hc")).toBe(false);
  await expect(listSessions(runtimesOf({ ...at(T0), env: { DORI_RUNTIME: "tmux" } }))).rejects.toThrow();
});
