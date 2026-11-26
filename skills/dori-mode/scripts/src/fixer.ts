/**
 * The nightly fixer, the pure part. Once a night it picks one thing to fix and opens a lane for it: a fault of Dori's
 * own (a log line the incident scanner keeps seeing, a 맥손 task that failed) or, when there is none, an issue the
 * hunter picked. The lane fixes it in a branch of its own, runs the checks and writes a result file; it never merges
 * and never opens a pull request upstream. In the morning the owner decides by button: 합치기 merges Dori's own fix
 * and pulls it into the live folder, PR 올리기 opens the upstream pull request from the fork, 버리기 drops it.
 */

export type Candidate = {
  /** One fault, the same however often it was logged: the incident signature, or a 맥손 failure's text. */
  readonly sig: string;
  readonly source: string;
  readonly count: number;
  readonly evidence: readonly string[];
};

export type FixResult = {
  readonly kind: "self" | "hunt";
  /** One or two Korean sentences for the owner: what was wrong and what changed, or why nothing was changed. */
  readonly summary: string;
  /** Dori's own fix: the pull request into the live branch. */
  readonly pr?: string;
  /** An upstream fix: where the branch is and what the pull request will say. */
  readonly repo?: string;
  readonly head?: string;
  readonly title?: string;
  readonly bodyFile?: string;
};

export const FIX_PREFIX = "fix-";
/** A fault tried once is not tried again for this long, fixed or not. */
export const COOL_DAYS = 7;

const day = (now: Date): string => now.toISOString().slice(0, 10).replace(/-/g, "");
export const selfKey = (now: Date): string => `${FIX_PREFIX}self-${day(now)}`;
export const huntFixKey = (huntKey: string): string => `${FIX_PREFIX}${huntKey}`.slice(0, 60);

/** Numbers, ids and links change between two logs of one fault: they do not make another fault. */
export const sigOf = (text: string): string =>
  text
    .replace(/https?:\/\/\S+/g, "<url>")
    .replace(/[0-9a-f]{8,}/gi, "<id>")
    .replace(/\d+/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);

/** The most frequent fault not tried within COOL_DAYS. */
export const pickCandidate = (
  cands: readonly Candidate[],
  tried: Readonly<Record<string, string>>,
  now: number,
): Candidate | undefined =>
  [...cands]
    .filter((c) => !(now - Date.parse(tried[c.sig] ?? "") < COOL_DAYS * 86_400_000))
    .sort((a, b) => b.count - a.count || a.sig.localeCompare(b.sig))[0];

export type BriefPlaces = {
  readonly key: string;
  readonly worktree: string;
  readonly branch: string;
  readonly base: string;
  readonly repo: string;
  readonly live: string;
  readonly resultPath: string;
};

const resultSteps = (p: BriefPlaces, json: string): string[] => [
  `Before ready, write this JSON (one object) to ${p.resultPath}:`,
  `  ${json}`,
  "The summary is in plain Korean for the owner, one or two sentences.",
  `Then: {{dori}} ready ${p.key} --text '<summary>' --evidence <the PR or branch link, or ${p.resultPath}>`,
];

const NEVER = [
  "## Never",
  "- Never merge, never run `{{dori}} review` or `{{dori}} merge`: the owner merges by button in the morning.",
  "- Never touch the live folder or its branch; work only in the worktree above.",
  "- Never change prompts, the decision ledger (decisions.md), secrets or launchd jobs.",
  "- If no small, safe fix exists (the fault is outside the code, needs the owner, or you cannot reproduce it), do not",
  "  guess: write the result with no pr and say why in the summary.",
];

export const selfBrief = (c: Candidate, p: BriefPlaces): string =>
  [
    `# ${p.key}: Dori's own fault, found overnight`,
    "",
    `Source: ${c.source}, seen ${c.count} time(s) in the last day.`,
    "Evidence:",
    ...c.evidence.map((e) => `    ${e}`),
    "",
    "## Goal",
    "Find why this happens in Dori's code and fix it with a test, in a pull request the owner can merge in the morning.",
    "",
    "## Where",
    `- Worktree (already made, deps installed): ${p.worktree} on branch ${p.branch}, from ${p.base}.`,
    `- The live folder ${p.live} runs the services: read it if you like, never write there.`,
    "",
    "## Steps",
    "1. Read the code that logs this line; find the cause. Read the recent git log for related changes.",
    "2. Write a test that fails because of the cause, then the smallest fix. No unrelated changes.",
    "3. Run `bun run ci` in the worktree; it must pass.",
    `4. Commit (Korean message, why first), push the branch to remote mine, open a PR to ${p.repo} with base`,
    `   ${p.base.replace(/^mine\//, "")} (\`gh pr create --repo ${p.repo} --base ${p.base.replace(/^mine\//, "")} --head ${p.branch}\`), Korean title and body.`,
    ...resultSteps(p, `{"kind":"self","summary":"…","pr":"<PR url>"}`),
    "",
    ...NEVER,
    "",
  ].join("\n");

export const huntFixBrief = (huntBrief: string, issueRepo: string, p: BriefPlaces): string =>
  [
    `# ${p.key}: fix a hunted issue, the pull request waits for the owner`,
    "",
    "The hunter's brief follows. It is overridden in one point: DO NOT open the pull request. Push the branch to the",
    "fork and write the PR title and body to a file; the owner opens it by button in the morning.",
    "",
    huntBrief
      .replace(/^# /m, "## Hunter's brief: ")
      .replace(/^5\. Open the PR.*$/m, "5. Push the branch to the fork. Do not open the PR: the owner does, by button.")
      .replace(/the PR is open with green checks/, "the branch is pushed and the result file is written"),
    "",
    "## Where",
    `- Repository: ${p.worktree} (remote origin = ${issueRepo}, remote fork = the owner's fork). Fetch origin and`,
    `  branch ${p.branch} from ${p.base}; follow the repository's own rules (AGENTS.md, branch name prefix).`,
    "",
    "## At the end",
    `- Push ${p.branch} to remote fork. Write the PR body (Markdown, English, \`Fixes #N\`, reproduction, test) to`,
    `  ${p.resultPath.replace(/\.json$/, ".pr.md")}.`,
    ...resultSteps(
      p,
      `{"kind":"hunt","summary":"…","repo":"${issueRepo}","head":"<fork owner>:<branch>","title":"<PR title>","bodyFile":"${p.resultPath.replace(/\.json$/, ".pr.md")}"}`,
    ),
    "",
    ...NEVER,
    "",
  ].join("\n");

/** A lane's result file, checked: anything else is no result, and the morning shows no button for it. */
export const parseResult = (text: string): FixResult | undefined => {
  try {
    const o = JSON.parse(text) as Record<string, unknown>;
    const s = (k: string) =>
      typeof o[k] === "string" && (o[k] as string).trim() ? (o[k] as string).trim() : undefined;
    const kind = o["kind"] === "self" || o["kind"] === "hunt" ? o["kind"] : undefined;
    const summary = s("summary");
    if (!kind || !summary) return undefined;
    const pr = s("pr");
    if (pr && !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(pr)) return undefined;
    const repo = s("repo");
    if (repo && !/^[\w.-]+\/[\w.-]+$/.test(repo)) return undefined;
    const head = s("head");
    if (head && !/^[\w.-]+:[\w./-]+$/.test(head)) return undefined;
    const pick = { pr, repo, head, title: s("title"), bodyFile: s("bodyFile") };
    return {
      kind,
      summary,
      ...Object.fromEntries(Object.entries(pick).filter(([, v]) => v !== undefined)),
    } as FixResult;
  } catch {
    return undefined;
  }
};

/** What 합치기 / PR 올리기 can do with a result: nothing when the lane made no change. */
export const fixAction = (r: FixResult): "merge" | "open" | undefined =>
  r.kind === "self" && r.pr
    ? "merge"
    : r.kind === "hunt" && r.repo && r.head && r.title && r.bodyFile
      ? "open"
      : undefined;

export const fixCallback = (action: "go" | "drop", key: string): string => `fx:${action}:${key}`;
export const parseFixPress = (data: string | undefined): { action: "go" | "drop"; key: string } | undefined => {
  const m = /^fx:(go|drop):(fix-[a-z0-9-]+)$/.exec(data ?? "");
  return m?.[1] && m[2] ? { action: m[1] as "go" | "drop", key: m[2] } : undefined;
};

export const fixLine = (key: string, r: FixResult): string =>
  `${key}: ${r.summary}${r.pr ? ` ${r.pr}` : ""}${r.kind === "hunt" && r.repo ? ` (${r.repo})` : ""}`;

export const fixButtons = (key: string, r: FixResult): { text: string; callback_data: string }[] => {
  const a = fixAction(r);
  return [
    ...(a ? [{ text: a === "merge" ? "합치기" : "PR 올리기", callback_data: fixCallback("go", key) }] : []),
    { text: a ? "버리기" : "확인", callback_data: fixCallback("drop", key) },
  ];
};
