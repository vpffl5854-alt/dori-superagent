import { ToolError } from "./runtime/exec.ts";
import type { AgentIdentity } from "./runtime/types.ts";

/**
 * A delivery that failed after the message may already have reached the session (#89): sending it again could deliver
 * it twice. `typed`: the text is in the session's input and only the Enter that submits it is missing; `agent` is the
 * agent it was typed into (#108).
 */
export class DeliveryUncertain extends Error {
  constructor(
    readonly failure: unknown,
    readonly typed: boolean,
    readonly agent?: AgentIdentity,
  ) {
    super(failure instanceof Error ? failure.message : String(failure));
  }
}

/** One word for a POSIX shell: single-quoted, nothing in it expands. */
export const shq = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`;

/** A short one-line reason. A ToolError message carries the whole argv (the queued text), so use the tool's own output. */
export function failureDetail(e: unknown): string {
  if (e instanceof DeliveryUncertain) e = e.failure;
  const raw = e instanceof ToolError ? e.result.stderr || e.result.stdout : e instanceof Error ? e.message : String(e);
  const first = raw.trim().split("\n")[0] ?? "";
  return first.length > 200 ? `${first.slice(0, 200)}...` : first;
}
