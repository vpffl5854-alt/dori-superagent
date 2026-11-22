/**
 * The headless browser side of the SNS scrapers: open a public profile without logging in, read a field's values with
 * its selector, and, when a selector broke, look at the live DOM for elements whose value fits the field's pattern and
 * list the selectors that would reach them. Nothing here logs in, solves a challenge or hides that it is a browser.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Browser, Page } from "playwright-core";
import type { FieldRule } from "./sns.ts";

/** The page-side half lives in plain JS (scripts/sns/analyze-dom.js): the skill compiles without DOM types. */
const ANALYZE_DOM = readFileSync(join(dirname(import.meta.dir), "sns", "analyze-dom.js"), "utf8")
  .replace(/^\/\/.*\n/, "")
  .trim()
  .replace(/;$/, "");

export const SETTLE_MS = 6_000;

export const openPage = async (browser: Browser, url: string): Promise<Page> => {
  const page = await browser.newPage({ locale: "ko-KR", viewport: { width: 1280, height: 2000 } });
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForTimeout(SETTLE_MS);
  return page;
};

/** The field's raw values; a selector the page rejects reads as nothing found, which the check reports. */
export const readField = async (page: Page, selector: string, attr: FieldRule["attr"]): Promise<string[]> =>
  page
    .$$eval(
      selector,
      (els, a) =>
        els.map((e) => (a === "text" ? (e.textContent ?? "") : (e.getAttribute(a) ?? "")).replace(/\s+/g, " ").trim()),
      attr,
    )
    .catch(() => []);

export type Candidate = { readonly selector: string; readonly count: number; readonly hits: number };
export type DomReport = {
  readonly matching: number;
  readonly candidates: readonly Candidate[];
  readonly sample: string;
};

/**
 * Every element whose value fits the pattern, and for each a handful of selectors (its tag with one class, id,
 * data-e2e or data-testid, a shared href prefix, the same under its parent or its enclosing link). Each selector is
 * counted on the page: `hits` is how many of its elements fit the pattern, `count` how many it reaches at all.
 */
export const analyzeDom = async (page: Page, rule: FieldRule): Promise<DomReport> =>
  page.evaluate(
    `(${ANALYZE_DOM})(${JSON.stringify({ attr: rule.attr, pattern: rule.pattern })})`,
  ) as Promise<DomReport>;
