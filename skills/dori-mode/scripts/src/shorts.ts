/**
 * The shorts factory: topic -> script -> voice -> images -> render -> check -> send, one job folder per video
 * under `<stateDir>/shorts/jobs/<job>/`. Topic, script, voice and image are slots the owner fills in config
 * `shorts` with any command; render (MoviePy), check (ffprobe) and send (Telegram) are built in. An empty voice
 * slot makes a captions-only video and an empty image slot a plain background, so a job can run end to end with
 * only a script. The render log goes to `<stateDir>/shorts/logs/<job>.log`, the folder `dori render-er` reads.
 */
import type { ArgvTemplate } from "./config.ts";
import type { YoutubeConfig } from "./shorts-youtube.ts";

export type ShortsConfig = {
  /** Prints candidate topics, one per line. */
  readonly topics?: ArgvTemplate;
  /** Writes `{"title": ..., "lines": [...]}` to `{out}` for `{topic}`. */
  readonly script?: ArgvTemplate;
  /** Writes the spoken `{text}` to the audio file `{out}` (the extension is the slot's choice via `voiceExt`). */
  readonly voice?: ArgvTemplate;
  readonly voiceExt?: string;
  /** Writes an image for the scene `{text}` to `{out}` (`imageExt`, default png). */
  readonly image?: ArgvTemplate;
  readonly imageExt?: string;
  /** Python with moviepy, and the caption font. */
  readonly python?: string;
  readonly font?: string;
  /** Telegram chat (and topic) the finished video goes to. */
  readonly sendChat?: string;
  readonly sendThread?: number;
  readonly maxSeconds?: number;
  /** No longer read: scripts and trend topics ask `scriptModel` (default: config defaultModel) on its OmO provider directly. */
  readonly omo?: string;
  readonly scriptModel?: string;
  /** Sends a text `{text}` / a video `{file}` with `{caption}` to `{chat}`, when no DORI_TELEGRAM_TOKEN is set. */
  readonly sendTextArgv?: ArgvTemplate;
  readonly sendVideoArgv?: ArgvTemplate;
  /** The owner's interests: YouTube searches whose popular titles steer the trend topics (`shorts trend-topics`). */
  readonly interests?: readonly string[];
  /** Upload each checked video to the owner's channel (private by default, AI-made declared). */
  readonly youtube?: YoutubeConfig;
};

export type Script = { readonly title: string; readonly lines: readonly string[] };

export class ShortsError extends Error {}

export const parseScript = (text: string): Script => {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ShortsError("script is not JSON");
  }
  const r = raw as { title?: unknown; lines?: unknown };
  const lines = Array.isArray(r.lines) ? r.lines.map((l) => String(l).trim()).filter(Boolean) : [];
  if (lines.length === 0) throw new ShortsError('script needs a non-empty "lines" array');
  return { title: typeof r.title === "string" ? r.title.trim() : "", lines };
};

/** A job id: the date and a slug of the topic, safe as a file name and unique enough per day. */
export const jobId = (topic: string, now: Date): string => {
  const slug =
    topic
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "short";
  return `${now.toISOString().slice(0, 16).replace(/[-:T]/g, "")}-${slug}`;
};

export const parseTopics = (out: string, limit = 3): string[] =>
  [...new Set(out.split("\n").map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim()))]
    .filter(Boolean)
    .slice(0, limit);

export const topicsMessage = (topics: readonly string[]): string =>
  ["오늘 쇼츠 주제 후보:", ...topics.map((t, i) => `${i + 1}. ${t}`), "", "번호로 답해 주면 그걸로 만든다."].join("\n");

export type Probe = {
  readonly width: number;
  readonly height: number;
  readonly seconds: number;
  readonly audio: boolean;
};

export const parseProbe = (json: string): Probe => {
  const p = JSON.parse(json) as {
    streams?: { codec_type?: string; width?: number; height?: number }[];
    format?: { duration?: string };
  };
  const video = p.streams?.find((s) => s.codec_type === "video");
  return {
    width: video?.width ?? 0,
    height: video?.height ?? 0,
    seconds: Number(p.format?.duration ?? 0),
    audio: (p.streams ?? []).some((s) => s.codec_type === "audio"),
  };
};

/** What a finished video must be before it is sent: vertical 1080x1920, a sane length, sound when it was voiced. */
export const checkVideo = (p: Probe, voiced: boolean, maxSeconds: number): string[] => {
  const problems: string[] = [];
  if (p.width !== 1080 || p.height !== 1920) problems.push(`size ${p.width}x${p.height}, expected 1080x1920`);
  if (!(p.seconds >= 3)) problems.push(`only ${p.seconds.toFixed(1)}s long`);
  if (p.seconds > maxSeconds) problems.push(`${p.seconds.toFixed(1)}s is over ${maxSeconds}s`);
  if (voiced && !p.audio) problems.push("voiced script but no audio track");
  return problems;
};
