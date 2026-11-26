/** The messages one turn of the lane answers together (discord-answers.ts). */
import type { Pending } from "./discord-answers-state.ts";

export type Batch = {
  readonly channel: string;
  readonly sessionPath: string;
  readonly items: readonly Pending[];
  /** Where the earliest message's turn began in the session log: the turn's last answer is read after it. */
  readonly from: number;
  /** The newest message: the one answer is posted as its reply. */
  readonly replyTo: string;
};

const older = (a: Pending, b: Pending): number =>
  a.offset - b.offset || a.messageId.length - b.messageId.length || (a.messageId < b.messageId ? -1 : 1);

/** Every message waiting at once in one channel and one session log is waiting for the same turn. */
export const batches = (pending: readonly Pending[]): Batch[] => {
  const groups = new Map<string, Pending[]>();
  for (const p of pending) {
    const k = `${p.channel}\u0000${p.sessionPath}`;
    groups.set(k, [...(groups.get(k) ?? []), p]);
  }
  return [...groups.values()].map((items) => {
    const sorted = [...items].sort(older);
    const last = sorted.at(-1) as Pending;
    return {
      channel: last.channel,
      sessionPath: last.sessionPath,
      items: sorted,
      from: Math.min(...sorted.map((i) => i.ownFrom ?? i.offset)),
      replyTo: last.messageId,
    };
  });
};
