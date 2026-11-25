import { expect, test } from "bun:test";

import type { Engine, Reply } from "../src/mac-engine.ts";
import { type RunOpts, runTask } from "../src/mac-run.ts";

/** A calculator the fake engine presses: digits append, = shows 42, focus follows the script. */
const fakeEngine = (o: { focused?: boolean[]; held?: number } = {}) => {
  const calls: string[] = [];
  let shown = "0";
  let held = o.held ?? 0;
  const focus = [...(o.focused ?? [])];
  const snap = () =>
    [`- statictext "필드" [ref=e1]: "${shown}"`, '- button "6" [ref=e2]', '- button "등호" [ref=e3]'].join("\n");
  const call = async (method: string, params: Record<string, unknown> = {}): Promise<Reply> => {
    calls.push(method);
    if (method === "windows")
      return { result: [{ id: "9", app: "계산기", title: "", focused: focus.shift() ?? false }] };
    if (method === "ax.snapshot") return { result: { text: snap() } };
    if (method === "capture") return { result: { data: Buffer.from("png").toString("base64") } };
    if (method === "ax.perform") {
      if (held > 0) {
        held--;
        return { error: { code: -32010, message: "suspended", data: { code: "Suspended" } } };
      }
      shown = params["ref"] === "e3" ? "42" : params["ref"] === "e2" ? "6" : shown;
      return { result: {} };
    }
    return { result: null };
  };
  const engine: Engine = { call, close: async () => undefined };
  return { engine, calls };
};
const opts = (over: Partial<RunOpts> = {}): RunOpts => ({
  stopped: () => false,
  sleep: async () => undefined,
  waitMs: 1,
  maxWaits: 3,
  photos: true,
  ...over,
});
const TASK = { app: "계산기", steps: ["6", "등호"], expect: "42" };

test("presses by name, checks the value and takes a photo before and after", async () => {
  const { engine, calls } = fakeEngine();
  const r = await runTask(engine, TASK, opts());
  expect(r.ok).toBe(true);
  expect(r.shown).toEqual(["42"]);
  expect(new TextDecoder().decode(r.before)).toBe("png");
  expect(r.after).toBeDefined();
  expect(calls.filter((c) => c === "ax.perform")).toHaveLength(2);
});

test("waits while the owner has the app in front, and gives up once the waits are spent", async () => {
  const waitedOnce = await runTask(fakeEngine({ focused: [true, true, false] }).engine, TASK, opts());
  expect(waitedOnce.ok).toBe(true);
  expect(waitedOnce.waited).toBe(1);
  const { engine, calls } = fakeEngine({ focused: [true, true, true, true, true] });
  const r = await runTask(engine, TASK, opts());
  expect(r.ok).toBe(false);
  expect(r.note).toContain("쓰는 중");
  expect(calls).not.toContain("ax.perform");
});

test("the stop switch halts before the next press", async () => {
  const { engine, calls } = fakeEngine();
  const r = await runTask(engine, TASK, opts({ stopped: () => true }));
  expect(r.ok).toBe(false);
  expect(r.note).toContain("멈춰");
  expect(calls).not.toContain("ax.perform");
});

test("input the engine held back for the owner is tried again; a missing control fails at once", async () => {
  const held = await runTask(fakeEngine({ held: 2 }).engine, TASK, opts());
  expect(held.ok).toBe(true);
  expect(held.waited).toBe(2);
  const missing = await runTask(fakeEngine().engine, { app: "계산기", steps: ["없음"] }, opts());
  expect(missing.ok).toBe(false);
  expect(missing.note).toContain('"없음" 버튼을 못 찾았어요');
  const noApp = await runTask(fakeEngine().engine, { app: "메모", steps: ["6"] }, opts({ photos: false }));
  expect(noApp.note).toContain("창을 못 찾았어요");
});

test("a wrong result is a failure with the value shown", async () => {
  const r = await runTask(fakeEngine().engine, { app: "계산기", steps: ["6"], expect: "42" }, opts({ photos: false }));
  expect(r.ok).toBe(false);
  expect(r.shown).toEqual(["6"]);
  expect(r.before).toBeUndefined();
});
