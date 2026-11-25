import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { prompt, type Deps } from "./harness.ts";
import { Refusal } from "./refusal.ts";
import { loadHooks, substitute } from "./hooks.ts";
import { scanVerdicts } from "./verdict.ts";
import type { MergeOutcome } from "./telemetry.ts";

export type PrRef = { repo: string; number: number; id: string };

export function parsePr(s: string): PrRef {
  const m = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(s);
  if (!m) throw new Refusal(`PR must look like owner/repo#123, got ${s}`);
  return { repo: m[1]!, number: Number(m[2]), id: s };
}

async function gh(d: Deps, argv: readonly string[]): Promise<string> {
  const r = await d.exec("gh", argv);
  if (r.code !== 0) throw new Error(`gh ${argv.join(" ")} failed: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout;
}

export async function headSha(d: Deps, pr: PrRef): Promise<string> {
  const out = JSON.parse(await gh(d, ["pr", "view", String(pr.number), "--repo", pr.repo, "--json", "headRefOid"]));
  return String(out.headRefOid);
}

/** Runs a fresh, non-interactive reviewer session pinned to the PR head and records its verdict as a receipt. */
export async function review(
  d: Deps,
  prId: string,
  model?: string,
): Promise<{ verdict: "CLEAR" | "BLOCK"; sha: string }> {
  const pr = parsePr(prId);
  const sha = await headSha(d, pr);
  const release = d.store.lockReceipt(pr.id, sha, d.now());
  if (!release) throw new Refusal(`a review or merge is already in progress at head ${sha.slice(0, 12)}`);
  try {
    // Clear first: an in-flight, interrupted or failed attempt at this head must never stay merge-eligible.
    d.store.clearReceipt(pr.id, sha);
    // hooks.reviewCommand replaces the built-in reviewer; it must print a VERDICT line like the built-in one.
    const hook = loadHooks(d.store.root).reviewCommand;
    const vars = { pr: pr.id, repo: pr.repo, number: String(pr.number), sha };
    const text = prompt("review.md", vars);
    const [cmd, ...argv] = hook
      ? substitute(hook, { ...vars, text })
      : [d.agentCmd, "-p", "--no-session", ...(model ? ["--model", model] : []), text];
    const res = await d.exec(cmd ?? d.agentCmd, argv);
    const scan = scanVerdicts(res.stdout);
    if (res.code !== 0 || scan.kind !== "verdict") {
      const name = `${pr.id.replaceAll("/", "__").replace("#", "_")}@${sha}-${randomUUID()}.noverdict.txt`;
      const diagnostic = join(d.store.root, "receipts", name);
      writeFileSync(diagnostic, res.stdout.split(/\r?\n/).slice(-200).join("\n"), { flag: "wx", mode: 0o600 });
      const reason =
        res.code !== 0
          ? `reviewer exited ${res.code}${res.stderr.trim() ? `: ${res.stderr.trim()}` : ""}`
          : scan.kind === "ambiguous"
            ? `reviewer printed conflicting verdicts (${scan.values.join(" and ")})`
            : "reviewer printed no VERDICT line";
      throw new Error(`${reason}; no receipt written; reviewer output saved to ${diagnostic}`);
    }
    const verdict = scan.verdict;
    d.store.saveReceipt({
      pr: pr.id,
      sha,
      verdict,
      model: hook ? "hook" : (model ?? "default"),
      at: d.now(),
      summary: res.stdout.trim().slice(-4000),
    });
    d.usage.record({ name: "dori.review_completed", verdict });
    return { verdict, sha };
  } finally {
    release();
  }
}

type Check = { name: string; bucket: string };

/** Merge only when the exact current head has a CLEAR review receipt and every check passed. An empty check list is never green. */
export async function mergeGate(d: Deps, prId: string, opts: { dryRun?: boolean } = {}): Promise<string> {
  const pr = parsePr(prId);
  const sha = await headSha(d, pr);
  const release = d.store.lockReceipt(pr.id, sha, d.now());
  if (!release) {
    if (!opts.dryRun) d.usage.record({ name: "dori.merge_decided", outcome: "review_in_progress" });
    throw new Refusal(
      `MERGE_REFUSED review_in_progress: a review or merge is already in progress at head ${sha.slice(0, 12)}`,
    );
  }
  try {
    const refused = await gateRefusal(d, pr, sha);
    if (refused) {
      if (!opts.dryRun) d.usage.record({ name: "dori.merge_decided", outcome: refused[0] });
      throw new Refusal(`MERGE_REFUSED ${refused[1]}`);
    }
    if (opts.dryRun) return `MERGE_OK ${pr.id} head=${sha} (dry run)`;
    await gh(d, ["pr", "merge", String(pr.number), "--repo", pr.repo, "--squash", "--match-head-commit", sha]);
    d.usage.record({ name: "dori.merge_decided", outcome: "merged" });
    return `MERGED ${pr.id} head=${sha}`;
  } finally {
    release();
  }
}

async function gateRefusal(d: Deps, pr: PrRef, sha: string): Promise<[MergeOutcome, string] | undefined> {
  const receipt = d.store.receipt(pr.id, sha);
  if (!receipt) return ["no_receipt", `no review receipt at head ${sha.slice(0, 12)} (run: dori review ${pr.id})`];
  if (receipt.verdict !== "CLEAR") return ["review_block", `review at ${sha.slice(0, 12)} is ${receipt.verdict}`];
  const checksRes = await d.exec("gh", ["pr", "checks", String(pr.number), "--repo", pr.repo, "--json", "name,bucket"]);
  const checks: Check[] = checksRes.stdout.trim().startsWith("[") ? JSON.parse(checksRes.stdout) : [];
  if (checks.length === 0) return ["no_checks", "no checks reported: an empty check list is never green"];
  const bad = checks.filter((c) => c.bucket !== "pass" && c.bucket !== "skipping");
  if (bad.length > 0) return ["checks_red", `checks not green: ${bad.map((c) => `${c.name}=${c.bucket}`).join(", ")}`];
  if (!checks.some((c) => c.bucket === "pass")) return ["checks_all_skipped", "every check was skipped"];
  return workflowRefusal(d, pr, sha);
}

type WorkflowRun = {
  id: number;
  workflow_id: number;
  name?: string | undefined;
  head_sha: string;
  event: string;
  status: string;
  conclusion: string | null;
};

// The same green the check list uses: a neutral run is a skip in gh's buckets, anything else is not green.
const GREEN_CONCLUSIONS: ReadonlySet<string> = new Set(["success", "skipped", "neutral"]);

/** One page of workflow runs for the exact head, refusing every entry whose shape would let a run slip past unread. */
function parseWorkflowRuns(json: string): WorkflowRun[] {
  const page = JSON.parse(json) as { total_count?: unknown; workflow_runs?: unknown };
  if (typeof page.total_count !== "number" || !Array.isArray(page.workflow_runs)) {
    throw new Error("response has no workflow_runs list");
  }
  if (page.total_count > page.workflow_runs.length) {
    throw new Error(`only ${page.workflow_runs.length} of ${page.total_count} runs returned`);
  }
  return page.workflow_runs.map((raw: unknown, i: number) => {
    const run = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
    const { id, workflow_id, name, head_sha, event, status, conclusion } = run;
    const bad = [
      typeof id === "number" ? "" : "id",
      typeof workflow_id === "number" ? "" : "workflow_id",
      typeof head_sha === "string" ? "" : "head_sha",
      typeof event === "string" ? "" : "event",
      typeof status === "string" ? "" : "status",
      conclusion === null || typeof conclusion === "string" ? "" : "conclusion",
      name === undefined || name === null || typeof name === "string" ? "" : "name",
    ].filter(Boolean);
    if (bad.length > 0) throw new Error(`workflow run ${i} has an invalid ${bad.join(", ")}`);
    return {
      id: id as number,
      workflow_id: workflow_id as number,
      name: typeof name === "string" ? name : undefined,
      head_sha: head_sha as string,
      event: event as string,
      status: status as string,
      conclusion: conclusion as string | null,
    };
  });
}

/**
 * `gh pr checks` lists check runs only, so a `pull_request` workflow that waits for a maintainer's approval, fails to
 * start, or is cancelled is absent there while a check list of pass/skipping looks green. Ask the runs API for the
 * pull_request runs at the exact head and refuse every one not completed as success, skipped or neutral. An unreadable
 * or malformed answer refuses too: unknown workflow status is not green.
 */
async function workflowRefusal(d: Deps, pr: PrRef, sha: string): Promise<[MergeOutcome, string] | undefined> {
  const at = sha.slice(0, 12);
  const res = await d.exec("gh", [
    "api",
    `repos/${pr.repo}/actions/runs?head_sha=${sha}&event=pull_request&per_page=100`,
  ]);
  if (res.code !== 0) {
    const why = res.stderr.trim() || `gh exited ${res.code}`;
    return [
      "workflow_status_unknown",
      `workflow runs at ${at} could not be read: ${why}; Actions status unavailable (permission denied or Actions disabled), so the merge stays refused until the status can be verified: use a credential with Actions read access or resolve repository settings`,
    ];
  }
  let runs: WorkflowRun[];
  try {
    runs = parseWorkflowRuns(res.stdout);
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    return ["workflow_status_unknown", `workflow runs at ${at} could not be read: ${why}`];
  }
  // A reopened PR or a newer run supersedes an older one, so only the latest run of each workflow counts, the way
  // GitHub itself merges: an older cancelled or stale run must not refuse a workflow whose newest run is green.
  const latest = new Map<number, WorkflowRun>();
  for (const r of runs) {
    if (r.head_sha !== sha || r.event !== "pull_request") continue;
    const seen = latest.get(r.workflow_id);
    if (!seen || r.id > seen.id) latest.set(r.workflow_id, r);
  }
  const blocked = [...latest.values()].filter(
    (r) => r.status !== "completed" || !GREEN_CONCLUSIONS.has(r.conclusion ?? ""),
  );
  if (blocked.length === 0) return undefined;
  const list = blocked.map((r) => `${r.name ?? "workflow"}=${r.conclusion ?? r.status}`).join(", ");
  return ["workflow_pending", `pull_request workflow run(s) not green at head ${at}: ${list}`];
}
