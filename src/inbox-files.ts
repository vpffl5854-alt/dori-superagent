import { appendFileSync, existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { refFromText, sameSession } from "./refs.ts";
import type { SessionRef } from "./runtime/types.ts";
import type { QueuedMessage } from "./store-types.ts";

// Inbox files: one JSONL queue per session. A herdr pane keeps the name it had before runtimes existed (`w1_p3.jsonl`),
// so queues written by an older binary drain; every other runtime is prefixed (`hc--t7.jsonl`). A `.forward` file beside
// an inbox (`w1_p3.jsonl.forward`, holding a ref) says that session moved: new messages go to the ref's inbox, and
// entries an older writer still appends to the old file are merged into it by the next flush.

const HC_PREFIX = "hc--";
const SUFFIX = ".jsonl";

export function inboxFile(root: string, ref: SessionRef): string {
  const name = ref.runtime === "herdr" ? ref.id.replaceAll(":", "_") : `${HC_PREFIX}${ref.id}`;
  return join(root, "inbox", `${name}${SUFFIX}`);
}

function refOfFile(name: string): SessionRef {
  const stem = name.slice(0, -SUFFIX.length);
  return stem.startsWith(HC_PREFIX)
    ? { runtime: "hc", id: stem.slice(HC_PREFIX.length) }
    : { runtime: "herdr", id: stem.replaceAll("_", ":") };
}

/** Every session that has an inbox file, empty or not. */
export const inboxRefs = (root: string): SessionRef[] =>
  readdirSync(join(root, "inbox"))
    .filter((f) => f.endsWith(SUFFIX))
    .map(refOfFile);

export function readQueue(path: string): QueuedMessage[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as QueuedMessage);
}

export const writeQueue = (path: string, msgs: readonly QueuedMessage[]): void =>
  writeFileSync(path, msgs.map((m) => `${JSON.stringify(m)}\n`).join(""));

export const appendQueue = (path: string, msg: QueuedMessage): void => appendFileSync(path, `${JSON.stringify(msg)}\n`);

/** The session this inbox was forwarded to, or undefined. */
export function forwardOf(root: string, ref: SessionRef): SessionRef | undefined {
  const marker = `${inboxFile(root, ref)}.forward`;
  if (!existsSync(marker)) return undefined;
  const text = readFileSync(marker, "utf8").trim();
  return text === "" ? undefined : refFromText(text);
}

/** The old inbox files whose `.forward` marker names `ref`. */
function forwardedInto(root: string, ref: SessionRef): string[] {
  const dir = join(root, "inbox");
  return readdirSync(dir)
    .filter((f) => f.endsWith(`${SUFFIX}.forward`))
    .map((f) => join(dir, f.slice(0, -".forward".length)))
    .filter((old) => {
      const to = readFileSync(`${old}.forward`, "utf8").trim();
      return to !== "" && sameSession(refFromText(to), ref);
    });
}

/** True when an old inbox forwarded into `ref` still holds entries to merge. */
export const forwardPending = (root: string, ref: SessionRef): boolean =>
  forwardedInto(root, ref).some((old) => readQueue(old).length > 0 || readQueue(`${old}.merging`).length > 0);

const keyOf = (m: QueuedMessage): string => `${m.at}\u0000${m.from}\u0000${m.text}`;

/**
 * Moves the entries of every old inbox forwarded into `ref` to the end of ref's inbox. Call it under ref's inbox lock.
 * The old file is renamed aside first, so an append that races the merge lands in a fresh old file for the next one;
 * an entry already in ref's inbox (a merge cut short after its append) is not added again.
 */
export function mergeForwarded(root: string, ref: SessionRef): void {
  const into = inboxFile(root, ref);
  for (const old of forwardedInto(root, ref)) {
    const aside = `${old}.merging`;
    for (let pass = 0; pass < 2; pass++) {
      if (!existsSync(aside)) {
        try {
          renameSync(old, aside);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "ENOENT") break;
          throw e;
        }
      }
      const seen = new Set(readQueue(into).map(keyOf));
      for (const m of readQueue(aside)) {
        if (seen.has(keyOf(m))) continue;
        seen.add(keyOf(m));
        appendQueue(into, m);
      }
      rmSync(aside, { force: true });
    }
  }
}
