/** dori hunt: unclaimed good-first-issues and bugs in the named (or configured) repositories, one lane brief each. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Command, die } from "./cli-context.ts";
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
