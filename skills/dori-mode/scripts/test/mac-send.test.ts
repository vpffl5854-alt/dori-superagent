import { expect, test } from "bun:test";

import { approvalText, fieldShowing, fieldValue, focusedText, sendsField } from "../src/mac.ts";
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
const sent: string[] = [];
const chat = (field: string) => {
  const call = async (method: string, params: Record<string, unknown> = {}): Promise<Reply> => {
    if (method === "keyChord") sent.push(field);
    if (method === "ax.perform") sent.push(`press:${field}`);
    if (method === "windows") return { result: [{ id: "1", app: "Discord", title: "#일반", focused: false }] };
    if (method === "ax.snapshot")
      return {
        result: {
          text: `- textarea "#일반에 메시지 보내기" [ref=e5]: "${field}"\n- button "보내기" [ref=e6]\n- button "삭제" [ref=e7]`,
        },
      };
    if (method === "ax.typeText") field = String(params["text"]);
    if (method === "menus.items") return { result: [] };
    return { result: {} };
  };
  return { call, close: async () => undefined } as Engine;
};
const deps = (answers: string[], held: MacTask[], autoSend = false): GoalDeps => ({
  autoSend,
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

const TYPE = '{"do":"type","app":"Discord","field":"#일반에 메시지 보내기","text":"테스트"}';

test("with autoSend the task's own message goes out at once, by Return or by a 보내기 button", async () => {
  for (const send of [
    '{"do":"key","app":"Discord","keys":["return"]}',
    '{"do":"press","app":"Discord","step":"보내기"}',
  ]) {
    sent.length = 0;
    const held: MacTask[] = [];
    const r = await runGoal(
      chat(""),
      "일반에 테스트 보내",
      deps([PLAN, '{"do":"look","app":"Discord"}', TYPE, send, '{"do":"done","answer":"보냈어요"}'], held, true),
    );
    expect(r.ok).toBe(true);
    expect(held).toEqual([]);
    expect(sent).toHaveLength(1);
    expect(r.history.some((h) => h.result === '보냈음: "테스트"')).toBe(true);
  }
});

test("with autoSend a delete is still held, and the owner's draft is still never sent", async () => {
  sent.length = 0;
  const held: MacTask[] = [];
  const del = await runGoal(
    chat(""),
    "지워",
    deps([PLAN, '{"do":"look","app":"Discord"}', TYPE, '{"do":"press","app":"Discord","step":"삭제"}'], held, true),
  );
  expect(del.held).toBe(true);
  expect(held).toEqual([{ app: "Discord", steps: ["삭제"] }]);
  const draft = await runGoal(
    chat("지브 초안"),
    "보내",
    deps([PLAN, '{"do":"look","app":"Discord"}', '{"do":"press","app":"Discord","step":"보내기"}'], [], true),
  );
  expect(draft.held).toBe(true);
  expect(sent).toEqual([]);
});

test("an empty Discord field shows only invisible characters: it counts as empty, a draft does not", () => {
  expect(fieldValue('- textarea "#일반에 메시지 보내기" [ref=e2]: "\ufeff "', "e2")).toBe("");
  expect(fieldValue('- textarea "#일반에 메시지 보내기" [ref=e2]: "\ufeff초안 "', "e2")).toBe("초안");
  expect(fieldValue('- textarea "메모" [ref=e2]', "e2")).toBe("");
});
