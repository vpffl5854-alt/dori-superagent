import { expect, test } from "bun:test";

import { riskyCommits, syncBrief, syncKey, syncMessage } from "../src/upstream.ts";

const commits = [
  "chore(deps): Bun 1.4.5 and dependencies to latest (#270)",
  'Revert "feat(dori-mode): gateway surface (#255)" (#262)',
  "feat(install): install Doriterm (#258)",
];

test("being level with the original says nothing", () => {
  expect(syncMessage({ kind: "level" }, "k")).toBeNull();
});

test("a clean green merge asks the owner to apply it, and names reverts as worth a look", () => {
  const text = syncMessage({ kind: "ready", branch: "upstream-395149b1", commits }, "upstream-395149b1") ?? "";
  expect(text).toContain("새 변경 3개");
  expect(text).toContain("전체 테스트 통과");
  expect(text).toContain("upstream-395149b1");
  expect(text).toContain("주의할 변경 1개");
  expect(riskyCommits(commits)).toEqual([commits[1] ?? ""]);
});

test("a conflict lists the files and asks before a lane starts", () => {
  const text = syncMessage({ kind: "conflict", files: ["package.json", "src/a.ts"], commits }, "upstream-1") ?? "";
  expect(text).toContain("충돌 2곳: package.json, src/a.ts");
  expect(text).toContain('"ㅇㅇ"');
});

test("the lane's brief keeps the live checkout untouched and leaves applying to the owner's yes", () => {
  const brief = syncBrief({ kind: "conflict", files: ["package.json"], commits }, "upstream-1", "origin/main");
  expect(brief).toContain("라이브 체크아웃(~/dori-superagent)은 건드리지 말고");
  expect(brief).toContain("bun run ci");
  expect(brief).toContain("지브 승인 뒤");
  expect(syncKey("395149b1abcdef")).toBe("upstream-395149b1");
});
