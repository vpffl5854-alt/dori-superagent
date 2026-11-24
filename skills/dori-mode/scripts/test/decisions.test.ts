import { expect, test } from "bun:test";

import { decisionLine, kstDay, rememberText } from "../src/decisions.ts";

test("a decision line carries the Korean day, the decision on one line and where it was said", () => {
  const at = new Date("2026-11-24T16:30:00Z"); // 01:30 KST on the 25th
  expect(kstDay(at)).toBe("2026-11-25");
  expect(decisionLine(at, "  끝난 레인은\n 닫는다 ", "도리방")).toBe(
    "- 2026-11-25 · 끝난 레인은 닫는다 (출처: 도리방)",
  );
});

test("'기억해' in 도리방 is a decision; anything else is a message for the lead", () => {
  expect(rememberText("기억해: 쇼츠는 저녁 9시에")).toBe("쇼츠는 저녁 9시에");
  expect(rememberText("기억해 커밋은 바로 push")).toBe("커밋은 바로 push");
  expect(rememberText("기억해")).toBeUndefined();
  expect(rememberText("이거 기억해 둬")).toBeUndefined();
  expect(rememberText("리드 상태 알려줘")).toBeUndefined();
});
