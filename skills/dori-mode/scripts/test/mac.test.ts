import { expect, test } from "bun:test";

import {
  dangerousSteps,
  findRef,
  findWindow,
  macCallback,
  parseMacPress,
  parseSteps,
  reportText,
  shownValues,
  showsValue,
  stopWord,
} from "../src/mac.ts";

const SNAP = [
  '- window "계산기" [ref=e1] app=계산기',
  '  - statictext "필드 편집" [ref=e8]: "77"',
  '  - button "지우기" [ref=e10]',
  '  - button "6" [ref=e19]',
  '  - menuitem "6" [ref=e40]',
  '  - button "곱하기" [ref=e16]',
].join("\n");

test("a step finds its control by exact name, any alternative, buttons first", () => {
  expect(findRef(SNAP, "6")).toBe("e19");
  expect(findRef(SNAP, "모두 지우기|지우기")).toBe("e10");
  expect(findRef(SNAP, "곱하")).toBeUndefined();
  expect(findRef(SNAP, "(")).toBeUndefined();
});

test("the expected value is read from what a control shows", () => {
  expect(showsValue(SNAP, "77")).toBe(true);
  expect(showsValue(SNAP, "7")).toBe(false);
  expect(shownValues(SNAP)).toEqual(["77"]);
});

test("steps split on commas; pay, delete, send and post are dangerous, clearing a field is not", () => {
  expect(parseSteps(" 6, 곱하기 ,,7 ")).toEqual(["6", "곱하기", "7"]);
  expect(dangerousSteps(["모두 지우기|지우기", "보내기", "Delete", "결제하기", "6", "Posted"])).toEqual([
    "보내기",
    "Delete",
    "결제하기",
  ]);
});

test("an app is found by its exact name first, then loosely", () => {
  const wins = [
    { id: "1", app: "Calculator Pro", title: "", focused: false },
    { id: "2", app: "Calculator", title: "", focused: true },
  ];
  expect(findWindow(wins, "calculator")?.id).toBe("2");
  expect(findWindow(wins, "pro")?.id).toBe("1");
  expect(findWindow(wins, "계산기")).toBeUndefined();
  const twice = [
    { id: "308", app: "계산기", title: "", focused: false },
    { id: "307", app: "계산기", title: "계산기", focused: false },
  ];
  expect(findWindow(twice, "계산기")?.id).toBe("307");
});

test("도리방 stop words are exact; button data reads back only for a mac approval", () => {
  expect(stopWord(" 멈춰! ")).toBe("stop");
  expect(stopWord("재개")).toBe("resume");
  expect(stopWord("멈춰 그거 말고")).toBeUndefined();
  expect(parseMacPress(macCallback("go", "mabc1"))).toEqual({ action: "go", id: "mabc1" });
  expect(parseMacPress("mac:go:a b")).toBeUndefined();
  expect(parseMacPress("bl:go:x")).toBeUndefined();
});

test("the report says what was pressed and whether the value matched", () => {
  const t = reportText(
    { app: "계산기", steps: ["6", "곱하기", "7"], expect: "42" },
    false,
    ["41"],
    "결과가 기대와 달라요",
  );
  expect(t.split("\n")).toEqual([
    "맥 작업 실패: 계산기",
    "누른 순서: 6 → 곱하기 → 7",
    "기대한 값: 42 → 다름",
    "지금 보이는 값: 41",
    "결과가 기대와 달라요",
  ]);
});
