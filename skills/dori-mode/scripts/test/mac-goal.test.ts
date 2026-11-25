import { expect, test } from "bun:test";

import { macGoal, nextTier, parseAct, prompt, wantsSonnet } from "../src/mac-brain.ts";
import { goalKey } from "../src/mac-do.ts";
import type { MacTask } from "../src/mac.ts";
import type { Engine, Reply } from "../src/mac-engine.ts";
import { type GoalDeps, runGoal } from "../src/mac-goal.ts";

test("the model's one action is read from its answer; anything else is no action", () => {
  expect(parseAct('생각... {"do":"press","app":"계산기","step":"6"} 끝')).toEqual({
    do: "press",
    app: "계산기",
    step: "6",
  });
  expect(parseAct('{"do":"type","app":"메모","field":"본문","text":""}')).toEqual({
    do: "type",
    app: "메모",
    field: "본문",
    text: "",
  });
  expect(parseAct('{"do":"press","app":"계산기"}')).toBeUndefined();
  expect(parseAct('{"do":"rm -rf"}')).toBeUndefined();
  expect(parseAct("no json")).toBeUndefined();
});

test("DeepSeek until two failures, then Sonnet until three; 소넷 in the request starts on Sonnet", () => {
  expect(nextTier("deepseek", 1)).toBe("deepseek");
  expect(nextTier("deepseek", 2)).toBe("sonnet");
  expect(nextTier("sonnet", 2)).toBe("sonnet");
  expect(nextTier("sonnet", 3)).toBeUndefined();
  expect(wantsSonnet("소넷으로 메모 열어줘")).toBe(true);
  expect(wantsSonnet("메모 열어줘")).toBe(false);
});

test("도리방 text is a Mac request only when it starts with 맥", () => {
  expect(macGoal("맥에서 계산기로 6 곱하기 7")).toBe("계산기로 6 곱하기 7");
  expect(macGoal("맥: 메모 열어줘")).toBe("메모 열어줘");
  expect(macGoal("맥북 배터리 어때")).toBeUndefined();
  expect(macGoal("오늘 맥에서 뭐 했어")).toBeUndefined();
  expect(goalKey("소넷으로 계산기로 6 곱하기 7!")).toBe(goalKey("계산기로 6곱하기 7"));
});

test("the question carries the goal, the controls by name and what was done", () => {
  const p = prompt(
    "6 곱하기 7",
    ["계산기"],
    "계산기",
    '- button "6" [ref=e2]',
    "보기 > 기본(Cmd+1)",
    ["계산기 화면에 42가 보인다"],
    [{ act: "계산기 열기", result: "열었음" }],
  );
  expect(p).toContain("Goal (Korean): 6 곱하기 7");
  expect(p).toContain('- button "6" [ref=e2]');
  expect(p).toContain("1. 계산기 열기 -> 열었음");
  expect(p).toContain("보기 > 기본(Cmd+1)");
  expect(p).toContain("1. 계산기 화면에 42가 보인다");
});

const calls: string[] = [];
const engine = (): Engine => {
  let shown = "0";
  const call = async (method: string, params: Record<string, unknown> = {}): Promise<Reply> => {
    if (method === "windows") return { result: [{ id: "9", app: "계산기", title: "계산기", focused: false }] };
    if (method === "ax.snapshot")
      return {
        result: { text: `- statictext "f" [ref=e1]: "${shown}"\n- button "6" [ref=e2]\n- button "보내기" [ref=e3]` },
      };
    if (method === "ax.perform") shown = params["ref"] === "e2" ? "6" : shown;
    if (method === "menus.items") return { result: [] };
    if (method === "menus.select") shown = (params["path"] as string[]).join(">") === "보기>기본" ? "기본" : shown;
    if (method === "keyChord") calls.push((params["keys"] as string[]).join("+"));
    return { result: {} };
  };
  return { call, close: async () => undefined };
};
const PLAN = '{"feasible":true,"milestones":["계산기 화면에 6이 보인다"]}';
const deps = (
  answers: Record<"deepseek" | "sonnet", string[]>,
  held: MacTask[] = [],
): GoalDeps & { asked: string[] } => {
  const asked: string[] = [];
  return {
    asked,
    stopped: () => false,
    sleep: async () => undefined,
    waitMs: 1,
    maxWaits: 1,
    photos: false,
    openApp: async () => undefined,
    hold: async (t) => void held.push(t),
    think: async (tier) => {
      asked.push(tier);
      const a = answers[tier].shift();
      return a ? { text: a } : { error: "no answer" };
    },
  };
};

test("two bad DeepSeek turns hand the task to Sonnet, whose presses are learned as a recipe", async () => {
  const d = deps({
    deepseek: [PLAN, "모르겠어요", '{"do":"press","app":"계산기","step":"없는 버튼"}'],
    sonnet: [
      '{"reflect":"없는 버튼이었다","do":"press","app":"계산기","step":"6"}',
      '{"do":"done","answer":"6을 눌렀어요"}',
    ],
  });
  const r = await runGoal(engine(), "계산기에 6", d);
  expect(r.ok).toBe(true);
  expect(r.tiers).toEqual(["deepseek", "sonnet"]);
  expect(d.asked).toEqual(["deepseek", "deepseek", "deepseek", "sonnet", "sonnet"]);
  expect(r.plan).toEqual(["계산기 화면에 6이 보인다"]);
  expect(r.history.some((h) => h.act.includes("돌아보기: 없는 버튼이었다"))).toBe(true);
  expect(r.recipe).toEqual({ app: "계산기", steps: ["6"] });
});

test("a send/pay/delete press ends the run and is held for 도리방, never pressed", async () => {
  const held: MacTask[] = [];
  const r = await runGoal(
    engine(),
    "보내",
    deps({ deepseek: [PLAN, '{"do":"press","app":"계산기","step":"보내기"}'], sonnet: [] }, held),
  );
  expect(r.ok).toBe(false);
  expect(r.held).toBe(true);
  expect(held).toEqual([{ app: "계산기", steps: ["보내기"] }]);
  expect(r.recipe).toBeUndefined();
});

test("Sonnet giving up ends the task with its reason", async () => {
  const r = await runGoal(
    engine(),
    "소넷으로 불가능한 일",
    deps({ deepseek: [], sonnet: [PLAN, '{"do":"fail","reason":"그런 버튼이 없어요"}'] }),
  );
  expect(r.ok).toBe(false);
  expect(r.text).toBe("그런 버튼이 없어요");
  expect(r.tiers).toEqual(["sonnet"]);
});

test("an OmO model ref splits into its provider and the model id there", async () => {
  const { splitModel } = await import("../src/omo-provider.ts");
  expect(splitModel("hive2/deepseek-ai/deepseek-v4.1-flash-1017")).toEqual({
    provider: "hive2",
    model: "deepseek-ai/deepseek-v4.1-flash-1017",
  });
  expect(splitModel("deepseek")).toBeUndefined();
  expect(splitModel("hive2/")).toBeUndefined();
});

test("a request DeepSeek calls impossible is asked of Sonnet; Sonnet's no ends it with nothing touched", async () => {
  const d = deps({
    deepseek: ['{"feasible":false,"reason":"맥에 조도 센서가 없어요"}'],
    sonnet: ['{"feasible":false,"reason":"맥에 조도 센서가 없어서 화면 밝기를 방에 맞출 수 없어요"}'],
  });
  const r = await runGoal(engine(), "방 밝기에 맞춰 영상 밝기 자동 조절", d);
  expect(r.ok).toBe(false);
  expect(r.text).toContain("할 수 없는 일이라 손대지 않았어요");
  expect(r.tiers).toEqual(["deepseek", "sonnet"]);
  expect(d.asked).toEqual(["deepseek", "sonnet"]);
});

test("menus and key chords are actions too, and land in the learned recipe; a delete chord is held", async () => {
  const d = deps({
    deepseek: [
      PLAN,
      '{"do":"menu","app":"계산기","path":["보기","기본"]}',
      '{"do":"key","app":"계산기","keys":["CMD","1"]}',
      '{"do":"done","answer":"기본으로 바꿨어요"}',
    ],
    sonnet: [],
  });
  const r = await runGoal(engine(), "계산기를 기본 모드로", d);
  expect(r.ok).toBe(true);
  expect(r.recipe).toEqual({ app: "계산기", steps: ["menu:보기>기본", "key:cmd+1"] });
  const held: MacTask[] = [];
  const h = await runGoal(
    engine(),
    "지워",
    deps({ deepseek: [PLAN, '{"do":"key","app":"계산기","keys":["cmd","delete"]}'], sonnet: [] }, held),
  );
  expect(h.held).toBe(true);
  expect(held).toEqual([{ app: "계산기", steps: ["key:cmd+delete"] }]);
});

test("an action that does not exist is answered with the list of those that do", async () => {
  const { badAnswerNote } = await import("../src/mac-brain.ts");
  expect(badAnswerNote('{"do":"triple_click","x":1}')).toContain("있는 동작: open, look, press");
  expect(badAnswerNote("모르겠다")).toBe("JSON 한 개로 답하지 않음");
});

test("the head never answers a permission prompt itself: pressing 허용 there is held for 도리방", async () => {
  const held: MacTask[] = [];
  const e: Engine = {
    call: async (method) =>
      method === "windows"
        ? { result: [{ id: "569", app: "UserNotificationCenter", title: "", focused: false }] }
        : method === "ax.snapshot"
          ? { result: { text: '- button "허용 안 함" [ref=e6]\n- button "허용" [ref=e7]' } }
          : { result: [] },
    close: async () => undefined,
  };
  const r = await runGoal(
    e,
    "권한 창 허용해",
    deps({ deepseek: [PLAN, '{"do":"press","app":"UserNotificationCenter","step":"허용"}'], sonnet: [] }, held),
  );
  expect(r.held).toBe(true);
  expect(held).toEqual([{ app: "UserNotificationCenter", steps: ["허용"] }]);
});
