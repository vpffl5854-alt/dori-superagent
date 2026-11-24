import { expect, test } from "bun:test";

import { approvalKeyboard, callbackData, forwardText, leadText, parsePress, pressAnswer } from "../src/dorichat.ts";

test("a button press reads back as the action and backlog id it was made for, nothing else", () => {
  expect(parsePress(callbackData("go", "hunt-bun-49082"))).toEqual({ action: "go", id: "hunt-bun-49082" });
  expect(parsePress("bl:drop:x.y_z-1")).toEqual({ action: "drop", id: "x.y_z-1" });
  expect(parsePress("bl:go:a b")).toBeUndefined();
  expect(parsePress("bl:merge:x")).toBeUndefined();
  expect(parsePress(undefined)).toBeUndefined();
});

test("each approval gets one row of 진행 · 보류 · 버리기; an id that cannot fit Telegram's 64 bytes is left out", () => {
  const kb = approvalKeyboard([
    { id: "hunt-bun-49082", label: "#49082" },
    { id: "x".repeat(70), label: "long" },
  ]);
  expect(kb.inline_keyboard).toHaveLength(1);
  expect(kb.inline_keyboard[0]?.map((b) => b.text)).toEqual(["진행 #49082", "보류 #49082", "버리기 #49082"]);
  expect(kb.inline_keyboard[0]?.map((b) => b.callback_data)).toEqual([
    "bl:go:hunt-bun-49082",
    "bl:hold:hunt-bun-49082",
    "bl:drop:hunt-bun-49082",
  ]);
});

test("only 진행 is work for the lead; the answer says what happened, or that it did not", () => {
  expect(leadText({ action: "go", id: "a" })).toContain("backlog a 진행해");
  expect(leadText({ action: "hold", id: "a" })).toBeUndefined();
  expect(leadText({ action: "drop", id: "a" })).toBeUndefined();
  expect(pressAnswer({ action: "go", id: "a" }, true)).toBe("a: 진행 — 리드에게 넘겼어요");
  expect(pressAnswer({ action: "drop", id: "a" }, false)).toContain("처리 못 했어요");
});

test("text the owner types reaches the lead with how to answer in 도리방", () => {
  const t = forwardText("리드 오늘 뭐했어?", ["agent-telegrambot", "--bot", "superdofi_bot", "message", "send", "1"]);
  expect(t.split("\n")[0]).toBe("[도리방] 지브: 리드 오늘 뭐했어?");
  expect(t).toContain('agent-telegrambot --bot superdofi_bot message send 1 "<답>"');
});
