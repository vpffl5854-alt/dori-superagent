import { appendFileSync, copyFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { KEY_RE, reservedKey, type Deps } from "./harness.ts";
import { Refusal } from "./refusal.ts";
import type { Item } from "./store-types.ts";

export function log(d: Deps, item: Item, kind: Item["log"][number]["kind"], text: string): void {
  const now = d.now();
  item.log.push({ at: now, kind, text });
  item.updatedAt = now;
  d.store.saveItem(item);
}

export function backlogAdd(
  d: Deps,
  id: string,
  briefFile: string,
  opts: { title?: string; priority?: number; cwd?: string; decision?: string; source?: string } = {},
): Item {
  if (!KEY_RE.test(id)) throw new Refusal(`item id must match ${KEY_RE} (it becomes the lane key)`);
  const reserved = reservedKey(id);
  if (reserved) throw new Refusal(reserved);
  const priority = opts.priority ?? 5;
  if (!Number.isInteger(priority) || priority < 1 || priority > 9)
    throw new Refusal("--priority must be 1 (first) to 9 (last)");
  if (!existsSync(briefFile)) throw new Refusal(`no brief file ${briefFile}`);
  const old = d.store.item(id);
  if (old && (old.status === "open" || old.status === "running"))
    throw new Refusal(`item ${id} is already ${old.status}`);
  copyFileSync(briefFile, d.store.itemBrief(id));
  const now = d.now();
  const item: Item = {
    id,
    title: opts.title ?? id,
    brief: d.store.itemBrief(id),
    cwd: resolve(opts.cwd ?? process.cwd()),
    priority,
    status: "open",
    attempts: 0,
    createdAt: now,
    updatedAt: now,
    log: [],
    ...(opts.decision ? { decision: opts.decision } : {}),
    ...(opts.source ? { source: opts.source } : {}),
  };
  log(d, item, "add", opts.source ?? briefFile);
  return item;
}

function knownItem(d: Deps, id: string): Item {
  if (!KEY_RE.test(id)) throw new Refusal(`item id must match ${KEY_RE}`);
  const item = d.store.item(id);
  if (!item) throw new Refusal(`no backlog item ${id}`);
  return item;
}

function openItem(d: Deps, id: string): Item {
  const item = knownItem(d, id);
  if (item.status !== "open") throw new Refusal(`item ${id} is ${item.status}, not open`);
  return item;
}

/** Records the human's answer: clears the decision and appends the answer to the item's brief. */
export function backlogDecide(d: Deps, id: string, answer: string): void {
  if (!answer.trim()) throw new Refusal("decide needs the answer text");
  const item = openItem(d, id);
  appendFileSync(item.brief, `\n\nDecision on "${item.decision ?? "(none)"}": ${answer.trim()}\n`);
  delete item.decision;
  delete item.askedAt;
  delete item.remindedAt;
  item.attempts = 0;
  item.startFailures = 0;
  log(d, item, "decide", answer);
}

export function backlogDrop(d: Deps, id: string, why = "dropped"): void {
  const item = knownItem(d, id);
  if (item.status === "running") throw new Refusal(`item ${id} is running as a lane; close the lane first`);
  item.status = "dropped";
  log(d, item, "drop", why);
}

type Issue = { number: number; title: string; body: string; labels: { name: string }[] };

/** Open issues with a label become backlog items: label p1..p9 sets the priority, needs-decision marks a question. */
export const IMPORT_LIMIT = 1000;

/** A lane-key-safe id per source: `<repo>-<n>`, with a short hash of the full source when the slug had to be cut. */
export function importId(repo: string, n: number): string {
  const slug =
    repo
      .split("/")[1]!
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^[^a-z]+/, "") || "issue";
  const plain = `${slug}-${n}`;
  if (plain.length <= 41) return plain;
  const tag = `-${createHash("sha256").update(`${repo}#${n}`).digest("hex").slice(0, 6)}-${n}`;
  return `${slug.slice(0, 41 - tag.length).replace(/-+$/, "")}${tag}`;
}

export async function backlogImport(
  d: Deps,
  repo: string,
  label = "dori",
  cwd?: string,
): Promise<{ added: string[]; capped: boolean }> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Refusal(`repo must look like owner/repo, got ${repo}`);
  const r = await d.exec("gh", [
    "issue",
    "list",
    "--repo",
    repo,
    "--label",
    label,
    "--state",
    "open",
    "--limit",
    String(IMPORT_LIMIT),
    "--json",
    "number,title,body,labels",
  ]);
  if (r.code !== 0) throw new Error(`gh issue list failed: ${(r.stderr || r.stdout).trim()}`);
  const known = new Set(d.store.items().map((i) => i.source));
  const added: string[] = [];
  const issues = JSON.parse(r.stdout) as Issue[];
  for (const issue of issues) {
    const source = `${repo}#${issue.number}`;
    if (known.has(source)) continue;
    const names = issue.labels.map((l) => l.name);
    const p = names.map((n) => /^p([1-9])$/.exec(n)?.[1]).find(Boolean);
    const id = importId(repo, issue.number);
    const clash = d.store.item(id);
    if (clash && clash.source !== source)
      throw new Refusal(`import id ${id} for ${source} is already used by ${clash.source ?? "a hand-added item"}`);
    const brief = d.store.loopPath(`import-${id}.md`);
    writeFileSync(
      brief,
      `# ${issue.title}\n\nSource: https://github.com/${repo}/issues/${issue.number}\n\n${issue.body}\n`,
    );
    backlogAdd(d, id, brief, {
      title: issue.title,
      ...(cwd !== undefined ? { cwd } : {}),
      source,
      ...(p ? { priority: Number(p) } : {}),
      ...(names.includes("needs-decision")
        ? { decision: `issue ${source} is labelled needs-decision: ${issue.title}` }
        : {}),
    });
    rmSync(brief, { force: true });
    added.push(id);
  }
  return { added, capped: issues.length >= IMPORT_LIMIT };
}
