/** The shorts factory's steps over a job folder; every command goes through the injected runner. */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fill } from "./config.ts";
import type { Runner } from "./run.ts";
import { checkVideo, parseProbe, parseScript, type Script, ShortsError, type ShortsConfig } from "./shorts.ts";

export const DEFAULT_FONT = "/System/Library/Fonts/AppleSDGothicNeo.ttc";
export const RENDER_SCRIPT = join(dirname(import.meta.dir), "shorts", "render.py");
const RENDER_TIMEOUT_MS = 15 * 60_000;

export type ShortsPaths = { readonly jobs: string; readonly logs: string };
export const shortsPaths = (stateDir: string): ShortsPaths => ({
  jobs: join(stateDir, "shorts", "jobs"),
  logs: join(stateDir, "shorts", "logs"),
});

const must = async (run: Runner, argv: readonly string[], what: string): Promise<string> => {
  const r = await run(argv, { timeoutMs: RENDER_TIMEOUT_MS });
  if (r.code !== 0) throw new ShortsError(`${what} failed (exit ${r.code}): ${r.err.slice(0, 200)}`);
  return r.out;
};

/** Steps 1-4: the job folder, its script (given, or from the script slot), voice and images per line. */
export const prepareJob = async (
  run: Runner,
  cfg: ShortsConfig,
  dir: string,
  topic: string,
  scriptFile?: string,
): Promise<Script> => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "topic.txt"), `${topic}\n`);
  const scriptPath = join(dir, "script.json");
  if (scriptFile) copyFileSync(scriptFile, scriptPath);
  else if (cfg.script?.length) await must(run, fill(cfg.script, { topic, out: scriptPath }), "script slot");
  else throw new ShortsError("no script: fill config shorts.script or pass --script FILE");
  if (!existsSync(scriptPath)) throw new ShortsError("the script slot wrote no script.json");
  const script = parseScript(readFileSync(scriptPath, "utf8"));
  for (const [slot, ext, folder] of [
    [cfg.voice, cfg.voiceExt ?? "aiff", "voice"],
    [cfg.image, cfg.imageExt ?? "png", "images"],
  ] as const) {
    if (!slot?.length) continue;
    mkdirSync(join(dir, folder), { recursive: true });
    for (const [i, text] of script.lines.entries())
      await must(run, fill(slot, { text, topic, out: join(dir, folder, `${i}.${ext}`) }), `${folder} slot line ${i}`);
  }
  return script;
};

/** Steps 5-6: render with MoviePy (the log lands where `dori render-er` reads), then check the file with ffprobe. */
export const renderAndCheck = async (
  run: Runner,
  cfg: ShortsConfig,
  paths: ShortsPaths,
  job: string,
): Promise<{ readonly video: string; readonly problems: readonly string[] }> => {
  const dir = join(paths.jobs, job);
  mkdirSync(paths.logs, { recursive: true });
  const python = cfg.python ?? "python3";
  const r = await run([python, RENDER_SCRIPT, dir, cfg.font ?? DEFAULT_FONT], { timeoutMs: RENDER_TIMEOUT_MS });
  writeFileSync(join(paths.logs, `${job}.log`), [r.out, r.err, `exit code ${r.code}`].join("\n"));
  if (r.code !== 0) throw new ShortsError(`render failed: run \`dori render-er ${paths.logs}\` for the cause`);
  const video = join(dir, "out.mp4");
  const probe = parseProbe(
    await must(
      run,
      [
        "ffprobe",
        "-v",
        "error",
        "-show_entries",
        "stream=codec_type,width,height:format=duration",
        "-of",
        "json",
        video,
      ],
      "ffprobe",
    ),
  );
  return { video, problems: checkVideo(probe, Boolean(cfg.voice?.length), cfg.maxSeconds ?? 60) };
};
