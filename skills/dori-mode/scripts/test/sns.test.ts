import { expect, test } from "bun:test";

import {
  checkField,
  type FieldRule,
  parseErrors,
  parseTarget,
  profileUrl,
  type Rules,
  toRepair,
  withSelector,
} from "../src/sns.ts";

const LINK: FieldRule = { selector: "a.old", attr: "href", pattern: "^/watch\\?v=[\\w-]{11}", min: 3 };
const ids = (n: number) => Array.from({ length: n }, (_, i) => `/watch?v=${String(i).padStart(11, "x")}`);

test("a field is healthy with enough distinct values that mostly fit the pattern", () => {
  expect(checkField(LINK, [...ids(4), ids(4)[0]!])).toMatchObject({ ok: true, matched: 4 });
  expect(checkField(LINK, ids(2))).toMatchObject({ ok: false, reason: "found 2, need 3" });
  expect(checkField(LINK, [...ids(3), "/about", "/shorts", "/x"])).toMatchObject({
    ok: false,
    reason: "only 3/6 values look right",
  });
});

test("a paired field must find about as many values as the field it describes", () => {
  const title: FieldRule = { selector: "span", attr: "text", pattern: "\\S{2,}", min: 3, pair: "link" };
  const many = Array.from({ length: 94 }, (_, i) => `text ${i}`);
  expect(checkField(title, many, 30)).toMatchObject({ ok: false, reason: "found 94, but link has 30" });
  expect(checkField(title, many.slice(0, 30), 30).ok).toBe(true);
  expect(checkField(title, many.slice(0, 30)).ok).toBe(true);
});

test("healing rewrites one selector and keeps the field's contract", () => {
  const rules: Rules = { youtube: { url: "u/{handle}", fields: { link: LINK } } };
  expect(withSelector(rules, "youtube", "link", "a.new")["youtube"]?.fields["link"]).toEqual({
    ...LINK,
    selector: "a.new",
  });
  expect(() => withSelector(rules, "youtube", "nope", "a")).toThrow();
});

test("the error log becomes one repair per platform field, garbage lines skipped", () => {
  const line = (platform: string, handle: string, field: string) =>
    JSON.stringify({ at: "t", platform, handle, field, selector: "s", reason: "r" });
  const errors = parseErrors(
    [line("youtube", "a", "link"), "oops", line("youtube", "b", "link"), line("youtube", "a", "title")].join("\n"),
  );
  expect(errors).toHaveLength(3);
  expect(toRepair(errors).map((e) => `${e.platform}.${e.field}:${e.handle}`)).toEqual([
    "youtube.link:b",
    "youtube.title:a",
  ]);
});

test("targets and profile URLs", () => {
  expect(parseTarget("youtube:@YouTube")).toEqual({ platform: "youtube", handle: "YouTube" });
  expect(parseTarget("youtube-search:돈 버는 법")).toEqual({ platform: "youtube-search", handle: "돈 버는 법" });
  expect(parseTarget("nonsense")).toBeNull();
  expect(profileUrl({ url: "https://www.threads.com/@{handle}", fields: {} }, "@zuck")).toBe(
    "https://www.threads.com/@zuck",
  );
});
