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
  const p = prompt("6 곱하기 7", ["계산기"], "계산기", '- button "6" [ref=e2]', [
    { act: "계산기 열기", result: "열었음" },
  ]);
  expect(p).toContain("Goal (Korean): 6 곱하기 7");
  expect(p).toContain('- button "6" [ref=e2]');
  expect(p).toContain("1. 계산기 열기 -> 열었음");
});

const engine = (): Engine => {
  let shown = "0";
  const call = async (method: string, params: Record<string, unknown> = {}): Promise<Reply> => {
    if (method === "windows") return { result: [{ id: "9", app: "계산기", title: "계산기", focused: false }] };
    if (method === "ax.snapshot")
      return {
        result: { text: `- statictext "f" [ref=e1]: "${shown}"\n- button "6" [ref=e2]\n- button "보내기" [ref=e3]` },
      };
    if (method === "ax.perform") shown = params["ref"] === "e2" ? "6" : shown;
    return { result: {} };
  };
  return { call, close: async () => undefined };
};
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
    deepseek: ["모르겠어요", '{"do":"press","app":"계산기","step":"없는 버튼"}'],
    sonnet: ['{"do":"press","app":"계산기","step":"6"}', '{"do":"done","answer":"6을 눌렀어요"}'],
  });
  const r = await runGoal(engine(), "계산기에 6", d);
  expect(r.ok).toBe(true);
  expect(r.tiers).toEqual(["deepseek", "sonnet"]);
  expect(d.asked).toEqual(["deepseek", "deepseek", "sonnet", "sonnet"]);
  expect(r.recipe).toEqual({ app: "계산기", steps: ["6"] });
});

test("a send/pay/delete press ends the run and is held for 도리방, never pressed", async () => {
  const held: MacTask[] = [];
  const r = await runGoal(
    engine(),
    "보내",
    deps({ deepseek: ['{"do":"press","app":"계산기","step":"보내기"}'], sonnet: [] }, held),
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
    deps({ deepseek: [], sonnet: ['{"do":"fail","reason":"그런 버튼이 없어요"}'] }),
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
