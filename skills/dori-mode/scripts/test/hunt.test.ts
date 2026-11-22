import { expect, test } from "bun:test";

import { type GhIssue, huntBrief, huntKey, huntLine, pickIssues, scoreIssue } from "../src/hunt.ts";
import { LANE_KEY } from "../src/registry.ts";

const NOW = Date.parse("2026-11-22T00:00:00Z");

const issue = (number: number, labels: string[], extra: Partial<GhIssue> = {}): GhIssue => ({
  number,
  title: `issue ${number}`,
  url: `https://github.com/o/r/issues/${number}`,
  updatedAt: "2026-11-20T00:00:00Z",
  labels: labels.map((name) => ({ name })),
  assignees: [],
  comments: [],
  closedByPullRequestsReferences: [],
  ...extra,
});

test("a good first issue outranks a plain bug, and help-wanted adds to either", () => {
  expect(scoreIssue(issue(1, ["good first issue"]), NOW)).toEqual({ score: 3, why: "good-first-issue" });
  expect(scoreIssue(issue(2, ["bug"]), NOW)).toEqual({ score: 2, why: "bug" });
  expect(scoreIssue(issue(3, ["type: bug", "help wanted"]), NOW)).toEqual({ score: 3, why: "bug+help-wanted" });
});

test("assigned, already-fixed, blocked or unlabelled issues are never picked", () => {
  expect(scoreIssue(issue(1, ["bug"], { assignees: [{}] }), NOW)).toBeNull();
  expect(scoreIssue(issue(2, ["bug"], { closedByPullRequestsReferences: [{}] }), NOW)).toBeNull();
  expect(scoreIssue(issue(3, ["bug", "needs triage"]), NOW)).toBeNull();
  expect(scoreIssue(issue(4, ["bug", "wontfix"]), NOW)).toBeNull();
  expect(scoreIssue(issue(5, ["enhancement"]), NOW)).toBeNull();
});

test("a long thread and a long silence lower the score", () => {
  expect(scoreIssue(issue(1, ["bug"], { comments: Array(5).fill({}) }), NOW)?.score).toBe(1);
  expect(scoreIssue(issue(2, ["bug"], { updatedAt: "2026-01-01T00:00:00Z" }), NOW)?.score).toBe(1);
});

test("picks are ranked by score, then the older issue number, and capped", () => {
  const picks = pickIssues("o/r", [issue(9, ["bug"]), issue(7, ["bug"]), issue(8, ["good first issue"])], NOW, 2);
  expect(picks.map((p) => p.issue.number)).toEqual([8, 7]);
  expect(huntLine(picks[0]!)).toBe('HUNT o/r#8 score=3 good-first-issue "issue 8"');
});

test("the lane key is a valid lane key and the brief carries the issue and the never-push-upstream rule", () => {
  const [p] = pickIssues("Some.Org/My_Repo", [issue(42, ["bug"])], NOW, 1);
  expect(huntKey(p!)).toBe("hunt-my-repo-42");
  expect(LANE_KEY.test(huntKey(p!))).toBe(true);
  const brief = huntBrief(p!);
  expect(brief).toContain("Issue: https://github.com/o/r/issues/42");
  expect(brief).toContain("Never push to the upstream repository");
  expect(brief).toContain("does not reproduce");
});
