// One `hc --json` call: the session is the inherited HC_SESSION (hc has no --session flag), the result is hc's JSON.
import type { Exec, ExecResult } from "../exec.ts";
import { ToolError } from "../exec.ts";

/** Exit codes per error kind (hc's rpc table), read only when stderr carries no JSON. */
const KIND_BY_EXIT: Readonly<Record<number, string>> = {
  2: "usage",
  3: "not_found",
  4: "machine_unknown",
  5: "unavailable",
  6: "invalid_params",
  7: "needs_target",
  8: "config",
  9: "blocked",
  10: "status_mismatch",
  11: "finished",
};

/**
 * An `hc` call that exited non-zero. `kind` is hc's stable error kind (not_found, blocked, status_mismatch, live, ...),
 * `reason` its message. The message and `argv` never carry a redacted value (the delivered text).
 */
export class HcError extends ToolError {
  override readonly name = "HcError";

  constructor(
    argv: readonly string[],
    result: ExecResult,
    readonly kind: string | undefined,
    readonly hint: string | undefined,
    readonly reason: string,
  ) {
    super(argv, result, "hc");
    this.message = `hc ${argv.join(" ")} failed (${result.code})${kind === undefined ? "" : ` ${kind}`}: ${reason}`;
  }
}

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const str = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);

function errorOf(argv: readonly string[], result: ExecResult): HcError {
  const raw = result.stderr.trim() || result.stdout.trim();
  let error: Record<string, unknown> = {};
  try {
    error = asRecord(asRecord(JSON.parse(raw))["error"]);
  } catch {
    // Not JSON: an old or broken hc, or the process died; fall back to the exit code.
  }
  const kind = str(error["kind"]) ?? KIND_BY_EXIT[result.code];
  const hint = str(error["hint"]) ?? str(asRecord(error["data"])["hint"]);
  return new HcError(argv, result, kind, hint, str(error["message"]) ?? (raw || "no output"));
}

export type HcCallOptions = { readonly redact?: string };

export async function hcCall(
  exec: Exec,
  argv: readonly string[],
  options: HcCallOptions = {},
): Promise<Record<string, unknown>> {
  const full = ["--json", ...argv];
  const result = await exec("hc", full);
  if (result.code !== 0) {
    const shown = options.redact === undefined ? full : full.map((a) => (a === options.redact ? "<text>" : a));
    throw errorOf(shown, result);
  }
  const text = result.stdout.trim();
  return text === "" ? {} : asRecord(JSON.parse(text));
}

export const isKind = (e: unknown, ...kinds: readonly string[]): e is HcError =>
  e instanceof HcError && e.kind !== undefined && kinds.includes(e.kind);
