import { expect, test } from "bun:test";

import { laneSummary, renderBriefing, SECTION_MAX } from "../src/briefing.ts";

const now = new Date("2026-11-24T23:00:00Z"); // 08:00 KST, Wednesday

test("the briefing heads with the Korean date and time and shows only sections that have something", () => {
  const text = renderBriefing({
    now,
    finished: [{ key: "omh-port4", summary: "증거 실재 검증 완료" }],
    working: [],
    lost: [],
    faults: ["shorts-daily.err.log: SHORTS_FAILED (1회)"],
    shorts: [],
    approvals: ["hunt-bun-48810: oven-sh/bun#48810"],
    cost: { month: "2026-11", total: 12.345, calls: 61434, unknown: 3830 },
  });
  expect(text.split("\n")[0]).toBe("도리 아침 브리핑 · 11/25(수) 08:00");
  expect(text).toContain("[끝난 일] 1건\n- omh-port4: 증거 실재 검증 완료");
  expect(text).toContain("[문제] 1건");
  expect(text).toContain("[승인 기다리는 것] 1건");
  expect(text).not.toContain("[진행 중]");
  expect(text).toContain("[이번 달 비용] $12.35 (호출 61,434건, 비용 모름 3,830건)");
  expect(text).toContain("[날씨] 미연결");
});

test("a quiet night says so, and an unread cost is not shown as $0", () => {
  const text = renderBriefing({ now, finished: [], working: [], lost: [], faults: [], shorts: [], approvals: [] });
  expect(text).toContain("밤사이 새로 생긴 일 없음");
  expect(text).toContain("[이번 달 비용] 확인 못 함");
});

test("a long section shows its first lines and counts the rest; long lines are cut", () => {
  const many = Array.from({ length: SECTION_MAX + 3 }, (_, i) => `문제 ${i} ${"x".repeat(200)}`);
  const text = renderBriefing({ now, finished: [], working: [], lost: [], faults: many, shorts: [], approvals: [] });
  expect(text).toContain(`[문제] ${SECTION_MAX + 3}건`);
  expect(text).toContain("- 외 3건");
  expect(text.split("\n").every((l) => l.length <= 120)).toBe(true);
});

test("a lane summary is the first line of its answer without the READY word", () => {
  expect(laneSummary("READY 증거 검증 완료: 커밋 c79ba48\n\n- 세부")).toBe("증거 검증 완료: 커밋 c79ba48");
  expect(laneSummary(undefined)).toBe("");
});
