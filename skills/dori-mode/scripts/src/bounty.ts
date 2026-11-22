/**
 * Bounty hunting ("돈 버는 법"): open GitHub issues that pay for a fix (the Algora `💎 Bounty` label), kept only when
 * a lane on a Mac could really win one: a real project (stars, recent pushes, not archived), unclaimed and unlinked, an
 * actual bug or feature rather than open research, and not tied to another OS. Picks are reported to the owner; work
 * starts only when he says so, because claiming a bounty speaks for him on someone else's repository.
 */
export type BountyIssue = {
  readonly repository: { readonly nameWithOwner: string };
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly updatedAt: string;
  readonly commentsCount: number;
  readonly labels: readonly { readonly name: string }[];
};

export type RepoInfo = {
  readonly stars: number;
  readonly archived: boolean;
  readonly pushedAt: string;
  readonly openIssues: number;
};

export const MIN_STARS = 20;
/** Real bounties draw dozens of /attempt comments within days (34 to 119 seen on 2026-11-22); past this it is lost. */
export const MAX_COMMENTS = 20;
export const PER_REPO = 2;
const DAY = 86_400_000;

/** Not a task to win: open research, discussion, on hold, or already paid ("💰 Rewarded"). */
const NOT_A_TASK = /wildcard|research|discussion|proposal|question|rfc|design|duplicate|wontfix|rewarded|on[-\s]?hold/i;
const OTHER_OS = /\b(?:windows|linux|android|ios)\b[:\s-]|\b(?:linux|windows)[ -](?:x64|arm64)\b/i;

/** The dollar amount from a label ("$250"), the title ("[$100]") or a bounty bot comment, or null. */
export const amountOf = (texts: readonly string[]): number | null => {
  for (const t of texts) {
    const m = /\$\s?(\d[\d,]*)(?:\.\d+)?\s*(k)?\b/i.exec(t);
    if (m?.[1]) return Number(m[1].replaceAll(",", "")) * (m[2] ? 1000 : 1);
  }
  return null;
};

export const keepIssue = (i: BountyIssue, now: number): boolean =>
  i.commentsCount <= MAX_COMMENTS &&
  now - Date.parse(i.updatedAt) <= 60 * DAY &&
  !i.labels.some((l) => NOT_A_TASK.test(l.name)) &&
  !NOT_A_TASK.test(i.title.slice(0, 20)) &&
  !OTHER_OS.test(i.title);

/**
 * Bait repositories exist to farm AI bounty agents (seen 2026-11-22: a months-old repo with 10,000 open "$780"
 * security issues and 971 forks). A repo named for bounties or tests, or with far more open issues than stars, is one.
 */
const BAIT_NAME = /bount|hunter|test[-_]?target|livefire|bug[-_]?bounty|clanker/i;
export const isBait = (name: string, r: RepoInfo): boolean =>
  BAIT_NAME.test(name) || r.openIssues > Math.max(3000, r.stars * 10);

export const keepRepo = (name: string, r: RepoInfo | null, now: number): boolean =>
  !!r && !r.archived && r.stars >= MIN_STARS && now - Date.parse(r.pushedAt) <= 45 * DAY && !isBait(name, r);

export type Bounty = { readonly issue: BountyIssue; readonly amount: number | null; readonly stars: number };

/** Highest pay first (unknown pay last), then the busier project; at most PER_REPO per repository. */
export const rankBounties = (found: readonly Bounty[], limit: number): Bounty[] => {
  const perRepo = new Map<string, number>();
  return [...found]
    .sort((a, b) => (b.amount ?? -1) - (a.amount ?? -1) || b.stars - a.stars)
    .filter((b) => {
      const r = b.issue.repository.nameWithOwner;
      const n = perRepo.get(r) ?? 0;
      perRepo.set(r, n + 1);
      return n < PER_REPO;
    })
    .slice(0, limit);
};

export const bountyKey = (b: Bounty): string =>
  `bounty-${b.issue.repository.nameWithOwner
    .split("/")
    .pop()
    ?.toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")}-${b.issue.number}`.slice(0, 60);

export const bountyBrief = (b: Bounty): string =>
  [
    `# ${bountyKey(b)}: ${b.issue.repository.nameWithOwner}#${b.issue.number}${b.amount ? ` ($${b.amount})` : ""}`,
    "",
    `Issue: ${b.issue.url}`,
    `Title: ${b.issue.title}`,
    "",
    "## Before any work",
    "1. Read the issue, every comment and the repo's bounty rules (Algora: an `/attempt` comment claims it; some repos want a proposal first).",
    "2. If someone already has a strong attempt or a PR in review, stop and report: competing is wasted work.",
    "3. Claim it (`/attempt #N` or what the rules ask) only after the lead confirms the owner said yes.",
    "",
    "## Work",
    "Reproduce on the default branch, write a failing test, make the smallest fix, run the repo's full tests and lint, and open the PR from a fork with `/claim #N` (or the repo's wording) and the reproduction.",
    "",
    "## Stop when",
    "- the PR is open with green checks, or",
    "- it does not reproduce, is already fixed, or someone else won it (report, no PR).",
    "",
    "## Constraints",
    "- Never push to the upstream repository; a fork only. No unrelated changes.",
    "- Never open more than one PR for a bounty, and never post on the issue beyond the claim and the PR link.",
    "",
  ].join("\n");

export const bountyLine = (b: Bounty): string =>
  `BOUNTY ${b.issue.repository.nameWithOwner}#${b.issue.number} ${b.amount ? `$${b.amount}` : "$?"} stars=${b.stars} ${JSON.stringify(b.issue.title)}`;
