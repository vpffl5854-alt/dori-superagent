/**
 * "Everything in the world" for the shorts factory: random Korean Wikipedia articles as topics, the article's
 * intro as the only source of the script (written by a model through `omo -p`), and its lead image as the
 * background. Wikipedia text is CC BY-SA; the script prompt asks for facts from the intro only.
 */
import type { Http } from "./messenger/http.ts";
import { ShortsError } from "./shorts.ts";

const API = "https://ko.wikipedia.org/w/api.php";
export const WIKI_UA = { "User-Agent": "dori-shorts/0.1 (https://github.com/vpffl5854-alt/dori-superagent)" };
/** An intro shorter than this is a stub: too little to say for 30 seconds. */
export const MIN_EXTRACT = 150;

export type WikiPage = { readonly title: string; readonly extract: string; readonly image?: string };

type RawPage = {
  title?: string;
  extract?: string;
  original?: { source?: string };
  pageprops?: { disambiguation?: string };
};
type Raw = { query?: { pages?: Record<string, RawPage> } };

/** A disambiguation page lists other articles; it has nothing of its own to tell, so it is never a page here. */
const pages = (raw: Raw): WikiPage[] =>
  Object.values(raw.query?.pages ?? {}).flatMap((p) =>
    p.title && p.pageprops?.disambiguation === undefined && !p.title.includes("동음이의")
      ? [
          {
            title: p.title,
            extract: (p.extract ?? "").trim(),
            ...(p.original?.source ? { image: p.original.source } : {}),
          },
        ]
      : [],
  );

const get = async (http: Http, params: Record<string, string>): Promise<Raw> => {
  const q = new URLSearchParams({
    action: "query",
    format: "json",
    prop: "extracts|pageimages|pageprops",
    ppprop: "disambiguation",
    exintro: "1",
    explaintext: "1",
    piprop: "original",
    ...params,
  });
  const res = await http({ method: "GET", url: `${API}?${q}`, headers: WIKI_UA });
  if (res.status !== 200) throw new ShortsError(`wikipedia ${res.status}`);
  return JSON.parse(res.body) as Raw;
};

/** The lead image without Wikipedia's tracking query, when it is a format the renderer reads (not SVG or GIF). */
export const renderableImage = (url: string): string | null => {
  const clean = url.split(/[?#]/)[0] ?? "";
  return /\.(?:jpe?g|png|webp)$/i.test(clean) ? clean : null;
};

/** Twelve random articles; the three with the longest intros (a rough stand-in for "has something to tell"). */
export const randomTopics = async (http: Http): Promise<string[]> =>
  pages(await get(http, { generator: "random", grnnamespace: "0", grnlimit: "12" }))
    .filter((p) => p.extract.length >= MIN_EXTRACT)
    .sort((a, b) => b.extract.length - a.extract.length)
    .slice(0, 3)
    .map((p) => p.title);

export const wikiPage = async (http: Http, title: string): Promise<WikiPage> => {
  const page = pages(await get(http, { titles: title, redirects: "1" }))[0];
  if (!page?.extract) throw new ShortsError(`no Wikipedia article for ${title}`);
  return page;
};

export const scriptPrompt = (page: WikiPage): string =>
  [
    "너는 한국어 유튜브 쇼츠 대본 작가다. 아래 위키백과 요약에 있는 사실만으로 30초 안팎 쇼츠 대본을 써라.",
    "규칙: 요약에 없는 사실은 쓰지 않는다. 첫 줄은 궁금하게 만드는 한 문장. 줄마다 한 문장, 25자 안팎, 5~7줄.",
    '출력은 JSON 하나만: {"title": "12자 이내 제목", "lines": ["...", "..."]}. 설명이나 코드블록 없이.',
    "",
    `제목: ${page.title}`,
    `요약: ${page.extract.slice(0, 1500)}`,
  ].join("\n");

/** The model's reply with any prose or code fence around the JSON object removed. */
export const extractJson = (reply: string): string => {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start < 0 || end <= start) throw new ShortsError("the model's reply has no JSON object");
  return reply.slice(start, end + 1);
};
