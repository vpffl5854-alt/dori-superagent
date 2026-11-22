/**
 * The issue hunter: picks open, unclaimed good-first-issues and bugs from the repositories it is
 * given and writes one lane brief per pick (reproduce, failing test, fix, PR). It only reads issues;
 * opening the PR is the lane's work under the usual review and merge gate.
 */
export type GhIssue = {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly updatedAt: string;
  readonly labels: readonly { readonly name: string }[];
  readonly assignees: readonly unknown[];
  readonly comments: readonly unknown[];
  readonly closedByPullRequestsReferences?: readonly unknown[];
};

export const ISSUE_FIELDS = "number,title,url,updatedAt,labels,assignees,comments,closedByPullRequestsReferences";

export type Pick = { readonly repo: string; readonly issue: GhIssue; readonly score: number; readonly why: string };

const GOOD_FIRST = /good[\s-]?first[\s-]?issue|beginner|easy|starter/i;
const BUG = /^bug$|type:\s*bug|kind\/bug|\bbug\b/i;
const HELP = /help[\s-]?wanted/i;
/** A label that says the issue is not open for a fix (waiting, declined, a question, a duplicate). */
const BLOCKED =
  /wontfix|won't fix|duplicate|invalid|question|needs[\s-]?(?:triage|info|design|decision)|blocked|discussion/i;

/** Lanes run on a Mac: an issue that only happens on another OS cannot be reproduced, so it is never a pick. */
const OTHER_OS =
  /^\s*\[?(?:windows|win32|linux|android|ios)\b|\bon windows\b|\bwindows only\b|^platform:\s*(?:windows|linux)|^os:\s*(?:windows|linux)|^windows$|^linux$|\b(?:linux|windows)[ -](?:x64|x86_64|arm64|aarch64)\b/i;

/** Pickable: nobody assigned, no PR already closing it, a good-first-issue or bug label, nothing blocking. */
export const scoreIssue = (issue: GhIssue, now: number): { score: number; why: string } | null => {
  const names = issue.labels.map((l) => l.name);
  if (issue.assignees.length > 0 || (issue.closedByPullRequestsReferences?.length ?? 0) > 0) return null;
  if (names.some((n) => BLOCKED.test(n))) return null;
  if (OTHER_OS.test(issue.title) || names.some((n) => OTHER_OS.test(n))) return null;
  const good = names.some((n) => GOOD_FIRST.test(n));
  const bug = names.some((n) => BUG.test(n));
  if (!good && !bug) return null;
  const help = names.some((n) => HELP.test(n));
  const ageDays = (now - Date.parse(issue.updatedAt)) / 86_400_000;
  // Fewer comments means less disagreement to read; a long-quiet issue may be stale or already fixed.
  const score =
    (good ? 3 : 0) + (bug ? 2 : 0) + (help ? 1 : 0) - Math.min(2, issue.comments.length / 5) - (ageDays > 180 ? 1 : 0);
  const why = [good && "good-first-issue", bug && "bug", help && "help-wanted"].filter(Boolean).join("+");
  return { score: Math.round(score * 10) / 10, why };
};

export const pickIssues = (repo: string, issues: readonly GhIssue[], now: number, limit: number): Pick[] =>
  issues
    .flatMap((issue) => {
      const s = scoreIssue(issue, now);
      return s ? [{ repo, issue, ...s }] : [];
    })
    .sort((a, b) => b.score - a.score || a.issue.number - b.issue.number)
    .slice(0, limit);

export const huntLine = (p: Pick): string =>
  `HUNT ${p.repo}#${p.issue.number} score=${p.score} ${p.why} ${JSON.stringify(p.issue.title)}`;

/** A lane key for the pick: lowercase, LANE_KEY-safe, unique per repo and issue. */
export const huntKey = (p: Pick): string =>
  `hunt-${p.repo
    .split("/")
    .pop()
    ?.toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")}-${p.issue.number}`.slice(0, 60);

export const huntBrief = (p: Pick): string =>
  [
    `# ${huntKey(p)}: ${p.repo}#${p.issue.number}`,
    "",
    `Issue: ${p.issue.url}`,
    `Title: ${p.issue.title}`,
    "",
    "## Goal",
    "Fix this issue with a pull request the maintainers can merge.",
    "",
    "## Steps",
    "1. Read the issue and every comment, and the repo's CONTRIBUTING / README test instructions.",
    "2. Reproduce it on the default branch. If it does not reproduce, stop and report what you ran and saw.",
    "3. Write a test that fails because of the issue, then the smallest fix that makes it pass.",
    "4. Run the repo's full test and lint commands; all green before any PR.",
    "5. Open the PR from a fork branch, linking the issue (`Fixes #N`), with the reproduction and the test.",
    "",
    "## Stop when",
    "- the PR is open with green checks, or",
    "- the issue does not reproduce, is already fixed, or someone else claimed it meanwhile (report, no PR).",
    "",
    "## Constraints",
    "- Never push to the upstream repository; only to a fork.",
    "- No unrelated changes, no formatting sweeps, no new dependencies unless the fix needs one.",
    "- Do not comment on the issue or ping maintainers without the lead's go-ahead.",
    "",
  ].join("\n");
