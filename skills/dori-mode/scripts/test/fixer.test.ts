import { expect, test } from "bun:test";

import {
  type BriefPlaces,
  fixAction,
  fixButtons,
  huntFixBrief,
  huntFixKey,
  mentionedNumbers,
  parseFixPress,
  parseResult,
  pickCandidate,
  selfBrief,
  selfKey,
  sigOf,
} from "../src/fixer.ts";

test("one fault logged with other numbers, ids and links is one fault", () => {
  expect(sigOf("GET https://x.y/a?1 -> 415 at 12:03 id 9f8e7d6c5b")).toBe(
    sigOf("GET https://z/b -> 500 at 01:59 id aaaabbbbcc"),
  );
  expect(sigOf("창이 안 보임")).toBe("창이 안 보임");
});

test("the most frequent fault is picked, unless it was tried in the last week", () => {
  const now = Date.parse("2026-11-27T02:30:00Z");
  const c = [
    { sig: "a", source: "log", count: 3, evidence: [] },
    { sig: "b", source: "log", count: 9, evidence: [] },
  ];
  expect(pickCandidate(c, {}, now)?.sig).toBe("b");
  expect(pickCandidate(c, { b: "2026-11-25T02:30:00Z" }, now)?.sig).toBe("a");
  expect(pickCandidate(c, { b: "2026-11-01T02:30:00Z" }, now)?.sig).toBe("b");
  expect(pickCandidate([], {}, now)).toBeUndefined();
});

test("keys are lane keys: one self fix a day, one per hunted issue", () => {
  expect(selfKey(new Date("2026-11-27T02:30:00Z"))).toBe("fix-self-20261127");
  expect(huntFixKey("hunt-bun-49082")).toBe("fix-hunt-bun-49082");
});

const places: BriefPlaces = {
  key: "fix-self-20261127",
  worktree: "/w",
  branch: "fix/fix-self-20261127",
  base: "mine/discord-lane-answer",
  repo: "o/r",
  live: "/live",
  resultPath: "/s/fix-self-20261127.json",
};

test("the self brief carries the evidence, the worktree, the result file, and forbids merging", () => {
  const b = selfBrief({ sig: "s", source: "log x.err.log", count: 4, evidence: ["boom line"] }, places);
  expect(b).toContain("seen 4 time(s)");
  expect(b).toContain("    boom line");
  expect(b).toContain("/w on branch fix/fix-self-20261127");
  expect(b).toContain("--base discord-lane-answer");
  expect(b).toContain("/s/fix-self-20261127.json");
  expect(b).toContain("Never merge");
});

test("the hunt brief keeps the hunter's brief but never opens the upstream PR", () => {
  const b = huntFixBrief(
    [
      "# hunt-bun-1: oven-sh/bun#1",
      "Issue: https://github.com/oven-sh/bun/issues/1",
      "5. Open the PR from a fork branch, linking the issue.",
      "- the PR is open with green checks, or",
    ].join("\n"),
    "oven-sh/bun",
    {
      ...places,
      key: "fix-hunt-bun-1",
      resultPath: "/s/fix-hunt-bun-1.json",
    },
  );
  expect(b).toContain("DO NOT open the pull request");
  expect(b).toContain("## Hunter's brief: hunt-bun-1");
  expect(b).toContain("/s/fix-hunt-bun-1.pr.md");
  expect(b).not.toContain("Open the PR from a fork");
  expect(b).toContain("5. Push the branch to the fork. Do not open the PR");
  expect(b).toContain("the branch is pushed and the result file is written");
});

test("a result file is read only when it is whole and safe; the action follows from it", () => {
  const self = parseResult('{"kind":"self","summary":"고침","pr":"https://github.com/o/r/pull/7"}');
  expect(self && fixAction(self)).toBe("merge");
  const hunt = parseResult(
    '{"kind":"hunt","summary":"고침","repo":"oven-sh/bun","head":"me:claude/1-x","title":"t","bodyFile":"/b.md"}',
  );
  expect(hunt && fixAction(hunt)).toBe("open");
  const none = parseResult('{"kind":"self","summary":"재현 안 됨"}');
  expect(none && fixAction(none)).toBeUndefined();
  expect(parseResult('{"kind":"self","summary":"x","pr":"https://evil/pull/1"}')).toBeUndefined();
  expect(parseResult('{"kind":"hunt","summary":"x","repo":"a/b; rm -rf"}')).toBeUndefined();
  expect(parseResult("not json")).toBeUndefined();
  expect(parseResult('{"kind":"other","summary":"x"}')).toBeUndefined();
});

test("buttons: 합치기 or PR 올리기 with 버리기, and only 확인 when nothing changed; presses read back", () => {
  const self = parseResult('{"kind":"self","summary":"s","pr":"https://github.com/o/r/pull/7"}');
  const none = parseResult('{"kind":"self","summary":"s"}');
  expect(self && fixButtons("fix-self-1", self).map((b) => b.text)).toEqual(["합치기", "버리기"]);
  expect(none && fixButtons("fix-self-1", none).map((b) => b.text)).toEqual(["확인"]);
  expect(parseFixPress("fx:go:fix-self-20261127")).toEqual({ action: "go", key: "fix-self-20261127" });
  expect(parseFixPress("fx:go:../etc")).toBeUndefined();
  expect(parseFixPress("bl:go:x")).toBeUndefined();
});

test("the numbers an issue's comments mention, not its own, are where a claiming PR is looked for", () => {
  expect(
    mentionedNumbers(
      [{ body: "Fix in progress: #47648 removes that check" }, { body: "dup of #49082, see #47648" }],
      "49082",
    ),
  ).toEqual(["47648"]);
  expect(mentionedNumbers([{}], "1")).toEqual([]);
});
