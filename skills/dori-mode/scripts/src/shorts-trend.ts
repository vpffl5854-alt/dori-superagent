/**
 * Trend topics: the popular YouTube titles for the owner's interests (scraped by `dori sns run` as
 * `youtube-search:<interest>`) steer which Wikipedia articles become shorts. A title is only a hint: a model turns
 * the titles into Wikipedia headwords, each headword must be a real article with a real intro, and the script is
 * still written from that intro alone, so a clickbait title never becomes a "fact".
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { latestName } from "./sns.ts";

/** Search results older than this are not "what is popular now". */
export const FRESH_MS = 2 * 86_400_000;

/** The model picking headwords may take this long; the topics slot around it must outlast it plus the wiki lookups. */
export const TREND_MODEL_MS = 180_000;
export const TOPICS_SLOT_MS = TREND_MODEL_MS + 120_000;

export const trendTitles = (latestDir: string, interests: readonly string[], now: number): string[] =>
  interests.flatMap((interest) => {
    const path = join(latestDir, latestName("youtube-search", interest));
    if (!existsSync(path)) return [];
    const data = JSON.parse(readFileSync(path, "utf8")) as { at?: string; title?: string[] };
    if (!data.at || now - Date.parse(data.at) > FRESH_MS) return [];
    return (data.title ?? []).slice(0, 10).map((t) => `[${interest}] ${t}`);
  });

export const trendPrompt = (titles: readonly string[], interests: readonly string[]): string =>
  [
    `관심 분야(${interests.join(", ")})에서 요즘 유튜브 인기 영상 제목들이다.`,
    "이걸 보고, 30초 상식 쇼츠로 만들면 사람들이 궁금해할 한국어 위키백과 표제어 6개를 골라라.",
    "규칙: 실제 위키백과 문서 제목처럼 짧은 명사(예: 수면 위생, 복리, 생성형 인공지능). 채널명·인물 이름·광고 문구는 빼라.",
    "출력: 한 줄에 표제어 하나, 번호나 설명 없이.",
    "",
    ...titles.slice(0, 40),
  ].join("\n");

export const parseHeadwords = (reply: string): string[] => [
  ...new Set(
    reply
      .split("\n")
      .map((l) =>
        l
          .replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "")
          .replace(/[*`"]/g, "")
          .trim(),
      )
      .filter((l) => l.length >= 2 && l.length <= 30 && !/[:：]/.test(l)),
  ),
];
