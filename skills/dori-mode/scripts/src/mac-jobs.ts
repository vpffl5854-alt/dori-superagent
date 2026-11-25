/**
 * Mac tasks end to end: run one on the engine and tell 도리방 with the before/after photos, hold a dangerous one
 * for the owner's button, and queue work for the 맥손 tab. The engine refuses to start as a launchd job (it must be a
 * child of the app holding the computer-use grants, Herdr), so anything not already inside Herdr queues instead.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dorichatBot } from "./dorichat-bot.ts";
import type { DoriConfig } from "./config.ts";
import { approvalText, dangerousSteps, isConsentApp, type MacTask, macCallback, reportText } from "./mac.ts";
import { enginePath, openEngine } from "./mac-engine.ts";
import { type RunResult, runTask } from "./mac-run.ts";
import type { ThinkConfig } from "./mac-think.ts";

export type MacConfig = {
  /** The engine binary; the newest one OmO installed when unset. */
  readonly engine?: string;
  /** One wait for the owner (ms) and how many a task may spend. */
  readonly waitMs?: number;
  readonly maxWaits?: number;
  /** The models the head asks (mac-think.ts). */
  readonly think?: ThinkConfig;
};
type TaskJob = { readonly id: string; readonly task: MacTask; readonly send: boolean };
/** A queued job is a task with its steps, or a spoken request the head works out (mac-do.ts). */
export type Job = TaskJob | { readonly id: string; readonly goal: string; readonly send: boolean };

export const macConfig = (config: DoriConfig): MacConfig => (config as { mac?: MacConfig }).mac ?? {};
export const macDir = (config: DoriConfig, ...parts: string[]): string => {
  const dir = join(config.stateDir, "mac");
  mkdirSync(join(dir, "queue"), { recursive: true });
  mkdirSync(join(dir, "pending"), { recursive: true });
  mkdirSync(join(dir, "consent"), { recursive: true });
  return join(dir, ...parts);
};
export const stopPath = (config: DoriConfig): string => macDir(config, "stop");
export const isStopped = (config: DoriConfig): boolean => existsSync(stopPath(config));
export const newId = (now = new Date()): string =>
  `m${now.getTime().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
/** Inside a Herdr terminal the engine can start right here. */
export const inHerdr = (env = process.env): boolean => Boolean(env["HC_TERMINAL_ID"] ?? env["HERDR_PANE_ID"]);

export const execute = async (config: DoriConfig, task: MacTask, photos = true): Promise<RunResult> => {
  const c = macConfig(config);
  const path = enginePath(c.engine);
  if (!path) return { ok: false, shown: [], note: "OmO 화면 엔진을 못 찾았어요", waited: 0 };
  const { engine, caps } = await openEngine(path);
  try {
    if (caps.screenLocked || caps.displayAsleep)
      return { ok: false, shown: [], note: "맥 화면이 잠겨 있거나 꺼져 있어요", waited: 0 };
    return await runTask(engine, task, {
      stopped: () => isStopped(config),
      sleep: (ms) => Bun.sleep(ms),
      waitMs: c.waitMs ?? 10_000,
      maxWaits: c.maxWaits ?? 30,
      photos,
    });
  } finally {
    await engine.close();
  }
};

/** 도리방 gets the before photo, then the after photo with the report as its caption (text alone when no photo). */
export const report = async (config: DoriConfig, task: MacTask, r: RunResult, head = ""): Promise<void> => {
  const bot = dorichatBot(config);
  const chatId = bot?.cfg.chatId;
  if (!bot || !chatId) return void console.log("MAC_REPORT_SKIPPED no 도리방 bot");
  const text = `${head}${reportText(task, r.ok, r.shown, r.note)}`;
  if (r.before) await bot.tg.sendPhoto({ chatId }, r.before, "before.png", "하기 전");
  if (r.after) await bot.tg.sendPhoto({ chatId }, r.after, "after.png", text);
  else await bot.tg.send({ chatId }, text);
};

export const runAndReport = async (config: DoriConfig, job: TaskJob): Promise<RunResult> => {
  const r = await execute(config, job.task);
  console.log(`MAC_RESULT ${job.id} ok=${r.ok} waited=${r.waited} ${r.note}`.trim());
  if (job.send) await report(config, job.task, r);
  return r;
};

let queued = 0;
/** Named by time, then by order within this process, so jobs queued in the same millisecond keep their order. */
export const enqueue = (config: DoriConfig, job: Job): void =>
  writeFileSync(
    macDir(config, "queue", `${Date.now()}-${String(queued++).padStart(6, "0")}-${job.id}.json`),
    JSON.stringify(job),
  );

/** Takes the oldest queued job off the queue (a crash loses it rather than pressing twice). */
export const dequeue = (config: DoriConfig): Job | undefined => {
  const name = readdirSync(macDir(config, "queue"))
    .filter((f) => f.endsWith(".json"))
    .sort()[0];
  if (!name) return undefined;
  const path = macDir(config, "queue", name);
  const job = JSON.parse(readFileSync(path, "utf8")) as Job;
  rmSync(path);
  return job;
};

export type Submitted = "held" | "queued" | { readonly result: RunResult };

/** A dangerous task waits for the owner's 진행 in 도리방; the rest runs here inside Herdr, or queues for 맥손. */
export const submit = async (
  config: DoriConfig,
  task: MacTask,
  send: boolean,
  approved = false,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Submitted> => {
  const id = newId();
  const danger = isConsentApp(task.app) ? [...task.steps] : dangerousSteps(task.steps);
  if (danger.length && !approved) {
    writeFileSync(macDir(config, "pending", `${id}.json`), JSON.stringify({ id, task, send }));
    const bot = dorichatBot(config);
    if (bot?.cfg.chatId)
      await bot.tg.call("sendMessage", {
        chat_id: bot.cfg.chatId,
        text: approvalText(id, task, danger),
        reply_markup: {
          inline_keyboard: [
            [
              { text: "진행", callback_data: macCallback("go", id) },
              { text: "버리기", callback_data: macCallback("drop", id) },
            ],
          ],
        },
      });
    console.log(`MAC_HELD ${id} ${danger.join(",")}`);
    return "held";
  }
  if (!inHerdr(env)) {
    enqueue(config, { id, task, send });
    console.log(`MAC_QUEUED ${id}`);
    return "queued";
  }
  return { result: await runAndReport(config, { id, task, send }) };
};

/** The owner pressed 진행 (or 버리기) on a held task: it goes to 맥손's queue, or is dropped. */
export const decidePending = (config: DoriConfig, id: string, go: boolean): boolean => {
  const path = macDir(config, "pending", `${id}.json`);
  if (!existsSync(path)) return false;
  const job = JSON.parse(readFileSync(path, "utf8")) as Job;
  rmSync(path);
  if (go) enqueue(config, job);
  return true;
};
