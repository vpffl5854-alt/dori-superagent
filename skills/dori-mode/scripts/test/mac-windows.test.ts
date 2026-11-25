import { expect, test } from "bun:test";

import { prompt } from "../src/mac-brain.ts";
import type { Engine, Reply } from "../src/mac-engine.ts";
import { type GoalDeps, runGoal } from "../src/mac-goal.ts";

const deps = (answers: string[]): GoalDeps => ({
  stopped: () => false,
  sleep: async () => undefined,
  waitMs: 1,
  maxWaits: 1,
  photos: false,
  openApp: async () => undefined,
  hold: async () => undefined,
  think: async () => {
    const a = answers.shift();
    return a ? { text: a } : { error: "no answer" };
  },
});

/** A text editor with two documents; a type lands in the window whose snapshot it was given. */
const editor = () => {
  const typed: [string, string][] = [];
  const call = async (method: string, params: Record<string, unknown> = {}): Promise<Reply> => {
    if (method === "windows")
      return {
        result: [
          { id: "2", app: "텍스트 편집기", title: "무제 2", focused: false },
          { id: "1", app: "텍스트 편집기", title: "무제", focused: false },
        ],
      };
    if (method === "ax.snapshot") return { result: { text: `- textarea [ref=e${params["target"]}0]` } };
    if (method === "ax.typeText") typed.push([String(params["ref"]), String(params["text"])]);
    if (method === "menus.items") return { result: [] };
    return { result: {} };
  };
  return { engine: { call, close: async () => undefined } as Engine, typed };
};

test("an app named in English is the app the Mac shows, and look picks one of its windows by title", async () => {
  const { engine: e, typed } = editor();
  const d = {
    ...deps([
      '{"feasible":true,"milestones":["첫 문서에 글이 있다"]}',
      '{"do":"look","app":"TextEdit","window":"무제"}',
      '{"do":"type","app":"TextEdit","field":"e10","text":"첫 문서"}',
      '{"do":"done","answer":"썼어요"}',
    ]),
    appName: async (a: string) => (a === "TextEdit" ? "텍스트 편집기" : a),
  };
  const r = await runGoal(e, "첫 문서에 써줘", d);
  expect(r.ok).toBe(true);
  expect(typed).toEqual([["e10", "첫 문서"]]);
  expect(r.history[0]?.act).toBe('텍스트 편집기 "무제" 창 보기');
});

test("the question lists an app's windows when it has several, the shown one first", () => {
  const p = prompt("g", ["텍스트 편집기"], "텍스트 편집기", "", "", [], [], ["무제", "무제 2"]);
  expect(p).toContain('Windows of "텍스트 편집기": "무제" (shown below), "무제 2"');
});
