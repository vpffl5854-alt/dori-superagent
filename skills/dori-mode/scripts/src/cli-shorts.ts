/** dori shorts topics | make | render: the shorts factory (src/shorts.ts, src/shorts-run.ts). */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Command, die } from "./cli-context.ts";
import { fetchHttp } from "./messenger/http.ts";
import { Telegram, type TgTarget } from "./messenger/telegram.ts";
import { realClock, run } from "./run.ts";
import { jobId, parseTopics, ShortsError, type ShortsConfig, topicsMessage } from "./shorts.ts";
import { prepareJob, renderAndCheck, shortsPaths } from "./shorts-run.ts";

const telegram = (cfg: ShortsConfig): { tg: Telegram; target: TgTarget } | null => {
  const token = process.env["DORI_TELEGRAM_TOKEN"];
  if (!token || !cfg.sendChat) return null;
  return {
    tg: new Telegram(fetchHttp, realClock, token),
    target: { chatId: cfg.sendChat, ...(cfg.sendThread ? { threadId: cfg.sendThread } : {}) },
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
      const r = await run([...slot]);
      if (r.code !== 0) die(`topics slot failed (exit ${r.code}): ${r.err.slice(0, 200)}`);
      const topics = parseTopics(r.out);
      if (topics.length === 0) die("the topics slot printed no topic");
      writeFileSync(candidates, JSON.stringify(topics));
      for (const [i, t] of topics.entries()) console.log(`TOPIC ${i + 1} ${JSON.stringify(t)}`);
      const t = telegram(cfg);
      if (t && values["no-send"] !== true)
        console.log(`TOPICS_SENT ${await t.tg.send(t.target, topicsMessage(topics))}`);
      return;
    }
    if (sub === "make") {
      const pick = opt("pick");
      const topic =
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
  const t = noSend ? null : telegram(cfg);
  if (!t) return;
  const title = readFileSync(join(paths.jobs, job, "topic.txt"), "utf8").trim();
  const bytes = new Uint8Array(readFileSync(video));
  console.log(`SHORTS_SENT ${await t.tg.sendVideo(t.target, bytes, `${job}.mp4`, title)}`);
};

export const shortsCommands: Readonly<Record<string, Command>> = { shorts };
