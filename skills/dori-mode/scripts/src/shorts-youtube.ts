/**
 * The shorts factory's YouTube step: upload the checked video to the owner's channel with everything that should be
 * declared declared: private by default (the owner makes it public after a look), `containsSyntheticMedia` (the
 * script is written by a model and the voice is synthetic), not made for kids, and the Wikipedia source with its
 * licence in the description. The OAuth token file is the one `~/.dori/tools/youtube/oauth-setup.py` writes.
 */
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import type { Http } from "./messenger/http.ts";
import { type Script, ShortsError } from "./shorts.ts";

export type YoutubeConfig = {
  readonly tokenPath: string;
  readonly clientSecretPath: string;
  /** `private` until the owner says otherwise; `unlisted` and `public` are allowed. */
  readonly privacy?: "private" | "unlisted" | "public";
  /** 27 is Education: facts from an encyclopedia. */
  readonly categoryId?: string;
};

export type VideoMeta = {
  readonly title: string;
  readonly description: string;
  readonly tags: readonly string[];
};

export const wikiUrl = (topic: string): string =>
  `https://ko.wikipedia.org/wiki/${encodeURIComponent(topic.replaceAll(" ", "_"))}`;

export const videoMeta = (topic: string, script: Script, imageSource: string | null): VideoMeta => {
  const base = (script.title || topic).replace(/[<>]/g, "").trim();
  return {
    title: `${base} #Shorts`.slice(0, 100),
    description: [
      script.lines[0] ?? base,
      "",
      `📚 출처: 위키백과 「${topic}」 ${wikiUrl(topic)}`,
      "   본문은 CC BY-SA 4.0 라이선스를 따릅니다.",
      ...(imageSource ? [`🖼 이미지: 위키미디어 공용 (${imageSource}), 파일별 라이선스를 따릅니다.`] : []),
      "",
      "🤖 AI 고지: 대본은 AI가 위키백과 요약을 바탕으로 작성했고, 목소리는 합성 음성입니다.",
      "   내용에 오류가 있을 수 있으니 출처 문서를 함께 확인해 주세요.",
      "",
      "#Shorts #상식 #위키백과",
    ].join("\n"),
    tags: ["Shorts", "상식", "위키백과", topic].map((t) => t.slice(0, 30)),
  };
};

type Token = { access_token: string; refresh_token?: string; expires_at?: number; [k: string]: unknown };

/** A fresh access token: refreshed through Google when it expires within a minute, and saved back (0600). */
export const accessToken = async (http: Http, cfg: YoutubeConfig, now: number): Promise<string> => {
  const token = JSON.parse(readFileSync(cfg.tokenPath, "utf8")) as Token;
  if (token.expires_at && token.expires_at * 1000 > now + 60_000) return token.access_token;
  if (!token.refresh_token) throw new ShortsError("youtube token has no refresh_token: log in again");
  const secret = JSON.parse(readFileSync(cfg.clientSecretPath, "utf8")) as Record<
    string,
    { client_id: string; client_secret: string }
  >;
  const c = secret["installed"] ?? secret["web"];
  if (!c) throw new ShortsError("youtube client secret file has no installed/web client");
  const res = await http({
    method: "POST",
    url: "https://oauth2.googleapis.com/token",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: c.client_id,
      client_secret: c.client_secret,
      refresh_token: token.refresh_token,
      grant_type: "refresh_token",
    }).toString(),
  });
  if (res.status !== 200)
    throw new ShortsError(`youtube token refresh ${res.status}: log in again (${res.body.slice(0, 120)})`);
  const body = JSON.parse(res.body) as { access_token: string; expires_in?: number };
  const next = {
    ...token,
    access_token: body.access_token,
    expires_at: Math.floor(now / 1000) + (body.expires_in ?? 3600),
  };
  writeFileSync(cfg.tokenPath, JSON.stringify(next, null, 2));
  chmodSync(cfg.tokenPath, 0o600);
  return body.access_token;
};

/** The videos.insert body: everything the owner wants declared is set explicitly, never left to a default. */
export const insertResource = (meta: VideoMeta, cfg: YoutubeConfig) => ({
  snippet: {
    title: meta.title,
    description: meta.description.slice(0, 5000),
    tags: meta.tags,
    categoryId: cfg.categoryId ?? "27",
    defaultLanguage: "ko",
    defaultAudioLanguage: "ko",
  },
  status: {
    privacyStatus: cfg.privacy ?? "private",
    selfDeclaredMadeForKids: false,
    containsSyntheticMedia: true,
    embeddable: true,
    license: "youtube",
  },
});

export const uploadVideo = async (
  http: Http,
  cfg: YoutubeConfig,
  video: Uint8Array,
  meta: VideoMeta,
  now: number,
): Promise<{ readonly id: string; readonly url: string; readonly privacy: string }> => {
  const token = await accessToken(http, cfg, now);
  const boundary = `dori-${now}`;
  const enc = new TextEncoder();
  const head = enc.encode(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(insertResource(meta, cfg))}\r\n--${boundary}\r\nContent-Type: video/mp4\r\n\r\n`,
  );
  const tail = enc.encode(`\r\n--${boundary}--\r\n`);
  const body = new Uint8Array(head.length + video.length + tail.length);
  body.set(head, 0);
  body.set(video, head.length);
  body.set(tail, head.length + video.length);
  const res = await http({
    method: "POST",
    url: "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=multipart&part=snippet,status",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": `multipart/related; boundary=${boundary}` },
    body,
  });
  if (res.status !== 200) throw new ShortsError(`youtube upload ${res.status}: ${res.body.slice(0, 200)}`);
  const out = JSON.parse(res.body) as { id: string; status?: { privacyStatus?: string } };
  return { id: out.id, url: `https://youtube.com/shorts/${out.id}`, privacy: out.status?.privacyStatus ?? "?" };
};
