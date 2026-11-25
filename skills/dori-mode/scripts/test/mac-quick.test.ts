import { expect, test } from "bun:test";

import { parseQuick, volumeScript } from "../src/mac-quick.ts";

test("quick commands are read from plain Korean; anything else is left to the head", () => {
  expect(parseQuick("화면 보여줘")).toEqual({ kind: "screen" });
  expect(parseQuick("스크린샷 찍어줘")).toEqual({ kind: "screen" });
  expect(parseQuick("볼륨 30%")).toEqual({ kind: "volume", set: 30 });
  expect(parseQuick("소리 좀 줄여")).toEqual({ kind: "volume", by: -15 });
  expect(parseQuick("볼륨 올려줘")).toEqual({ kind: "volume", by: 15 });
  expect(parseQuick("음소거")).toEqual({ kind: "mute", on: true });
  expect(parseQuick("음소거 해제")).toEqual({ kind: "mute", on: false });
  expect(parseQuick("사파리 열어줘")).toEqual({ kind: "open", app: "사파리" });
  expect(parseQuick("메모 앱 켜")).toEqual({ kind: "open", app: "메모" });
  expect(parseQuick("계산기로 6 곱하기 7 해줘")).toBeUndefined();
  expect(parseQuick("메모 앱에서 새 메모 만들고 열어줘")).toBeUndefined();
  expect(parseQuick("볼륨이 왜 이래")).toBeUndefined();
});

test("volume changes stay between 0 and 100", () => {
  expect(volumeScript({ kind: "volume", by: 15 }, 95)).toBe("set volume output volume 100");
  expect(volumeScript({ kind: "volume", by: -15 }, 10)).toBe("set volume output volume 0");
  expect(volumeScript({ kind: "volume", set: 30 }, 80)).toBe("set volume output volume 30");
  expect(volumeScript({ kind: "mute", on: true }, 50)).toBe("set volume output muted true");
});
