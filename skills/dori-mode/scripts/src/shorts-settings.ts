/**
 * The shorts settings an owner changes by asking (in Discord through the lead, or in the Telegram Dori room): a small
 * set of named keys, each checked before it is written, so an agent never hand-edits config JSON. Every change backs
 * the config file up first. The daily time lives in the launchd job, not in the config.
 */
import type { ShortsConfig } from "./shorts.ts";

export const KOREAN_VOICES = [
  "Yuna",
  "Eddy",
  "Flo",
  "Reed",
  "Rocko",
  "Sandy",
  "Shelley",
  "Grandma",
  "Grandpa",
] as const;

export class SettingError extends Error {}

export type SettingsView = {
  readonly voice: string;
  readonly background: "wiki" | "plain";
  readonly topics: "trend" | "wiki" | "custom";
  readonly interests: readonly string[];
  readonly maxSeconds: number;
  readonly font: string;
};

export const viewSettings = (cfg: ShortsConfig): SettingsView => {
  const v = cfg.voice ?? [];
  const at = v.indexOf("-v");
  const topics = cfg.topics?.join(" ") ?? "";
  return {
    voice: v.length === 0 ? "없음(자막만)" : at >= 0 ? (v[at + 1] ?? "?") : v.join(" "),
    background: cfg.image?.length ? "wiki" : "plain",
    topics: topics.includes("trend-topics") ? "trend" : topics.includes("wiki-topics") ? "wiki" : "custom",
    interests: cfg.interests ?? [],
    maxSeconds: cfg.maxSeconds ?? 60,
    font: cfg.font ?? "/System/Library/Fonts/AppleSDGothicNeo.ttc",
  };
};

export const settingsText = (v: SettingsView, time: string): string =>
  [
    `목소리: ${v.voice} (바꿀 수 있는 것: ${KOREAN_VOICES.join(", ")}, none)`,
    `배경: ${v.background === "wiki" ? "위키백과 대표 사진" : "단색"} (wiki | plain)`,
    `주제: ${v.topics === "trend" ? "관심 분야 인기 영상 + 세상의 모든 것" : v.topics === "wiki" ? "세상의 모든 것(위키 랜덤)" : "직접 설정"} (trend | wiki)`,
    `관심 분야: ${v.interests.join(", ") || "-"}`,
    `최대 길이: ${v.maxSeconds}초`,
    `보내는 시간: 매일 ${time}`,
  ].join("\n");

/** `cli` is the argv prefix that runs this skill (bun + cli.ts), so a slot can call back into it. */
export const applySetting = (
  cfg: ShortsConfig,
  key: string,
  value: string,
  cli: readonly string[],
  fontExists: (path: string) => boolean,
): ShortsConfig => {
  const v = value.trim();
  switch (key) {
    case "voice": {
      if (v === "none") return { ...cfg, voice: [] };
      const name = KOREAN_VOICES.find((n) => n.toLowerCase() === v.toLowerCase());
      if (!name) throw new SettingError(`목소리는 ${KOREAN_VOICES.join(", ")}, none 중 하나`);
      return { ...cfg, voice: ["say", "-v", name, "-o", "{out}", "{text}"], voiceExt: "aiff" };
    }
    case "background":
      if (v === "plain") return { ...cfg, image: [] };
      if (v === "wiki") return { ...cfg, image: [...cli, "shorts", "wiki-image", "{topic}", "{out}"] };
      throw new SettingError("배경은 wiki 또는 plain");
    case "topics":
      if (v === "trend" || v === "wiki") return { ...cfg, topics: [...cli, "shorts", `${v}-topics`] };
      throw new SettingError("주제는 trend 또는 wiki");
    case "interests": {
      const list = v
        .split(/[,，]/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (list.length === 0 || list.length > 8) throw new SettingError("관심 분야는 쉼표로 1~8개");
      return { ...cfg, interests: list };
    }
    case "maxSeconds": {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 15 || n > 180) throw new SettingError("최대 길이는 15~180초 정수");
      return { ...cfg, maxSeconds: n };
    }
    case "font":
      if (!fontExists(v)) throw new SettingError(`폰트 파일이 없다: ${v}`);
      return { ...cfg, font: v };
    default:
      throw new SettingError(`바꿀 수 있는 것: voice, background, topics, interests, maxSeconds, font, time`);
  }
};

/** `HH:MM`, 24-hour. */
export const parseTime = (value: string): { hour: number; minute: number } => {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  if (!m) throw new SettingError("시간은 HH:MM (예: 09:00, 21:30)");
  return { hour: Number(m[1]), minute: Number(m[2]) };
};
