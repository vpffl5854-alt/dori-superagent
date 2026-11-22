import { expect, test } from "bun:test";

import {
  amountOf,
  type Bounty,
  bountyBrief,
  bountyKey,
  isBait,
  keepIssue,
  keepRepo,
  rankBounties,
} from "../src/bounty.ts";

const NOW = Date.parse("2026-11-22T00:00:00Z");
const issue = (repo: string, n: number, extra: Record<string, unknown> = {}) => ({
  repository: { nameWithOwner: repo },
  number: n,
  title: `fix thing ${n}`,
  url: `https://github.com/${repo}/issues/${n}`,
  updatedAt: "2026-11-20T00:00:00Z",
  commentsCount: 3,
  labels: [{ name: "💎 Bounty" }],
  ...extra,
});
const repo = { stars: 500, archived: false, pushedAt: "2026-11-15T00:00:00Z", openIssues: 100 };

test("the pay is read from a label, the title or a bounty bot comment", () => {
  expect(amountOf(["💎 Bounty", "$250"])).toBe(250);
  expect(amountOf(["[$1,500] add export"])).toBe(1500);
  expect(amountOf(["💎 **$2k** bounty"])).toBe(2000);
  expect(amountOf(["no money here"])).toBeNull();
});

test("crowded, paid, on-hold, research and other-OS issues are not worth a lane", () => {
  expect(keepIssue(issue("o/r", 1), NOW)).toBe(true);
  expect(keepIssue(issue("o/r", 2, { commentsCount: 84 }), NOW)).toBe(false);
  expect(keepIssue(issue("o/r", 3, { labels: [{ name: "💎 Bounty" }, { name: "💰 Rewarded" }] }), NOW)).toBe(false);
  expect(keepIssue(issue("o/r", 4, { labels: [{ name: "on-hold" }] }), NOW)).toBe(false);
  expect(keepIssue(issue("o/r", 5, { title: "[wildcard] invent a compiler" }), NOW)).toBe(false);
  expect(keepIssue(issue("o/r", 6, { title: "Windows: path breaks" }), NOW)).toBe(false);
});

test("bait repositories that farm AI agents are skipped, real ones kept", () => {
  expect(isBait("SecureBananaLabs/bug-bounty", { ...repo, stars: 347, openIssues: 10234 })).toBe(true);
  expect(isBait("UnsafeLabs/Bounty-Hunters", repo)).toBe(true);
  expect(isBait("acme/app", { ...repo, stars: 100, openIssues: 5000 })).toBe(true);
  expect(keepRepo("highlight/highlight", { ...repo, stars: 9393, openIssues: 593 }, NOW)).toBe(true);
  expect(keepRepo("acme/old", { ...repo, pushedAt: "2025-07-01T00:00:00Z" }, NOW)).toBe(false);
  expect(keepRepo("acme/archived", { ...repo, archived: true }, NOW)).toBe(false);
});

test("best pay first, at most two per repository, and a brief that waits for the owner's yes", () => {
  const b = (r: string, n: number, amount: number | null): Bounty => ({ issue: issue(r, n), amount, stars: 100 });
  const ranked = rankBounties(
    [b("a/x", 1, 50), b("a/x", 2, 500), b("a/x", 3, 300), b("c/y", 4, null), b("d/z", 5, 100)],
    4,
  );
  expect(ranked.map((x) => `${x.issue.repository.nameWithOwner}#${x.issue.number}`)).toEqual([
    "a/x#2",
    "a/x#3",
    "d/z#5",
    "c/y#4",
  ]);
  expect(bountyKey(ranked[0]!)).toBe("bounty-x-2");
  expect(bountyBrief(ranked[0]!)).toContain("only after the lead confirms the owner said yes");
});
