import { expect, test } from "bun:test";

import type { Http } from "../src/messenger/http.ts";
import { ShortsError } from "../src/shorts.ts";
import { extractJson, MIN_EXTRACT, randomTopics, renderableImage, scriptPrompt, wikiPage } from "../src/shorts-wiki.ts";

const long = (n: number) => "가".repeat(n);

const fakeWiki =
  (pages: Record<string, unknown>, urls: string[] = []): Http =>
  async (req) => {
    urls.push(req.url);
    return { status: 200, headers: {}, body: JSON.stringify({ query: { pages } }) };
  };

test("topics are the three longest real articles; stubs and disambiguation pages never are", async () => {
  const urls: string[] = [];
  const http = fakeWiki(
    {
      1: { title: "짧은 글", extract: long(MIN_EXTRACT - 1) },
      2: { title: "동음이의 목록", extract: long(900), pageprops: { disambiguation: "" } },
      3: { title: "페더레이션 컵 (동음이의)", extract: long(900) },
      4: { title: "A", extract: long(300) },
      5: { title: "B", extract: long(500) },
      6: { title: "C", extract: long(400) },
      7: { title: "D", extract: long(200) },
    },
    urls,
  );
  expect(await randomTopics(http)).toEqual(["B", "C", "A"]);
  expect(urls[0]).toContain("generator=random");
  expect(urls[0]).toContain("ppprop=disambiguation");
});

test("a page carries its intro and lead image; a missing article is an error", async () => {
  const http = fakeWiki({ 9: { title: "T", extract: " 본문 ", original: { source: "https://x/a.jpg" } } });
  expect(await wikiPage(http, "T")).toEqual({ title: "T", extract: "본문", image: "https://x/a.jpg" });
  await expect(wikiPage(fakeWiki({}), "없음")).rejects.toBeInstanceOf(ShortsError);
});

test("the prompt holds the model to the intro's facts and the JSON shape", () => {
  const p = scriptPrompt({ title: "레일리 산란", extract: "빛이 작은 입자에 흩어지는 현상." });
  expect(p).toContain("요약에 없는 사실은 쓰지 않는다");
  expect(p).toContain('{"title"');
  expect(p).toContain("제목: 레일리 산란");
});

test("the JSON object is cut out of a reply wrapped in prose or a code fence", () => {
  expect(extractJson('여기 대본:\n```json\n{"title":"t","lines":["a"]}\n```')).toBe('{"title":"t","lines":["a"]}');
  expect(() => extractJson("대본을 못 썼어요")).toThrow(ShortsError);
});

test("a lead image keeps its format past Wikipedia's tracking query; SVG and GIF stay unusable", () => {
  const base = "https://upload.wikimedia.org/wikipedia/commons/f/f6/White-noise.png";
  expect(renderableImage(`${base}?utm_source=ko.wikipedia.org&utm_campaign=api`)).toBe(base);
  expect(renderableImage("https://x/a/Cat.JPG")).toBe("https://x/a/Cat.JPG");
  expect(renderableImage("https://x/a/Psi.svg?utm_source=ko")).toBeNull();
  expect(renderableImage("https://x/a/Anim.gif")).toBeNull();
});
