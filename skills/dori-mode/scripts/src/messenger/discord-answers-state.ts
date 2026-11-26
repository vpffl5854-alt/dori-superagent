/** The reply loop's state on disk: the messages still waiting for an answer, and the log of what was posted. */
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type Pending = {
  channel: string;
  messageId: string;
  sessionPath: string;
  offset: number;
  /** The message body, carried so the lane answers from it instead of opening the session log first. */
  text?: string;
  /** Who wrote the message, shown to the pane so it knows whose words it is answering. */
  author?: string;
  /** How the message reached the room: a reply names the post it answers, a mention names who called. The lane
   * answers a reply or a mention directly, and plain room text only when it has something to add. */
  mentions?: readonly string[];
  replyToAuthor?: string;
  /** Where this message's own turn started, when the pane was idle at the hand-off: an answer before it is not this one's. */
  ownFrom?: number;
};

export const pendingPath = (stateDir: string): string => join(stateDir, "discord-reply-pending.json");
export const logPath = (stateDir: string): string => join(stateDir, "discord-replies.log");

export const readPending = (path: string): Pending[] => {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return Array.isArray(parsed) ? (parsed as Pending[]) : [];
  } catch {
    return [];
  }
};

export const writePending = (path: string, pending: readonly Pending[]): void => {
  try {
    writeFileSync(path, JSON.stringify(pending, null, 1));
  } catch {}
};

export const note = (stateDir: string, line: string): void => {
  try {
    appendFileSync(logPath(stateDir), `[${new Date().toISOString()}] ${line}\n`);
  } catch {}
};
