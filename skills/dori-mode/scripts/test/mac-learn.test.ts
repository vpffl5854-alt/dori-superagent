import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { prompt } from "../src/mac-brain.ts";
import type { Engine, Reply } from "../src/mac-engine.ts";
import { type GoalDeps, runGoal } from "../src/mac-goal.ts";
import {
  addTip,
  appendHistory,
  fixableFailure,
  type HistoryEntry,
  parseTip,
  readHistory,
  tipsOf,
} from "../src/mac-learn.ts";

const dir = () => mkdtempSync(join(tmpdir(), "mac-learn-"));
const entry = (over: Partial<HistoryEntry>): HistoryEntry => ({
  at: new Date().toISOString(),
  id: "x",
  goal: "g",
  ok: false,
  held: false,
  text: "",
  turns: [],
  ...over,
});

test("tips are kept per app (any case, composed Hangul), newest few, a repeat moves to the end", () => {
  const d = dir();
  for (let i = 0; i < 8; i++) addTip(d, "Discord", `tip number ${i}`);
  addTip(d, "discord", "TIP NUMBER 3");
  expect(tipsOf(d, "DISCORD")).toEqual([
    "tip number 2",
    "tip number 4",
    "tip number 5",
    "tip number 6",
    "tip number 7",
    "TIP NUMBER 3",
  ]);
  addTip(d, "텍스트 편집기".normalize("NFD"), "open the file panel's New Document button");
  expect(tipsOf(d, "텍스트 편집기")).toEqual(["open the file panel's New Document button"]);
});

test("a model's tip is its first line; NONE or a scrap is no tip", () => {
  expect(parseTip('- "Use key cmd+k, type the channel, then return."\nmore')).toBe(
    "Use key cmd+k, type the channel, then return.",
  );
  expect(parseTip("NONE")).toBeUndefined();
  expect(parseTip("ok")).toBeUndefined();
});

test("the history is read back from a time on; only real failures are for the fixer", () => {
  const d = dir();
  appendHistory(d, entry({ at: "2020-01-01T00:00:00Z", text: "old" }));
  appendHistory(d, entry({ text: "창이 안 보임" }));
  appendHistory(d, entry({ text: '도리방 "멈춰"로 멈췄어요' }));
  appendHistory(d, entry({ held: true, text: "승인 대기" }));
  appendHistory(d, entry({ ok: true, text: "done" }));
  const recent = readHistory(d, Date.now() - 60_000);
  expect(recent.map((e) => e.text)).toEqual(["창이 안 보임", '도리방 "멈춰"로 멈췄어요', "승인 대기", "done"]);
  expect(recent.filter(fixableFailure).map((e) => e.text)).toEqual(["창이 안 보임"]);
});

test("the question carries what was learned in the app", () => {
  const p = prompt("g", ["Safari"], "Safari", "", "", [], [], [], ["open pages with url, never the address bar"]);
  expect(p).toContain("Learned before in this app: open pages with url, never the address bar");
});

test("a task that failed one way and then got done is learned from; one that never failed is not", async () => {
  const call = async (method: string): Promise<Reply> => {
    if (method === "windows") return { result: [{ id: "9", app: "계산기", title: "계산기", focused: false }] };
    if (method === "ax.snapshot") return { result: { text: '- button "6" [ref=e2]' } };
    if (method === "menus.items") return { result: [] };
    return { result: {} };
  };
  const engine: Engine = { call, close: async () => undefined };
  const learnt: string[] = [];
  const deps = (answers: string[]): GoalDeps => ({
    stopped: () => false,
    sleep: async () => undefined,
    waitMs: 1,
    maxWaits: 1,
    photos: false,
    openApp: async () => undefined,
    hold: async () => undefined,
    learnTip: async (app) => void learnt.push(app),
    think: async () => {
      const a = answers.shift();
      return a ? { text: a } : { error: "no answer" };
    },
  });
  const PLAN = '{"feasible":true,"milestones":["6"]}';
  await runGoal(
    engine,
    "6",
    deps([
      PLAN,
      '{"do":"press","app":"계산기","step":"없는 버튼"}',
      '{"do":"press","app":"계산기","step":"6"}',
      '{"do":"done","answer":"ok"}',
    ]),
  );
  expect(learnt).toEqual(["계산기"]);
  await runGoal(engine, "6", deps([PLAN, '{"do":"press","app":"계산기","step":"6"}', '{"do":"done","answer":"ok"}']));
  expect(learnt).toEqual(["계산기"]);
});
