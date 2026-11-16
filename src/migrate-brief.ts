import { refText } from "./refs.ts";
import type { SessionRef } from "./runtime/types.ts";
import type { QueuedMessage } from "./store-types.ts";

const FOOTER_MARK = "## Lane rules (added by dori";
const MAYBE_ARRIVED = "may already have reached the previous session; see dori inbox list";

export type HandoffInput = {
  readonly brief: string;
  readonly footer?: string;
  readonly from: SessionRef;
  readonly lastState: string | undefined;
  readonly checkpoint: string | undefined;
  readonly logTail: readonly string[];
  readonly screen: string;
  readonly inbox: readonly QueuedMessage[];
};

const inboxLine = (m: QueuedMessage, i: number): string => {
  const head = `${i + 1}. from ${m.from} queued ${new Date(m.at).toISOString()}`;
  return m.attempt === undefined ? `${head} (queued; it is delivered to you next)` : `${head}: ${MAYBE_ARRIVED}`;
};

/**
 * The replacement session's brief: the original brief (its old lane footer cut off), a `## Handoff` section, then the
 * lane footer once. Held and typed entries get one line each saying they may already have reached the old session.
 */
export function renderHandoff(h: HandoffInput): string {
  const cut = h.brief.indexOf(FOOTER_MARK);
  const original = (cut < 0 ? h.brief : h.brief.slice(0, cut)).trimEnd();
  const tail = h.screen.split("\n").slice(-80).join("\n").trimEnd();
  const sections = [
    original,
    "## Handoff",
    `You replace the session ${refText(h.from)}, which ran this brief before a \`dori migrate\`. Continue from the state below; do not redo finished work.`,
    `Last state: ${h.lastState ?? (h.checkpoint === undefined ? "(no checkpoint written)" : "see the checkpoint below")}`,
    ...(h.checkpoint === undefined ? [] : ["### Checkpoint", h.checkpoint.trimEnd()]),
    "### Lane log (last 20)",
    h.logTail.length === 0 ? "(empty)" : h.logTail.slice(-20).join("\n"),
    "### Last screen (80 lines)",
    `\`\`\`\n${tail}\n\`\`\``,
    "### Inbox carried over",
    h.inbox.length === 0 ? "(empty)" : h.inbox.map(inboxLine).join("\n"),
    ...(h.footer === undefined ? [] : [h.footer.trimEnd()]),
  ];
  return `${sections.join("\n\n")}\n`;
}
