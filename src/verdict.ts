type Verdict = "CLEAR" | "BLOCK";
type VerdictScan = { kind: "none" } | { kind: "verdict"; verdict: Verdict } | { kind: "ambiguous"; values: Verdict[] };

/** The original contract: a column-zero line, trailing rationale allowed (`VERDICT: CLEAR — 4 LOW findings`). */
const PLAIN_VERDICT = /^VERDICT:\s*(CLEAR|BLOCK)(?![A-Za-z0-9])(?![_-][A-Za-z0-9])/;

/** The incident's shape: nothing but the verdict once markdown emphasis and backticks are removed. */
const EMPHASISED_VERDICT = /^VERDICT\s*:\s*(CLEAR|BLOCK)$/;

/** A bullet, list, or blockquote marker never introduces a verdict, even when its mark could pass as emphasis. */
const MARKER = /^\s*(?:[-+]|\*|\d+[.)]|>)\s/;

/**
 * Two compatible shapes: the original column-zero `VERDICT: CLEAR|BLOCK` line (trailing rationale included), and a
 * whole line that is only that verdict wrapped in markdown emphasis or backticks. Indented lines, bullets, blockquotes
 * and fenced examples never count. Plain lines keep legacy last-match; plain and emphasised lines that disagree are
 * ambiguous and write no receipt.
 */
export function scanVerdicts(stdout: string): VerdictScan {
  const plain: Verdict[] = [];
  const emphasised: Verdict[] = [];
  let fence: string | undefined;
  for (const raw of stdout.split(/\r?\n/)) {
    const mark = /^\s*(`{3,}|~{3,})/.exec(raw)?.[1];
    if (mark) {
      // A fence closes only on the same marker character with at least the opening run's length.
      if (fence === undefined) fence = mark;
      else if (mark[0] === fence[0] && mark.length >= fence.length) fence = undefined;
      continue;
    }
    if (fence !== undefined || MARKER.test(raw) || /^\s/.test(raw)) continue;
    const p = PLAIN_VERDICT.exec(raw);
    if (p) {
      plain.push(p[1] as Verdict);
      continue;
    }
    const e = EMPHASISED_VERDICT.exec(raw.replace(/[`*_]/g, "").trim());
    if (e && /[`*_]/.test(raw)) emphasised.push(e[1] as Verdict);
  }
  if (plain.length === 0 && emphasised.length === 0) return { kind: "none" };
  if (emphasised.length === 0) return { kind: "verdict", verdict: plain.at(-1)! };
  if (plain.length === 0) {
    const values = [...new Set(emphasised)];
    return values.length === 1 ? { kind: "verdict", verdict: values[0]! } : { kind: "ambiguous", values };
  }
  const values = [...new Set([...plain, ...emphasised])];
  return values.length === 1 ? { kind: "verdict", verdict: values[0]! } : { kind: "ambiguous", values };
}
