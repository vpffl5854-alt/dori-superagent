import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applySetting, parseTime, SettingError, settingsText, viewSettings } from "../src/shorts-settings.ts";
import { FRESH_MS, parseHeadwords, trendPrompt, trendTitles } from "../src/shorts-trend.ts";

const CLI = ["bun", "run", "cli.ts"];
const yes = () => true;

test("a voice is one of the Mac's Korean voices, case-insensitive, or none for captions only", () => {
  expect(applySetting({}, "voice", "eddy", CLI, yes).voice).toEqual(["say", "-v", "Eddy", "-o", "{out}", "{text}"]);
  expect(applySetting({}, "voice", "none", CLI, yes).voice).toEqual([]);
  expect(() => applySetting({}, "voice", "Siri", CLI, yes)).toThrow(SettingError);
});

test("background and topics switch the slots to the built-in commands", () => {
  expect(applySetting({}, "background", "wiki", CLI, yes).image).toEqual([
    ...CLI,
    "shorts",
    "wiki-image",
    "{topic}",
    "{out}",
  ]);
  expect(applySetting({ image: ["x"] }, "background", "plain", CLI, yes).image).toEqual([]);
  expect(applySetting({}, "topics", "trend", CLI, yes).topics).toEqual([...CLI, "shorts", "trend-topics"]);
  expect(() => applySetting({}, "topics", "random", CLI, yes)).toThrow(SettingError);
});

test("interests, length and font are checked before they are written", () => {
  expect(applySetting({}, "interests", "AI, 돈 버는 법，수면", CLI, yes).interests).toEqual([
    "AI",
    "돈 버는 법",
    "수면",
  ]);
  expect(() => applySetting({}, "interests", " , ", CLI, yes)).toThrow(SettingError);
  expect(applySetting({}, "maxSeconds", "45", CLI, yes).maxSeconds).toBe(45);
  expect(() => applySetting({}, "maxSeconds", "999", CLI, yes)).toThrow(SettingError);
  expect(() => applySetting({}, "font", "/nope.ttf", CLI, () => false)).toThrow(SettingError);
  expect(() => applySetting({}, "colour", "red", CLI, yes)).toThrow("바꿀 수 있는 것");
});

test("the settings read back in plain Korean", () => {
  const cfg = applySetting(applySetting({}, "voice", "Reed", CLI, yes), "topics", "trend", CLI, yes);
  const text = settingsText(viewSettings({ ...cfg, interests: ["AI"] }), "09:00");
  expect(text).toContain("목소리: Reed");
  expect(text).toContain("주제: 관심 분야 인기 영상 + 세상의 모든 것");
  expect(text).toContain("배경: 단색");
  expect(text).toContain("보내는 시간: 매일 09:00");
});

test("the daily time is HH:MM", () => {
  expect(parseTime("9:05")).toEqual({ hour: 9, minute: 5 });
  expect(parseTime("21:30")).toEqual({ hour: 21, minute: 30 });
  expect(() => parseTime("25:00")).toThrow(SettingError);
});

test("trend titles come only from fresh searches of the owner's interests", () => {
  const dir = mkdtempSync(join(tmpdir(), "trend-"));
  const now = Date.parse("2026-11-22T12:00:00Z");
  writeFileSync(
    join(dir, "youtube-search-수면.json"),
    JSON.stringify({ at: "2026-11-22T09:00:00Z", title: ["빗소리 10시간"] }),
  );
  writeFileSync(
    join(dir, "youtube-search-돈_버는_법.json"),
    JSON.stringify({ at: new Date(now - FRESH_MS - 1).toISOString(), title: ["오래된 제목"] }),
  );
  expect(trendTitles(dir, ["수면", "돈 버는 법", "AI"], now)).toEqual(["[수면] 빗소리 10시간"]);
  expect(trendPrompt(["[수면] 빗소리 10시간"], ["수면"])).toContain("위키백과 표제어 6개");
});

test("headwords are one per line with markers stripped and explanations dropped", () => {
  expect(parseHeadwords("1. 백색 잡음\n- **복리**\n수면 위생: 잠을 잘 자는 습관\n복리\nx")).toEqual([
    "백색 잡음",
    "복리",
  ]);
});
