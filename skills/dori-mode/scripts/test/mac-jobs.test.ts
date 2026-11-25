import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type DoriConfig, defaultConfig } from "../src/config.ts";
import { decidePending, dequeue, inHerdr, macDir, submit } from "../src/mac-jobs.ts";

const dirs: string[] = [];
const cfg = (): DoriConfig => {
  const d = mkdtempSync(join(tmpdir(), "mac-jobs-"));
  dirs.push(d);
  return { ...defaultConfig(d), stateDir: d };
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

test("a task with a send/delete/pay step is held for 도리방, and runs nowhere until 진행", async () => {
  const c = cfg();
  const r = await submit(c, { app: "메일", steps: ["받는 사람", "보내기"] }, true, false, {});
  expect(r).toBe("held");
  const [pending] = readdirSync(macDir(c, "pending"));
  expect(pending).toBeDefined();
  expect(dequeue(c)).toBeUndefined();
  const id = (pending ?? "").replace(/\.json$/, "");
  expect(decidePending(c, id, true)).toBe(true);
  expect(decidePending(c, id, true)).toBe(false);
  expect(dequeue(c)?.task.steps).toEqual(["받는 사람", "보내기"]);
  expect(dequeue(c)).toBeUndefined();
});

test("버리기 drops a held task; outside Herdr a safe task queues for 맥손, oldest first", async () => {
  const c = cfg();
  await submit(c, { app: "메일", steps: ["삭제"] }, false, false, {});
  const id = (readdirSync(macDir(c, "pending"))[0] ?? "").replace(/\.json$/, "");
  expect(decidePending(c, id, false)).toBe(true);
  expect(existsSync(macDir(c, "pending", `${id}.json`))).toBe(false);
  expect(dequeue(c)).toBeUndefined();
  expect(await submit(c, { app: "계산기", steps: ["1"] }, false, false, {})).toBe("queued");
  await Bun.sleep(2);
  expect(await submit(c, { app: "계산기", steps: ["2"] }, false, false, {})).toBe("queued");
  expect(dequeue(c)?.task.steps).toEqual(["1"]);
  expect(dequeue(c)?.task.steps).toEqual(["2"]);
});

test("Herdr is told apart by its terminal id", () => {
  expect(inHerdr({ HC_TERMINAL_ID: "t5w" })).toBe(true);
  expect(inHerdr({})).toBe(false);
});
