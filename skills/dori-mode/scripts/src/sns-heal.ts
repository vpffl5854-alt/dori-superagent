/**
 * The self-healing step for one broken field: read the live DOM for elements that fit the field's pattern, ask a
 * model to pick or write a selector from that report, then verify every candidate on the live page against the
 * field's fixed contract. Only a verified selector is written, committed and pushed; a field that cannot be healed
 * twice in a day stops being retried until the next day, so a page that changed beyond repair is not hammered.
 */
import type { Runner } from "./run.ts";
import { checkField, type FieldCheck, type FieldRule } from "./sns.ts";
import type { DomReport } from "./sns-browser.ts";

export const healPrompt = (platform: string, field: string, rule: FieldRule, report: DomReport): string =>
  [
    `너는 웹 스크래퍼 셀렉터 수리공이다. ${platform} 공개 프로필 페이지의 "${field}" 필드 셀렉터가 깨졌다.`,
    `깨진 셀렉터: ${rule.selector}`,
    `이 필드는 각 요소의 ${rule.attr === "text" ? "텍스트" : `${rule.attr} 속성`}을 읽고, 좋은 값은 정규식 /${rule.pattern}/ 에 맞으며 최소 ${rule.min}개다.`,
    ...(rule.pair
      ? [
          `이 필드는 ${rule.pair} 필드의 항목마다 하나씩 있다: 개수가 ${rule.pair}와 비슷해야 하고, 다른 텍스트가 섞이면 안 된다.`,
        ]
      : []),
    `지금 페이지에서 이 정규식에 맞는 요소는 ${report.matching}개다. 그 요소들에 닿는 후보 셀렉터 (hits=맞는 요소 수, count=닿는 요소 수):`,
    ...report.candidates.map((c) => `- ${c.selector}  hits=${c.hits} count=${c.count}`),
    "",
    "맞는 요소 하나의 부모 HTML:",
    report.sample,
    "",
    "가장 안정적인 CSS 셀렉터 하나를 골라라. 자동 생성된 듯한 해시 클래스, nth-child, 너무 긴 경로는 피하고, 맞는 요소는 다 잡되 다른 건 덜 잡는 것.",
    '출력은 JSON 하나만: {"selector": "..."}',
  ].join("\n");

export const parseHealReply = (reply: string): string | null => {
  const m = /\{[^{}]*"selector"\s*:\s*"((?:[^"\\]|\\.)*)"[^{}]*\}/.exec(reply);
  if (!m?.[1]) return null;
  try {
    return (JSON.parse(`"${m[1]}"`) as string).trim() || null;
  } catch {
    return null;
  }
};

export type Verified = { readonly selector: string; readonly source: "model" | "dom"; readonly check: FieldCheck };

/**
 * The model's pick when it holds up on the page; otherwise the DOM candidate whose count is closest to the field it
 * describes (when paired: one title per link, so the extra "1M views" span loses), then the most good values, then the
 * most precise and shortest.
 */
export const choose = (verified: readonly Verified[], pairCount?: number): Verified | null => {
  const ok = verified.filter((v) => v.check.ok);
  const gap = (v: Verified) => (pairCount ? Math.abs(v.check.values.length - pairCount) : 0);
  return (
    ok.find((v) => v.source === "model") ??
    [...ok].sort(
      (a, b) =>
        gap(a) - gap(b) ||
        b.check.matched - a.check.matched ||
        b.check.matched / b.check.values.length - a.check.matched / a.check.values.length ||
        a.selector.length - b.selector.length,
    )[0] ??
    null
  );
};

export type HealDeps = {
  readonly analyze: () => Promise<DomReport>;
  readonly read: (selector: string) => Promise<string[]>;
  /** The model's reply to the prompt, or null when no model is configured or it failed. */
  readonly ask: (prompt: string) => Promise<string | null>;
  /** How many values the field this one describes has on the page (its `pair`), read with that field's selector. */
  readonly pairCount?: number;
};

export const MAX_DOM_CANDIDATES = 8;

export const healField = async (
  platform: string,
  field: string,
  rule: FieldRule,
  deps: HealDeps,
): Promise<{ readonly picked: Verified | null; readonly report: DomReport }> => {
  const report = await deps.analyze();
  if (report.matching === 0) return { picked: null, report };
  const fromModel = parseHealReply((await deps.ask(healPrompt(platform, field, rule, report))) ?? "");
  const tries: { selector: string; source: Verified["source"] }[] = [
    ...(fromModel ? [{ selector: fromModel, source: "model" as const }] : []),
    ...report.candidates.slice(0, MAX_DOM_CANDIDATES).map((c) => ({ selector: c.selector, source: "dom" as const })),
  ];
  const verified: Verified[] = [];
  for (const t of tries) {
    if (t.selector === rule.selector) continue;
    verified.push({ ...t, check: checkField(rule, await deps.read(t.selector), deps.pairCount) });
  }
  return { picked: choose(verified, deps.pairCount), report };
};

export type HealState = Record<string, { readonly day: string; readonly attempts: number }>;
export const MAX_ATTEMPTS_PER_DAY = 2;

export const mayAttempt = (state: HealState, key: string, day: string): boolean =>
  state[key]?.day !== day || (state[key]?.attempts ?? 0) < MAX_ATTEMPTS_PER_DAY;

export const noteAttempt = (state: HealState, key: string, day: string): HealState => ({
  ...state,
  [key]: { day, attempts: state[key]?.day === day ? state[key].attempts + 1 : 1 },
});

/** Commit only the selectors file (other work in the tree is left alone) and push the current branch. */
export const deploy = async (
  run: Runner,
  repo: string,
  file: string,
  message: string,
  push: readonly string[] | null,
): Promise<string> => {
  const git = (...args: string[]) => run(["git", "-C", repo, ...args]);
  const c = await git("commit", "-m", message, "--", file);
  if (c.code !== 0) return `commit failed: ${(c.err || c.out).slice(0, 160)}`;
  if (!push) return "committed";
  const p = await git("push", ...push);
  return p.code === 0 ? "committed and pushed" : `committed, push failed: ${p.err.slice(0, 160)}`;
};
