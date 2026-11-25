import { expect, test } from "bun:test";

import { approvalText, fieldShowing, focusedText, sendsField } from "../src/mac.ts";
import type { Engine, Reply } from "../src/mac-engine.ts";
import { type GoalDeps, runGoal } from "../src/mac-goal.ts";
import type { MacTask } from "../src/mac.ts";

test("Return and Enter send what the focused field holds; other chords do not", () => {
  expect(["key:return", "key:enter", "key:cmd+return"].every(sendsField)).toBe(true);
  expect(sendsField("key:cmd+n")).toBe(false);
  expect(focusedText('- textarea "메시지" [ref=e2]: "테스트\u200b" (focused)')).toBe("테스트");
  expect(focusedText('- textarea "메시지" [ref=e2] (focused)')).toBe("");
  expect(focusedText('- textarea "메시지" [ref=e2]: "초안"')).toBeUndefined();
  expect(fieldShowing('- textarea "a" [ref=e1]: "초안"\n- textarea "b" [ref=e2]: "테스트"', ["테스트"])).toBe("테스트");
  expect(fieldShowing('- textarea "a" [ref=e1]: "초안"', ["테스트"])).toBeUndefined();
  expect(approvalText("x", { app: "Discord", steps: ["key:return"], sends: "테스트" }, ["key:return"])).toContain(
    '보낼 글: "테스트"',
  );
});

/** A chat app whose message field already holds the owner's unsent draft. */
const chat = (field: string) => {
  const call = async (method: string, params: Record<string, unknown> = {}): Promise<Reply> => {
    if (method === "windows") return { result: [{ id: "1", app: "Discord", title: "#일반", focused: false }] };
    if (method === "ax.snapshot")
      return { result: { text: `- textarea "#일반에 메시지 보내기" [ref=e5]: "${field}"` } };
    if (method === "ax.typeText") field = String(params["text"]);
    if (method === "menus.items") return { result: [] };
    return { result: {} };
  };
  return { call, close: async () => undefined } as Engine;
};
const deps = (answers: string[], held: MacTask[]): GoalDeps => ({
  stopped: () => false,
  sleep: async () => undefined,
  waitMs: 1,
  maxWaits: 1,
  photos: false,
  openApp: async () => undefined,
  hold: async (t) => void held.push(t),
  think: async () => {
    const a = answers.shift();
    return a ? { text: a } : { error: "no answer" };
  },
});
const PLAN = '{"feasible":true,"milestones":["일반에 테스트가 올라가 있다"]}';

test("Return over the owner's draft is never sent nor held: the task ends and says why", async () => {
  const held: MacTask[] = [];
  const r = await runGoal(
    chat("쿠마 무료 크딧 보면"),
    "일반에 테스트 보내",
    deps([PLAN, '{"do":"look","app":"Discord"}', '{"do":"key","app":"Discord","keys":["return"]}'], held),
  );
  expect(r.ok).toBe(false);
  expect(r.text).toContain("내가 쓰지 않은 글");
  expect(held).toEqual([]);
});

test("Return after the task typed into an empty field is held with the text it sends", async () => {
  const held: MacTask[] = [];
  const r = await runGoal(
    chat(""),
    "일반에 테스트 보내",
    deps(
      [
        PLAN,
        '{"do":"look","app":"Discord"}',
        '{"do":"type","app":"Discord","field":"#일반에 메시지 보내기","text":"테스트"}',
        '{"do":"key","app":"Discord","keys":["return"]}',
      ],
      held,
    ),
  );
  expect(r.held).toBe(true);
  expect(held).toEqual([{ app: "Discord", steps: ["key:return"], sends: "테스트" }]);
});
