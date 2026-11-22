import { expect, test } from "bun:test";

import type { UnifiedMessage } from "../src/messenger/unified.ts";
import type { Lane } from "../src/registry.ts";
import type { Progress } from "../src/reports.ts";
import {
  classify,
  type Destination,
  dispatch,
  type Handlers,
  route,
  routerOptionsFromEnv,
  routeTag,
} from "../src/router.ts";
import { statusReport } from "../src/status-report.ts";

const ON = { devinAvailable: true };

test.each([
  ["안녕 도리야 오늘 기분 어때?", "chat"],
  ["점심 뭐 먹을까", "chat"],
  ["telegram-inbound.ts 버그 고쳐줘", "coding"],
  ["로그인 화면 리팩터링 해줘", "coding"],
  ["fix the failing CI", "coding"],
  ["deploy 다시 해줘", "coding"],
  ["쇼츠 하나 만들어줘", "video"],
  ["이 영상 자막 고쳐줘", "video"],
  ["render the intro video", "video"],
  ["지금 진행 상황 알려줘", "status"],
  ["레인 목록 보여줘", "status"],
  ["what's running?", "status"],
] as const)("%p is %p", (text, kind) => {
  expect(classify(text)).toBe(kind);
});

test("a code word beats a video word: a bug in the render code is coding work", () => {
  expect(classify("렌더 코드 버그 고쳐줘")).toBe("coding");
});

test("a code word beats a status word: asking to fix the status command is coding work", () => {
  expect(classify("status 명령 테스트가 깨졌어")).toBe("coding");
});

test("chat goes to the fast model, video to a render job, status to the status report", () => {
  expect(route("ㅎㅇ", ON).destination).toBe("fast-model");
  expect(route("쇼츠 렌더 돌려줘", ON).destination).toBe("render");
  expect(route("진행 상황?", ON).destination).toBe("status");
});

test("multi-file implementation and root-cause hunts go to Devin, per lead.md", () => {
  expect(route("메신저 어댑터 여러 파일 구현해줘", ON).destination).toBe("devin");
  expect(route("watchdog 버그 원인 추적해줘", ON).destination).toBe("devin");
});

test("a one-line fix, an urgent ask, or work behind a login stays on a lane", () => {
  expect(route("README 오타 한 줄 고쳐줘 코드", ON)).toMatchObject({
    destination: "lane",
    reason: "small or urgent change",
  });
  expect(route("급해 이 테스트 구현해줘", ON).destination).toBe("lane");
  expect(route("슬랙 로그인 연동 구현해줘", ON)).toMatchObject({
    destination: "lane",
    reason: "needs a login Devin cannot do",
  });
});

test("without Devin every coding request opens a lane", () => {
  expect(route("메신저 어댑터 여러 파일 구현해줘", { devinAvailable: false })).toMatchObject({
    destination: "lane",
    reason: "Devin is unavailable",
  });
});

test("dispatch calls exactly the chosen destination's handler with the whole message", async () => {
  const called: [Destination, UnifiedMessage][] = [];
  const handler = (d: Destination) => async (m: UnifiedMessage) => {
    called.push([d, m]);
    return `${d} ok`;
  };
  const handlers: Handlers = {
    "fast-model": handler("fast-model"),
    lane: handler("lane"),
    devin: handler("devin"),
    render: handler("render"),
    status: handler("status"),
  };
  const msg: UnifiedMessage = { platform: "telegram", userId: "1", channel: "42", text: "쇼츠 만들어줘" };
  const out = await dispatch(msg, ON, handlers);
  expect(out).toEqual({ route: { kind: "video", destination: "render", reason: "video request" }, reply: "render ok" });
  expect(called).toEqual([["render", msg]]);
});

const lane = (key: string, extra: Partial<Lane> = {}): Lane => ({
  key,
  title: key,
  thread: "-",
  brief: "b.md",
  done: "-",
  openedAt: "2026-11-22T00:00:00Z",
  ...extra,
});

test("the status report lists open lanes with their last report and skips closed ones", () => {
  const progress: Record<string, Progress> = {
    alpha: {
      state: "running",
      lastReport: { type: "report", key: "alpha", at: "t", kind: "milestone", text: "tests green" },
      lastEvent: { type: "report", key: "alpha", at: "t", kind: "milestone", text: "tests green" },
    },
  };
  const text = statusReport(
    [lane("alpha"), lane("beta"), lane("gone", { closedAt: "2026-11-22T01:00:00Z" })],
    (k) => progress[k] ?? null,
  );
  expect(text).toBe("alpha | working | running | milestone: tests green\nbeta | working | no report");
});

test("the status report says so when nothing is running", () => {
  expect(statusReport([], () => null)).toBe("진행 중인 레인 없음");
});

test("Devin is on by default and DORI_DEVIN=off turns it off", () => {
  expect(routerOptionsFromEnv({})).toEqual({ devinAvailable: true });
  expect(routerOptionsFromEnv({ DORI_DEVIN: " OFF " })).toEqual({ devinAvailable: false });
});

test("the INBOUND route tag names the kind and the destination", () => {
  const msg: UnifiedMessage = { platform: "slack", userId: "U", channel: "C", text: "watchdog 버그 원인 추적해줘" };
  expect(routeTag(msg, { devinAvailable: true })).toBe(" route=coding:devin");
  expect(routeTag(msg, { devinAvailable: false })).toBe(" route=coding:lane");
});
