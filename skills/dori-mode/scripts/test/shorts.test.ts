import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Runner } from "../src/run.ts";
import { checkVideo, jobId, parseProbe, parseScript, parseTopics, ShortsError, topicsMessage } from "../src/shorts.ts";
import { prepareJob, renderAndCheck, shortsPaths } from "../src/shorts-run.ts";
import { diagnoseRender } from "../src/render-er.ts";

test("a script needs lines; blanks are dropped and the title is optional", () => {
  expect(parseScript('{"title":" T ","lines":["a"," ","b"]}')).toEqual({ title: "T", lines: ["a", "b"] });
  expect(parseScript('{"lines":["a"]}')).toEqual({ title: "", lines: ["a"] });
  expect(() => parseScript('{"lines":[]}')).toThrow(ShortsError);
  expect(() => parseScript("nope")).toThrow(ShortsError);
});

test("a job id is the minute and a slug of the topic, Korean kept", () => {
  expect(jobId("쇼츠 공장: 첫 테스트!", new Date("2026-11-22T13:14:59Z"))).toBe("202611221314-쇼츠-공장-첫-테스트");
  expect(jobId("!!!", new Date("2026-11-22T13:14:00Z"))).toBe("202611221314-short");
});

test("topics come one per line with list markers stripped, de-duplicated, three at most", () => {
  expect(parseTopics("1. 첫째\n- 둘째\n\n• 셋째\n첫째\n넷째")).toEqual(["첫째", "둘째", "셋째"]);
  expect(topicsMessage(["a", "b"])).toBe("오늘 쇼츠 주제 후보:\n1. a\n2. b\n\n번호로 답해 주면 그걸로 만든다.");
});

/** ffprobe -show_entries stream=codec_type,width,height:format=duration -of json, from a real render. */
const PROBE =
  '{"streams":[{"codec_type":"video","width":1080,"height":1920},{"codec_type":"audio"}],"format":{"duration":"6.710000"}}';

test("the check passes a vertical voiced video and names every problem otherwise", () => {
  const ok = parseProbe(PROBE);
  expect(ok).toEqual({ width: 1080, height: 1920, seconds: 6.71, audio: true });
  expect(checkVideo(ok, true, 60)).toEqual([]);
  expect(checkVideo({ width: 1920, height: 1080, seconds: 2, audio: false }, true, 60)).toEqual([
    "size 1920x1080, expected 1080x1920",
    "only 2.0s long",
    "voiced script but no audio track",
  ]);
  expect(checkVideo({ ...ok, seconds: 75 }, false, 60)).toEqual(["75.0s is over 60s"]);
});

const fakeRun =
  (calls: string[][], answer: (argv: readonly string[]) => { code: number; out?: string; err?: string }): Runner =>
  async (argv) => {
    calls.push([...argv]);
    const a = answer(argv);
    return { code: a.code, out: a.out ?? "", err: a.err ?? "" };
  };

test("prepare fills the script, voice and image slots per line with the line's text and output path", async () => {
  const dir = join(mkdtempSync(join(tmpdir(), "shorts-")), "job");
  const calls: string[][] = [];
  const run = fakeRun(calls, (argv) => {
    if (argv[0] === "write-script") writeFileSync(argv[2]!, '{"title":"t","lines":["하나","둘"]}');
    return { code: 0 };
  });
  const script = await prepareJob(
    run,
    {
      script: ["write-script", "{topic}", "{out}"],
      voice: ["tts", "{text}", "{out}"],
      image: ["img", "{text}", "{out}"],
    },
    dir,
    "주제",
  );
  expect(script.lines).toEqual(["하나", "둘"]);
  expect(readFileSync(join(dir, "topic.txt"), "utf8")).toBe("주제\n");
  expect(calls.slice(1)).toEqual([
    ["tts", "하나", join(dir, "voice", "0.aiff")],
    ["tts", "둘", join(dir, "voice", "1.aiff")],
    ["img", "하나", join(dir, "images", "0.png")],
    ["img", "둘", join(dir, "images", "1.png")],
  ]);
});

test("without a script slot or file the job stops before anything runs; a failing slot names itself", async () => {
  const dir = join(mkdtempSync(join(tmpdir(), "shorts-")), "job");
  await expect(
    prepareJob(
      fakeRun([], () => ({ code: 0 })),
      {},
      dir,
      "t",
    ),
  ).rejects.toThrow("no script");
  await expect(
    prepareJob(
      fakeRun([], () => ({ code: 2, err: "boom" })),
      { script: ["s", "{out}"] },
      dir,
      "t",
    ),
  ).rejects.toThrow("script slot failed (exit 2): boom");
});

test("a failed render leaves a log the render hospital can read, and a clean one it ignores", async () => {
  const state = mkdtempSync(join(tmpdir(), "shorts-"));
  const paths = shortsPaths(state);
  const failing = fakeRun([], () => ({
    code: 1,
    err: "ValueError: Invalid font x.ttf, pillow failed: cannot open resource",
  }));
  await expect(renderAndCheck(failing, {}, paths, "j1")).rejects.toThrow("dori render-er");
  expect(diagnoseRender("j1", readFileSync(join(paths.logs, "j1.log"), "utf8"))?.kind).toBe("font");
  const passing = fakeRun([], (argv) =>
    argv[0] === "ffprobe" ? { code: 0, out: PROBE } : { code: 0, err: "some Error-looking warning" },
  );
  const out = await renderAndCheck(passing, { voice: ["tts"] }, paths, "j2");
  expect(out.problems).toEqual([]);
  expect(diagnoseRender("j2", readFileSync(join(paths.logs, "j2.log"), "utf8"))).toBeNull();
  expect(existsSync(join(paths.logs, "j2.log"))).toBe(true);
});

test("the finished video goes to Telegram as one multipart sendVideo with the chat, topic and caption", async () => {
  const { Telegram } = await import("../src/messenger/telegram.ts");
  const seen: { url: string; form: FormData }[] = [];
  const http = async (req: { url: string; body?: unknown }) => {
    seen.push({ url: req.url, form: req.body as FormData });
    return { status: 200, headers: {}, body: '{"ok":true,"result":{"message_id":77}}' };
  };
  const tg = new Telegram(http, { now: () => 0, sleep: async () => {} }, "TOKEN", "https://tg.test");
  const id = await tg.sendVideo({ chatId: "-100", threadId: 5 }, new Uint8Array([1, 2, 3]), "a.mp4", "제목");
  expect(id).toBe(77);
  expect(seen[0]?.url).toBe("https://tg.test/botTOKEN/sendVideo");
  const form = seen[0]!.form;
  expect([form.get("chat_id"), form.get("message_thread_id"), form.get("caption")]).toEqual(["-100", "5", "제목"]);
  expect((form.get("video") as File).name).toBe("a.mp4");
  expect((form.get("video") as File).size).toBe(3);
});
