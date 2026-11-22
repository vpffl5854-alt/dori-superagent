/** dori hunt: unclaimed good-first-issues and bugs in the named (or configured) repositories, one lane brief each. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  amountOf,
  type Bounty,
  type BountyIssue,
  bountyBrief,
  bountyKey,
  bountyLine,
  keepIssue,
  keepRepo,
  type RepoInfo,
  rankBounties,
} from "./bounty.ts";
import type { IncidentsConfig } from "./cli-incidents.ts";
import { type Command, die } from "./cli-context.ts";
import { fill } from "./config.ts";
import { type GhIssue, huntBrief, huntKey, huntLine, ISSUE_FIELDS, pickIssues } from "./hunt.ts";
import { run } from "./run.ts";

const PICKS_PER_REPO = 3;

const hunt: Command = async ({ positionals, values, config }) => {
  const repos = positionals.length > 0 ? positionals : config.huntRepos;
  if (repos.length === 0) die("hunt needs owner/repo arguments or config huntRepos");
  const dir = join(config.stateDir, "hunt");
  for (const repo of repos) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) die(`not an owner/repo: ${repo}`);
    const r = await run([
      "gh",
      "issue",
      "list",
      "-R",
      repo,
      "--state",
      "open",
      "--limit",
      "100",
      "--json",
      ISSUE_FIELDS,
    ]);
    if (r.code !== 0) {
      console.log(`HUNT_FAILED ${repo} ${JSON.stringify(r.err.trim().slice(0, 200))}`);
      continue;
    }
    const picks = pickIssues(repo, JSON.parse(r.out) as GhIssue[], Date.now(), PICKS_PER_REPO);
    if (picks.length === 0) console.log(`HUNT_NONE ${repo}`);
    for (const p of picks) {
      console.log(huntLine(p));
      if (values["write"] !== true) continue;
      mkdirSync(dir, { recursive: true });
      const path = join(dir, `${huntKey(p)}.md`);
      writeFileSync(path, huntBrief(p));
      console.log(`HUNT_BRIEF ${huntKey(p)} ${path}`);
    }
  }
};

export const huntCommands: Readonly<Record<string, Command>> = { hunt };

const LANGUAGES = ["typescript", "javascript", "python"] as const;
const BOUNTY_FIELDS = "repository,number,title,url,updatedAt,commentsCount,labels";

/** `bounty [--report]`: paying issues a Mac lane could win; with --report, new ones go to the owner, lead and backlog. */
const bounty: Command = async ({ values, config }) => {
  const now = Date.now();
  const found = new Map<string, BountyIssue>();
  for (const lang of LANGUAGES) {
    const r = await run(
      [
        "gh",
        "search",
        "issues",
        "--label",
        "💎 Bounty",
        "--state",
        "open",
        "--no-assignee",
        "--language",
        lang,
        "--sort",
        "updated",
        "--limit",
        "100",
        "--json",
        BOUNTY_FIELDS,
      ],
      { timeoutMs: 60_000 },
    );
    if (r.code !== 0) continue;
    for (const i of JSON.parse(r.out) as BountyIssue[]) if (keepIssue(i, now)) found.set(i.url, i);
  }
  const repos = new Map<string, RepoInfo | null>();
  const candidates: Bounty[] = [];
  for (const i of found.values()) {
    const name = i.repository.nameWithOwner;
    if (!repos.has(name)) {
      const r = await run(
        [
          "gh",
          "api",
          `repos/${name}`,
          "--jq",
          "{stars: .stargazers_count, archived: .archived, pushedAt: .pushed_at, openIssues: .open_issues_count}",
        ],
        { timeoutMs: 30_000 },
      );
      repos.set(name, r.code === 0 ? (JSON.parse(r.out) as RepoInfo) : null);
    }
    const repo = repos.get(name) ?? null;
    if (keepRepo(name, repo, now))
      candidates.push({
        issue: i,
        amount: amountOf([...i.labels.map((l) => l.name), i.title]),
        stars: repo?.stars ?? 0,
      });
  }
  // The pay is often only in the bounty bot's comment: read it for the ones without an amount yet.
  const withPay = await Promise.all(
    rankBounties(candidates, 12).map(async (b) => {
      if (b.amount !== null) return b;
      const r = await run(
        [
          "gh",
          "api",
          `repos/${b.issue.repository.nameWithOwner}/issues/${b.issue.number}/comments`,
          "--jq",
          '.[] | select(.user.login | test("algora"; "i")) | .body',
        ],
        { timeoutMs: 30_000 },
      );
      return { ...b, amount: r.code === 0 ? amountOf([r.out]) : null };
    }),
  );
  const picks = rankBounties(withPay, 5);
  for (const b of picks) console.log(bountyLine(b));
  if (picks.length === 0) console.log("BOUNTY_NONE");
  if (values["report"] !== true) return;
  const statePath = join(config.stateDir, "bounty-seen.json");
  const seen = new Set<string>(existsSync(statePath) ? (JSON.parse(readFileSync(statePath, "utf8")) as string[]) : []);
  const fresh = picks.filter((b) => !seen.has(b.issue.url)).slice(0, 3);
  const cfg = (config as { incidents?: IncidentsConfig }).incidents ?? {};
  const dir = join(config.stateDir, "bounty");
  mkdirSync(dir, { recursive: true });
  for (const b of fresh) {
    const key = bountyKey(b);
    const brief = join(dir, `${key}.md`);
    writeFileSync(brief, bountyBrief(b));
    if (cfg.harness?.length)
      await run(
        [
          ...cfg.harness,
          "backlog",
          "add",
          key,
          "--brief",
          brief,
          "--title",
          `${key} ${b.amount ? `$${b.amount}` : ""}`,
          "--priority",
          "6",
        ],
        { timeoutMs: 60_000 },
      );
    const text = `💰 [현상금] ${b.amount ? `$${b.amount}` : "금액 미상"} · ${b.issue.repository.nameWithOwner} (⭐${b.stars})\n${b.issue.title}\n${b.issue.url}\n도전할까? 지브가 "ㅇㅇ"하면 리드가 레인을 연다 (${key}). 경쟁이 있어 못 받을 수도 있다.`;
    for (const argv of [cfg.notifyArgv, cfg.leadArgv])
      if (argv?.length) await run(fill(argv, { text }), { timeoutMs: 60_000 });
    seen.add(b.issue.url);
    console.log(`BOUNTY_REPORTED ${key}`);
  }
  writeFileSync(statePath, JSON.stringify([...seen]));
};

export const bountyCommands: Readonly<Record<string, Command>> = { bounty };
