import { expect, test } from "bun:test";
import { chromium } from "playwright-core";

import type { Runner } from "../src/run.ts";
import type { FieldRule } from "../src/sns.ts";
import { analyzeDom, readField } from "../src/sns-browser.ts";
import { choose, deploy, healField, mayAttempt, noteAttempt, parseHealReply } from "../src/sns-heal.ts";

const RULE: FieldRule = { selector: "a.old", attr: "href", pattern: "^/watch\\?v=\\w{3}$", min: 3 };
const good = ["/watch?v=aaa", "/watch?v=bbb", "/watch?v=ccc"];
const report = {
  matching: 3,
  sample: "<div>",
  candidates: [
    { selector: "a.new", count: 3, hits: 3 },
    { selector: "a", count: 9, hits: 3 },
  ],
};

test("the model's selector is read out of a reply with prose around it", () => {
  expect(parseHealReply('고쳤다: {"selector": "a[href^=\\"/watch\\"]"} 끝')).toBe('a[href^="/watch"]');
  expect(parseHealReply("모르겠다")).toBeNull();
});

test("a model pick that fails on the page loses to a DOM candidate that passes", async () => {
  const read = async (s: string) =>
    s === "a.new" ? good : s === "div.wrong" ? ["/about"] : [...good, "/x", "/y", "/z"];
  const { picked } = await healField("youtube", "link", RULE, {
    analyze: async () => report,
    read,
    ask: async () => '{"selector": "div.wrong"}',
  });
  expect(picked).toMatchObject({ selector: "a.new", source: "dom" });
});

test("a model pick that passes wins, and nothing is tried when no element fits the pattern", async () => {
  const deps = { analyze: async () => report, read: async () => good, ask: async () => '{"selector": "a.model"}' };
  expect((await healField("youtube", "link", RULE, deps)).picked).toMatchObject({
    selector: "a.model",
    source: "model",
  });
  const empty = { ...deps, analyze: async () => ({ matching: 0, sample: "", candidates: [] }) };
  expect((await healField("youtube", "link", RULE, empty)).picked).toBeNull();
});

test("without a passing candidate there is no pick", () => {
  expect(choose([{ selector: "a", source: "dom", check: { ok: false, values: [], matched: 0 } }])).toBeNull();
});

test("a field is tried at most twice a day", () => {
  let state = {};
  expect(mayAttempt(state, "yt.link", "d1")).toBe(true);
  state = noteAttempt(noteAttempt(state, "yt.link", "d1"), "yt.link", "d1");
  expect(mayAttempt(state, "yt.link", "d1")).toBe(false);
  expect(mayAttempt(state, "yt.link", "d2")).toBe(true);
});

test("deploy commits only the selectors file, then pushes; a failed push keeps the commit", async () => {
  const calls: string[][] = [];
  const run =
    (pushCode: number): Runner =>
    async (argv) => {
      calls.push([...argv]);
      return { code: argv.includes("push") ? pushCode : 0, out: "", err: pushCode ? "denied" : "" };
    };
  expect(await deploy(run(0), "/repo", "/repo/sns/selectors.json", "fix", ["mine", "HEAD"])).toBe(
    "committed and pushed",
  );
  expect(calls).toEqual([
    ["git", "-C", "/repo", "commit", "-m", "fix", "--", "/repo/sns/selectors.json"],
    ["git", "-C", "/repo", "push", "mine", "HEAD"],
  ]);
  expect(await deploy(run(1), "/repo", "/f", "fix", ["mine", "HEAD"])).toBe("committed, push failed: denied");
  expect(await deploy(run(0), "/repo", "/f", "fix", null)).toBe("committed");
});

const BEFORE = `<div class="grid"><a id="video-title-link" class="old" href="/watch?v=aaa">A</a><a id="video-title-link" class="old" href="/watch?v=bbb">B</a><a class="old" href="/watch?v=ccc">C</a></div>`;
const AFTER = `<div class="grid"><div class="lockup"><a class="thumb" href="/watch?v=aaa"><span>7:21</span></a><h3><a class="lockupTitle" href="/watch?v=aaa"><span class="str">첫 영상</span></a></h3></div><div class="lockup"><a class="thumb" href="/watch?v=bbb"></a><h3><a class="lockupTitle" href="/watch?v=bbb"><span class="str">둘째 영상</span></a></h3></div><div class="lockup"><a class="thumb" href="/watch?v=ccc"></a><h3><a class="lockupTitle" href="/watch?v=ccc"><span class="str">셋째</span></a></h3></div><a href="/about">about</a><span class="str">조회수 1만회</span></div>`;

/** The headless shell is installed by `bunx playwright-core install chromium-headless-shell`; without it this test skips. */
const hasBrowser = await chromium
  .launch({ headless: true })
  .then((b) => b.close().then(() => true))
  .catch(() => false);

test.skipIf(!hasBrowser)(
  "after a redesign the old selector finds nothing and the DOM analysis finds a selector that passes",
  async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent(BEFORE);
      expect(await readField(page, "a.old", "href")).toEqual(good);
      await page.setContent(AFTER);
      expect(await readField(page, "a.old", "href")).toEqual([]);
      const dom = await analyzeDom(page, RULE);
      expect(dom.matching).toBe(6);
      const { picked } = await healField("youtube", "link", RULE, {
        analyze: async () => dom,
        read: (s) => readField(page, s, "href"),
        ask: async () => null,
      });
      expect(picked?.check.ok).toBe(true);
      expect(new Set(await readField(page, picked!.selector, "href"))).toEqual(new Set(good));
      const title: FieldRule = { selector: "a.old", attr: "text", pattern: "\\S{2,}", min: 3, pair: "link" };
      const titles = await healField("youtube", "title", title, {
        analyze: () => analyzeDom(page, title),
        read: (s) => readField(page, s, "text"),
        ask: async () => null,
        pairCount: 3,
      });
      expect(await readField(page, titles.picked!.selector, "text")).toEqual(["첫 영상", "둘째 영상", "셋째"]);
    } finally {
      await browser.close();
    }
  },
  30_000,
);
