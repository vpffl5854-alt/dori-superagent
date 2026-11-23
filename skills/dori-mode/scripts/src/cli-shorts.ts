/** dori shorts topics | make | render: the shorts factory (src/shorts.ts, src/shorts-run.ts). */
import { copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { type Command, die } from "./cli-context.ts";
import { configPath, fill } from "./config.ts";
import { fetchHttp } from "./messenger/http.ts";
import { Telegram, type TgTarget } from "./messenger/telegram.ts";
import { realClock, run } from "./run.ts";
import { jobId, parseScript, parseTopics, ShortsError, type ShortsConfig, topicsMessage } from "./shorts.ts";
import { applySetting, parseTime, SettingError, settingsText, viewSettings } from "./shorts-settings.ts";
import { parseHeadwords, TOPICS_SLOT_MS, TREND_MODEL_MS, trendPrompt, trendTitles } from "./shorts-trend.ts";
import {
  extractJson,
  MIN_EXTRACT,
  randomTopics,
  renderableImage,
  scriptPrompt,
  WIKI_UA,
  wikiPage,
} from "./shorts-wiki.ts";
import { prepareJob, renderAndCheck, shortsPaths } from "./shorts-run.ts";
import { setVisibility, uploadVideo, videoMeta } from "./shorts-youtube.ts";

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
      const r = await run([...slot], { timeoutMs: TOPICS_SLOT_MS });
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
    if (sub === "trend-topics") {
      // Two topics steered by what is popular in the owner's interests, the rest from "everything in the world".
      const titles = trendTitles(join(config.stateDir, "sns", "latest"), cfg.interests ?? [], Date.now());
      const picked: string[] = [];
      if (titles.length > 0 && cfg.omo) {
        const r = await run(
          [cfg.omo, "--model", cfg.scriptModel ?? config.defaultModel, "-p", trendPrompt(titles, cfg.interests ?? [])],
          { timeoutMs: TREND_MODEL_MS },
        );
        for (const word of parseHeadwords(r.out).sort(() => Math.random() - 0.5)) {
          if (picked.length >= 2) break;
          const page = await wikiPage(fetchHttp, word).catch(() => null);
          if (page && page.extract.length >= MIN_EXTRACT && !picked.includes(page.title)) picked.push(page.title);
        }
      }
      for (const t of await randomTopics(fetchHttp)) if (picked.length < 3 && !picked.includes(t)) picked.push(t);
      return void console.log(picked.join("\n"));
    }
    if (sub === "config") return await settings(positionals.slice(1), config.shorts ?? {});
    if (sub === "publish" || sub === "private") {
      // `latest` (or nothing) is the newest uploaded job; the owner usually means the one he just watched in Telegram.
      const yt = cfg.youtube ?? die("no shorts.youtube configured");
      const want = positionals[1] && positionals[1] !== "latest" ? positionals[1] : undefined;
      const jobs = (existsSync(paths.jobs) ? readdirSync(paths.jobs) : [])
        .filter((j) => existsSync(join(paths.jobs, j, "youtube.json")))
        .sort();
      const job = want ?? jobs.at(-1) ?? die("no uploaded short yet");
      const record = JSON.parse(readFileSync(join(paths.jobs, job, "youtube.json"), "utf8")) as {
        id: string;
        url: string;
      };
      const r = await setVisibility(fetchHttp, yt, record.id, sub === "publish" ? "public" : "private", Date.now());
      writeFileSync(
        join(paths.jobs, job, "youtube.json"),
        JSON.stringify({ ...record, privacy: r.privacy, changedAt: new Date().toISOString() }, null, 2),
      );
      return void console.log(`SHORTS_VISIBILITY ${job} ${r.privacy} synthetic=${r.synthetic} ${record.url}`);
    }
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
      const lead = (await wikiPage(fetchHttp, title)).image;
      const url = lead ? renderableImage(lead) : null;
      // No lead image, or a format the renderer cannot read (SVG, GIF): the scene keeps its plain background.
      if (!url) return;
      // Every line of a job shows the same lead image: fetch it once, copy it after (Wikimedia answers 429 to repeats).
      const source = join(dirname(out), "source.txt");
      const have =
        existsSync(source) &&
        readFileSync(source, "utf8").trim() === url &&
        readdirSync(dirname(out)).find((f) => f !== "source.txt");
      if (have) return void copyFileSync(join(dirname(out), have), out);
      const res = await fetch(url, { headers: WIKI_UA });
      if (!res.ok) return void console.error(`wiki-image ${res.status}: this scene keeps its plain background`);
      writeFileSync(out, new Uint8Array(await res.arrayBuffer()));
      // The upload's description credits the image: its source sits beside it.
      return void writeFileSync(source, url);
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
  const dir = join(paths.jobs, job);
  const title = readFileSync(join(dir, "topic.txt"), "utf8").trim();
  if (out) console.log(`SHORTS_SENT ${await out.video(video, title)}`);
  if (noSend || !cfg.youtube) return;
  const source = join(dir, "images", "source.txt");
  const meta = videoMeta(
    title,
    parseScript(readFileSync(join(dir, "script.json"), "utf8")),
    existsSync(source) ? readFileSync(source, "utf8").trim() : null,
  );
  const up = await uploadVideo(fetchHttp, cfg.youtube, new Uint8Array(readFileSync(video)), meta, Date.now());
  writeFileSync(join(dir, "youtube.json"), JSON.stringify({ ...up, at: new Date().toISOString(), meta }, null, 2));
  console.log(`SHORTS_UPLOADED ${up.url} privacy=${up.privacy}`);
  if (out)
    await out.text(
      `유튜브에 ${up.privacy === "private" ? "비공개로" : up.privacy} 올렸어: ${up.url}\n(AI 생성 표시·위키백과 출처 포함. 공개는 유튜브 스튜디오에서)`,
    );
};

const autoTopic = async (cfg: ShortsConfig): Promise<string> => {
  const slot = cfg.topics?.length ? cfg.topics : die("--auto needs config shorts.topics");
  const r = await run([...slot], { timeoutMs: TOPICS_SLOT_MS });
  const topics = parseTopics(r.out);
  if (r.code !== 0 || topics.length === 0) die(`SHORTS_FAILED topics slot gave nothing (exit ${r.code})`);
  return topics[Math.floor(Math.random() * topics.length)] as string;
};

const PLIST = join(process.env["HOME"] ?? "", "Library", "LaunchAgents", "com.dori.shorts-daily.plist");
const SELF_CLI = [process.execPath, "run", join(import.meta.dir, "cli.ts")];

const dailyTime = async (): Promise<string> => {
  const read = async (k: string) => (await run(["plutil", "-extract", `StartCalendarInterval.${k}`, "raw", PLIST])).out;
  const [h, m] = [await read("Hour"), await read("Minute")];
  return h && m ? `${h.padStart(2, "0")}:${m.padStart(2, "0")}` : "예약 없음";
};

/** `shorts config` shows the settings; `shorts config <key> <value>` changes one, backing the config file up first. */
const settings = async ([key, ...rest]: readonly string[], cfg: ShortsConfig) => {
  if (!key) return void console.log(settingsText(viewSettings(cfg), await dailyTime()));
  const value = rest.join(" ");
  try {
    if (key === "time") {
      const { hour, minute } = parseTime(value);
      for (const [k, n] of [
        ["Hour", hour],
        ["Minute", minute],
      ] as const)
        await run(["plutil", "-replace", `StartCalendarInterval.${k}`, "-integer", String(n), PLIST]);
      const uid = String(process.getuid?.() ?? "");
      await run(["launchctl", "bootout", `gui/${uid}/com.dori.shorts-daily`]);
      const r = await run(["launchctl", "bootstrap", `gui/${uid}`, PLIST]);
      if (r.code !== 0) die(`SHORTS_CONFIG_FAILED launchd: ${r.err.slice(0, 160)}`);
      return void console.log(`SHORTS_CONFIG time=${await dailyTime()}`);
    }
    const next = applySetting(cfg, key, value, SELF_CLI, existsSync);
    const path = configPath();
    copyFileSync(path, `${path}.bak-shorts-config-${new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15)}`);
    const all = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    writeFileSync(path, `${JSON.stringify({ ...all, shorts: next }, null, 2)}\n`);
    console.log(`SHORTS_CONFIG ${key}=${value}`);
    console.log(settingsText(viewSettings(next), await dailyTime()));
  } catch (e) {
    if (e instanceof SettingError) die(`SHORTS_CONFIG_REFUSED ${e.message}`);
    throw e;
  }
};

export const shortsCommands: Readonly<Record<string, Command>> = { shorts };
