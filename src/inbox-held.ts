import type { Deps } from "./harness.ts";
import { send, type SendResult } from "./inbox.ts";
import { refText } from "./refs.ts";
import { Refusal } from "./refusal.ts";
import type { SessionRef } from "./runtime/types.ts";
import { resolveTarget } from "./target.ts";

/**
 * `dori send --to-shell`: the operator's per-message opt-in to type this one message into a pane with no agent.
 * Only the CLI flag reaches here, never relayed content, and queued messages are never typed with it. If an agent
 * is in the pane, or appears before typing, the message takes the queued agent path instead.
 */
export async function sendToShell(d: Deps, target: string, text: string, from: string): Promise<SendResult> {
  const ref = resolveTarget(d, target);
  const rt = d.runtimes.for(ref);
  if ((await rt.probe(ref)).status !== "shell") return send(d, target, text, from);
  if (await rt.typeIntoShell(ref, text)) return "DELIVERED";
  d.store.enqueue(ref, { at: d.now(), from, text });
  return "QUEUED";
}

// Held entries (#108).

export type InboxEntry = {
  index: number;
  state: "queued" | "typed" | "held";
  from: string;
  at: number;
  preview: string;
};

const PREVIEW_CHARS = 60;

/** Where a session's inbox lives now (its `.forward` target, if it moved), with forwarded entries merged in unless a flush holds the lock. */
export function currentInbox(d: Deps, from: SessionRef): SessionRef {
  const ref = d.store.forwardOf(from) ?? from;
  const release = d.store.forwardPending(ref) ? d.store.lockInbox(ref, d.now()) : undefined;
  if (release)
    try {
      d.store.mergeForwarded(ref);
    } finally {
      release();
    }
  return ref;
}

/** A session's queued messages, 1-based in inbox order. The text is never shown whole: its first 60 characters, JSON-escaped. */
export function inboxList(d: Deps, target: string): { paneId: string; entries: InboxEntry[] } {
  const ref = currentInbox(d, resolveTarget(d, target));
  const entries = d.store.queued(ref).map(
    (m, i): InboxEntry => ({
      index: i + 1,
      state: m.attempt?.state === "ambiguous" ? "held" : m.attempt?.state === "typed" ? "typed" : "queued",
      from: m.from,
      at: m.at,
      preview: JSON.stringify(m.text.slice(0, PREVIEW_CHARS)) + (m.text.length > PREVIEW_CHARS ? "..." : ""),
    }),
  );
  return { paneId: refText(ref), entries };
}

/**
 * `ack` drops a held entry (it did arrive); `resend` clears its attempt so the next flush delivers it (it did not).
 * Only held entries: a typed one is in the session's input already, and a queued one is delivered anyway. Runs under
 * the inbox lock, so a flush in progress cannot overwrite the change. Returns the session as refText.
 */
export function releaseHeld(d: Deps, target: string, index: number, how: "ack" | "resend"): string {
  const named = resolveTarget(d, target);
  const ref = d.store.forwardOf(named) ?? named;
  const paneId = refText(ref);
  const release = d.store.lockInbox(ref, d.now());
  if (!release) throw new Refusal(`the inbox of ${paneId} is being flushed right now; try again`);
  try {
    d.store.mergeForwarded(ref);
    const msgs = d.store.queued(ref);
    const m = Number.isInteger(index) ? msgs[index - 1] : undefined;
    if (!m)
      throw new Refusal(
        `no entry ${index} in the inbox of ${paneId} (${msgs.length} entries; see dori inbox list ${target})`,
      );
    if (m.attempt?.state !== "ambiguous")
      throw new Refusal(`entry ${index} of ${paneId} is not held; only held entries can be acked or resent`);
    const { attempt: _, ...fresh } = m;
    d.store.saveInbox(
      ref,
      how === "ack" ? msgs.filter((_, i) => i !== index - 1) : msgs.map((x, i) => (i === index - 1 ? fresh : x)),
    );
    return paneId;
  } finally {
    release();
  }
}

/**
 * `drop` throws away queued entries that must never be delivered: a message the operator knows is stale (a pane that
 * read `working` for hours keeps them queued). Only entries with no attempt are dropped. A held one may already have
 * reached the pane, so `ack` settles it; a typed one is in the session's input already. `all` drops every queued entry
 * of the inbox and leaves the rest. Runs under the inbox lock, so a flush in progress cannot overwrite the change.
 * Returns the session as refText and the number of entries dropped.
 */
export function dropQueued(d: Deps, target: string, index: number, all: boolean): { paneId: string; dropped: number } {
  const named = resolveTarget(d, target);
  const ref = d.store.forwardOf(named) ?? named;
  const paneId = refText(ref);
  const release = d.store.lockInbox(ref, d.now());
  if (!release) throw new Refusal(`the inbox of ${paneId} is being flushed right now; try again`);
  try {
    d.store.mergeForwarded(ref);
    const msgs = d.store.queued(ref);
    if (all) {
      const kept = msgs.filter((m) => m.attempt !== undefined);
      if (kept.length === msgs.length)
        throw new Refusal(`no queued entry in the inbox of ${paneId} can be dropped (see dori inbox list ${target})`);
      d.store.saveInbox(ref, kept);
      return { paneId, dropped: msgs.length - kept.length };
    }
    const m = Number.isInteger(index) ? msgs[index - 1] : undefined;
    if (!m)
      throw new Refusal(
        `no entry ${index} in the inbox of ${paneId} (${msgs.length} entries; see dori inbox list ${target})`,
      );
    if (m.attempt?.state === "ambiguous")
      throw new Refusal(
        `entry ${index} of ${paneId} is held: it may already have reached the pane, so ack it if it did (dori inbox ack ${paneId} ${index}); drop is for queued entries only`,
      );
    if (m.attempt !== undefined)
      throw new Refusal(
        `entry ${index} of ${paneId} is already typed into the pane; only queued entries can be dropped`,
      );
    d.store.saveInbox(
      ref,
      msgs.filter((_, i) => i !== index - 1),
    );
    return { paneId, dropped: 1 };
  } finally {
    release();
  }
}
