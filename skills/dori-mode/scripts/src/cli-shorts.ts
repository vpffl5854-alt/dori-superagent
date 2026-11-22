/** dori shorts topics | make | render: the shorts factory (src/shorts.ts, src/shorts-run.ts). */
import { readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { type Command, die } from "./cli-context.ts";
import { fill } from "./config.ts";
import { fetchHttp } from "./messenger/http.ts";
import { Telegram, type TgTarget } from "./messenger/telegram.ts";
import { realClock, run } from "./run.ts";
import { jobId, parseScript, parseTopics, ShortsError, type ShortsConfig, topicsMessage } from "./shorts.ts";
import { extractJson, randomTopics, scriptPrompt, wikiPage } from "./shorts-wiki.ts";
import { prepareJob, renderAndCheck, shortsPaths } from "./shorts-run.ts";

type Sender = { text(text: string): Promise<string>; video(file: string, caption: string): Promise<string> };

/** The built-in Bot API client when DORI_TELEGRAM_TOKEN is set, else the configured commands (agent-telegrambot). */
const sender = (cfg: ShortsConfig): Sender | null => {
  const chat = cfg.sendChat;
  if (!chat) return null;
  const token = process.env["DORI_TELEGRAM_TOKEN"];
  if (token) {
    const tg = new Telegram(fetchHttp, realClock, token);
    const target: TgTarget = { chatId: chat, ...(cfg.sendThread ? { threadId: cfg.sendThread } : {}) };
    return {
      text: async (text) => String(await tg.send(target, text)),
      video: async (file, caption) =>
        String(await tg.sendVideo(target, new Uint8Array(readFileSync(file)), basename(file), caption)),
    };
  }
  const { sendTextArgv: textArgv, sendVideoArgv: videoArgv } = cfg;
  if (!textArgv?.length || !videoArgv?.length) return null;
  const send = async (argv: readonly string[]) => {
    const r = await run(argv, { timeoutMs: 120_000 });
    if (r.code !== 0) throw new ShortsError(`send failed (exit ${r.code}): ${r.err.slice(0, 200)}`);
    return r.out.slice(0, 80) || "ok";
  };
  return {
    text: (text) => send(fill(textArgv, { chat, text })),
    video: (file, caption) => send(fill(videoArgv, { chat, file, caption })),
  };
};

const shorts: Command = async ({ positionals, opt, values, config }) => {
  const cfg = config.shorts ?? {};
  const paths = shortsPaths(config.stateDir);
  const candidates = join(config.stateDir, "shorts", "candidates.json");
  const sub = positionals[0];
  try {
    if (sub === "topics") {
      const slot = cfg.topics?.length ? cfg.topics : die("no topics slot: fill config shorts.topics");
      const r = await run([...slot], { timeoutMs: 120_000 });
      if (r.code !== 0) die(`topics slot failed (exit ${r.code}): ${r.err.slice(0, 200)}`);
      const topics = parseTopics(r.out);
      if (topics.length === 0) die("the topics slot printed no topic");
      writeFileSync(candidates, JSON.stringify(topics));
      for (const [i, t] of topics.entries()) console.log(`TOPIC ${i + 1} ${JSON.stringify(t)}`);
      const out = values["no-send"] === true ? null : sender(cfg);
      if (out) console.log(`TOPICS_SENT ${await out.text(topicsMessage(topics))}`);
      return;
    }
    if (sub === "make") {
      const pick = opt("pick");
      // --auto: no question asked, a random topic from the topics slot (the daily run).
      const auto = values["auto"] === true ? await autoTopic(cfg) : undefined;
      const topic =
        auto ??
        opt("topic") ??
        (pick
          ? ((JSON.parse(readFileSync(candidates, "utf8")) as string[])[Number(pick) - 1] ??
            die(`no candidate ${pick}`))
          : undefined) ??
        die("make needs --topic TEXT, --pick N (after `dori shorts topics`) or --script FILE with --topic");
      const job = jobId(topic, new Date());
      await prepareJob(run, cfg, join(paths.jobs, job), topic, opt("script"));
      console.log(`SHORTS_JOB ${job}`);
      return await finish(cfg, paths, job, values["no-send"] === true);
    }
    if (sub === "wiki-topics") return void console.log((await randomTopics(fetchHttp)).join("\n"));
    if (sub === "wiki-script") {
      const [, title = die("wiki-script needs a title"), out = die("wiki-script needs an output path")] = positionals;
      const prompt = scriptPrompt(await wikiPage(fetchHttp, title));
      const omo = cfg.omo ?? "omo";
      let last = "";
      for (let attempt = 0; attempt < 2; attempt++) {
        const r = await run([omo, "--model", cfg.scriptModel ?? config.defaultModel, "-p", prompt], {
          timeoutMs: 180_000,
        });
        try {
          const json = extractJson(r.out);
          parseScript(json);
          return void writeFileSync(out, json);
        } catch (e) {
          last = e instanceof Error ? e.message : String(e);
        }
      }
      die(`SHORTS_FAILED the model wrote no usable script: ${last}`);
    }
    if (sub === "wiki-image") {
      const [, title = die("wiki-image needs a title"), out = die("wiki-image needs an output path")] = positionals;
      const url = (await wikiPage(fetchHttp, title)).image;
      // No lead image, or a format the renderer cannot read (SVG, GIF): the scene keeps its plain background.
      if (!url || !/\.(?:jpe?g|png|webp)$/i.test(url)) return;
      const res = await fetch(url, { headers: { "User-Agent": "dori-shorts/0.1" } });
      if (!res.ok) die(`wiki-image ${res.status}`);
      return void writeFileSync(out, new Uint8Array(await res.arrayBuffer()));
    }
    if (sub === "render") return await finish(cfg, paths, positionals[1] ?? die("render needs a job id"), true);
    die("shorts needs topics, make or render");
  } catch (e) {
    if (e instanceof ShortsError) die(`SHORTS_FAILED ${e.message}`);
    throw e;
  }
};

const finish = async (cfg: ShortsConfig, paths: ReturnType<typeof shortsPaths>, job: string, noSend: boolean) => {
  const { video, problems } = await renderAndCheck(run, cfg, paths, job);
  if (problems.length > 0) die(`SHORTS_CHECK_FAILED ${job} ${problems.join("; ")}`, 3);
  console.log(`SHORTS_OK ${video}`);
  const out = noSend ? null : sender(cfg);
  if (!out) return;
  const title = readFileSync(join(paths.jobs, job, "topic.txt"), "utf8").trim();
  console.log(`SHORTS_SENT ${await out.video(video, title)}`);
};

const autoTopic = async (cfg: ShortsConfig): Promise<string> => {
  const slot = cfg.topics?.length ? cfg.topics : die("--auto needs config shorts.topics");
  const r = await run([...slot], { timeoutMs: 120_000 });
  const topics = parseTopics(r.out);
  if (r.code !== 0 || topics.length === 0) die(`SHORTS_FAILED topics slot gave nothing (exit ${r.code})`);
  return topics[Math.floor(Math.random() * topics.length)] as string;
};

export const shortsCommands: Readonly<Record<string, Command>> = { shorts };
