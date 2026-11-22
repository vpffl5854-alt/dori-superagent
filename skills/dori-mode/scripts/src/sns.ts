/**
 * The SNS scrapers' rules: per platform a profile URL and named fields, each a CSS selector, the attribute it reads
 * (`href`, `alt`, `datetime`, or `text`), a pattern every good value matches, and how many values a healthy page has.
 * The rules live in `scripts/sns/selectors.json` as data, so the healer can rewrite a selector and nothing else: the
 * attribute, pattern and minimum are the contract that tells a working selector from one returning the wrong things.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type Attr = "href" | "text" | "alt" | "datetime";
export type FieldRule = {
  readonly selector: string;
  readonly attr: Attr;
  readonly pattern: string;
  readonly min: number;
  /** A field that describes the items another field lists (a title per link): its count must stay near that one's. */
  readonly pair?: string;
};
export type PlatformRule = { readonly url: string; readonly fields: Readonly<Record<string, FieldRule>> };
export type Rules = Readonly<Record<string, PlatformRule>>;

export const SELECTORS_PATH = join(dirname(import.meta.dir), "sns", "selectors.json");

export const loadRules = (path = SELECTORS_PATH): Rules => JSON.parse(readFileSync(path, "utf8")) as Rules;

/** Only the one selector changes; the file keeps its shape so the commit diff is that one line. */
export const withSelector = (rules: Rules, platform: string, field: string, selector: string): Rules => {
  const p = rules[platform];
  const f = p?.fields[field];
  if (!p || !f) throw new Error(`no rule ${platform}.${field}`);
  return { ...rules, [platform]: { ...p, fields: { ...p.fields, [field]: { ...f, selector } } } };
};

export const saveRules = (rules: Rules, path = SELECTORS_PATH): void =>
  writeFileSync(path, `${JSON.stringify(rules, null, 2)}\n`);

/** The page for a handle, or for a search query on a search rule (`youtube-search`). */
export const profileUrl = (rule: PlatformRule, handle: string): string =>
  rule.url.replace("{handle}", encodeURIComponent(handle.replace(/^@/, "")));

/** A field is healthy when it found at least `min` distinct values and at least 80% of them match the pattern. */
export const MATCH_RATIO = 0.8;

export type FieldCheck = {
  readonly ok: boolean;
  readonly values: readonly string[];
  readonly matched: number;
  readonly reason?: string;
};

/** A paired field may find between half and one and a half times as many values as the field it describes. */
export const PAIR_RANGE = [0.5, 1.5] as const;

export const checkField = (rule: FieldRule, raw: readonly string[], pairCount?: number): FieldCheck => {
  const values = [...new Set(raw.map((v) => v.trim()).filter(Boolean))];
  const re = new RegExp(rule.pattern, "u");
  const matched = values.filter((v) => re.test(v)).length;
  if (values.length < rule.min)
    return { ok: false, values, matched, reason: `found ${values.length}, need ${rule.min}` };
  if (rule.pair && pairCount !== undefined && pairCount > 0) {
    const [lo, hi] = PAIR_RANGE;
    if (values.length < pairCount * lo || values.length > pairCount * hi)
      return { ok: false, values, matched, reason: `found ${values.length}, but ${rule.pair} has ${pairCount}` };
  }
  if (matched / values.length < MATCH_RATIO)
    return { ok: false, values, matched, reason: `only ${matched}/${values.length} values look right` };
  return { ok: true, values: values.filter((v) => re.test(v)), matched };
};

export type ScrapeError = {
  readonly at: string;
  readonly platform: string;
  readonly handle: string;
  readonly field: string;
  readonly selector: string;
  readonly reason: string;
};

export const errorLine = (e: ScrapeError): string => `${JSON.stringify(e)}\n`;

export const parseErrors = (text: string): ScrapeError[] =>
  text.split("\n").flatMap((line) => {
    try {
      const e = JSON.parse(line) as ScrapeError;
      return e.platform && e.field ? [e] : [];
    } catch {
      return [];
    }
  });

/** One failure per platform and field: a page that broke five handles is one repair, not five. */
export const toRepair = (errors: readonly ScrapeError[]): ScrapeError[] => {
  const seen = new Map<string, ScrapeError>();
  for (const e of errors) seen.set(`${e.platform}.${e.field}`, e);
  return [...seen.values()];
};

export type SnsConfig = {
  /** `platform:handle` pairs `dori sns run` scrapes; the canaries below when absent. */
  readonly targets?: readonly string[];
  /** The omo binary and model the healer asks for a selector; without them only the DOM candidates are tried. */
  readonly omo?: string;
  readonly model?: string;
  /** Commit the healed selectors file, and push with these git arguments (for example ["mine", "HEAD"]). */
  readonly deploy?: boolean;
  readonly push?: readonly string[];
  /** Tells the owner a field broke or was healed: `{text}`. */
  readonly notifyArgv?: readonly string[];
};

/** Where one scrape's values are kept: `<stateDir>/sns/latest/<this>`; a search query's spaces become underscores. */
export const latestName = (platform: string, handle: string): string =>
  `${platform}-${handle.replace(/[^\p{L}\p{N}._-]+/gu, "_")}.json`;

/** Official accounts that always have posts: a broken canary is a broken page, not a quiet account. */
export const CANARIES = ["youtube:YouTube", "instagram:instagram", "threads:zuck", "tiktok:tiktok"] as const;

export const parseTarget = (t: string): { platform: string; handle: string } | null => {
  const m = /^([a-z-]+):@?(\S+)$/u.exec(t.trim());
  return m?.[1] && m[2] ? { platform: m[1], handle: m[2] } : null;
};
