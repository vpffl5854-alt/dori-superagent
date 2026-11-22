import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { HttpRequest } from "../src/messenger/http.ts";
import { accessToken, insertResource, uploadVideo, videoMeta, wikiUrl } from "../src/shorts-youtube.ts";

const script = { title: "AI가 창작하는 시대", lines: ["AI가 글과 그림을 직접 창작한다고?", "둘째 줄"] };

test("the description credits Wikipedia and its licence, the image source, and says the script and voice are AI-made", () => {
  const meta = videoMeta("생성형 인공지능", script, "https://upload.wikimedia.org/a.jpg");
  expect(meta.title).toBe("AI가 창작하는 시대 #Shorts");
  expect(meta.description).toContain(wikiUrl("생성형 인공지능"));
  expect(meta.description).toContain("CC BY-SA 4.0");
  expect(meta.description).toContain("https://upload.wikimedia.org/a.jpg");
  expect(meta.description).toContain("AI 고지");
  expect(videoMeta("x", { title: "", lines: ["a"] }, null).description).not.toContain("🖼");
});

test("every declaration is explicit: private, AI-made, not for kids, Education, Korean", () => {
  const r = insertResource(videoMeta("t", script, null), { tokenPath: "", clientSecretPath: "" });
  expect(r.status).toEqual({
    privacyStatus: "private",
    selfDeclaredMadeForKids: false,
    containsSyntheticMedia: true,
    embeddable: true,
    license: "youtube",
  });
  expect(r.snippet).toMatchObject({ categoryId: "27", defaultLanguage: "ko", defaultAudioLanguage: "ko" });
});

const files = (expiresAt: number) => {
  const dir = mkdtempSync(join(tmpdir(), "yt-"));
  const tokenPath = join(dir, "token.json");
  const clientSecretPath = join(dir, "secret.json");
  writeFileSync(tokenPath, JSON.stringify({ access_token: "old", refresh_token: "r", expires_at: expiresAt }));
  writeFileSync(clientSecretPath, JSON.stringify({ installed: { client_id: "cid", client_secret: "cs" } }));
  return { tokenPath, clientSecretPath };
};

test("a live token is used as is; an expiring one is refreshed and saved 0600", async () => {
  const now = 1_000_000_000_000;
  const calls: HttpRequest[] = [];
  const http = async (req: HttpRequest) => {
    calls.push(req);
    return { status: 200, headers: {}, body: '{"access_token":"new","expires_in":3600}' };
  };
  expect(await accessToken(http, files(now / 1000 + 3600), now)).toBe("old");
  expect(calls).toHaveLength(0);
  const cfg = files(now / 1000 + 10);
  expect(await accessToken(http, cfg, now)).toBe("new");
  expect(String(calls[0]?.body)).toContain("grant_type=refresh_token");
  expect(JSON.parse(readFileSync(cfg.tokenPath, "utf8"))).toMatchObject({ access_token: "new", refresh_token: "r" });
  expect(statSync(cfg.tokenPath).mode & 0o777).toBe(0o600);
});

test("the upload is one multipart request with the metadata first and the video after it", async () => {
  const now = 1_000_000_000_000;
  let sent: HttpRequest | undefined;
  const http = async (req: HttpRequest) => {
    sent = req;
    return { status: 200, headers: {}, body: '{"id":"abc","status":{"privacyStatus":"private"}}' };
  };
  const out = await uploadVideo(
    http,
    files(now / 1000 + 3600),
    new Uint8Array([7, 7, 7]),
    videoMeta("t", script, null),
    now,
  );
  expect(out).toEqual({ id: "abc", url: "https://youtube.com/shorts/abc", privacy: "private" });
  expect(sent?.url).toContain("uploadType=multipart&part=snippet,status");
  expect(sent?.headers?.["Authorization"]).toBe("Bearer old");
  const text = new TextDecoder().decode(sent?.body as Uint8Array);
  expect(text.indexOf('"containsSyntheticMedia":true')).toBeLessThan(text.indexOf("video/mp4"));
});
