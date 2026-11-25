// One `omo host session <verb> ... --json` call: the CLI prints exactly one JSON line on stdout, failures included, and
// its exit code classifies the outcome (0 ok, 1 failed, 2 usage, 3 refused by the host).
import type { Exec, ExecResult } from "../exec.ts";
import { ToolError } from "../exec.ts";

export const OMO = "omo";

/**
 * An `omo host session` call that exited non-zero. `reason` is the payload's stable reason (`unknown_session`, `busy`,
 * `host_unavailable`, `transport_gone`, ...), `detail` its text. Neither the message nor `argv` carries a redacted value.
 */
export class OmoHostError extends ToolError {
  override readonly name = "OmoHostError";

  constructor(
    argv: readonly string[],
    result: ExecResult,
    readonly reason: string | undefined,
    readonly detail: string,
  ) {
    super(argv, result, OMO);
    this.message = `omo ${argv.join(" ")} failed (${result.code})${reason === undefined ? "" : ` ${reason}`}: ${detail}`;
  }
}

export const rec = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
export const str = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

const parse = (text: string): Record<string, unknown> | undefined => {
  try {
    return rec(JSON.parse(text.trim().split("\n").at(-1) ?? ""));
  } catch {
    return undefined;
  }
};

/**
 * The CLI reads a text argument that starts with `@` as a file to load and one that starts with `-` as a flag, so such a
 * text is sent with one leading space (the agent reads the same words).
 */
export const asText = (text: string): string => (/^[@-]/.test(text) ? ` ${text}` : text);

export async function hostCall(
  exec: Exec,
  argv: readonly string[],
  options: { readonly redact?: string } = {},
): Promise<Record<string, unknown>> {
  const full = ["host", "session", ...argv, "--json"];
  const result = await exec(OMO, full);
  const payload = parse(result.stdout);
  if (result.code === 0 && payload !== undefined) return payload;
  const shown = options.redact === undefined ? full : full.map((a) => (a === options.redact ? "<text>" : a));
  const raw = (result.stderr || result.stdout).trim();
  const detail = str(payload?.["detail"]) ?? (raw || "no output");
  const scrubbed = options.redact ? detail.replaceAll(options.redact, "<text>") : detail;
  throw new OmoHostError(shown, result, str(payload?.["reason"]), scrubbed);
}

export const isReason = (e: unknown, ...reasons: readonly string[]): e is OmoHostError =>
  e instanceof OmoHostError && e.reason !== undefined && reasons.includes(e.reason);
