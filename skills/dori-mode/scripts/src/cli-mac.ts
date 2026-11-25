/** dori mac …: 슈퍼도리 컴퓨터 유즈 on OmO's desktop engine (see mac-jobs.ts for where a task runs). */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { type Command, die } from "./cli-context.ts";
import type { DoriConfig } from "./config.ts";
import { kstDay } from "./decisions.ts";
import { findWindow, type MacTask, parseSteps, SELFTEST, type Win } from "./mac.ts";
import { enginePath, openEngine } from "./mac-engine.ts";
import { applyConsent, scanConsent } from "./mac-consent.ts";
import { doAndReport } from "./mac-do.ts";
import {
  decidePending,
  dequeue,
  enqueue,
  execute,
  inHerdr,
  isStopped,
  macDir,
  newId,
  report,
  runAndReport,
  stopPath,
  submit,
} from "./mac-jobs.ts";
import { run } from "./run.ts";

type Recipes = Record<string, MacTask>;
const CONSENT_EVERY_MS = 10_000;
const recipesPath = (config: DoriConfig): string => macDir(config, "recipes.json");
const readRecipes = (config: DoriConfig): Recipes =>
  existsSync(recipesPath(config)) ? (JSON.parse(readFileSync(recipesPath(config), "utf8")) as Recipes) : {};

const taskFrom = (opt: (n: string) => string | undefined): MacTask => {
  const app = opt("app") ?? die("needs --app APP");
  const steps = parseSteps(opt("steps") ?? die('needs --steps "a,b,c"'));
  const expect = opt("expect");
  return { app, steps, ...(expect ? { expect } : {}) };
};

const printSubmitted = (s: Awaited<ReturnType<typeof submit>>): void => {
  if (typeof s === "string") return;
  console.log(`MAC_${s.result.ok ? "OK" : "FAIL"} ${s.result.shown.slice(0, 3).join(", ")} ${s.result.note}`.trim());
  if (!s.result.ok) process.exitCode = 1;
};

/** Runs an engine request right here (inside Herdr) and prints it. */
const direct = async (config: DoriConfig, fn: (call: (m: string, p?: object) => Promise<unknown>) => Promise<void>) => {
  if (!inHerdr()) die("the engine only starts inside a Herdr terminal");
  const path = enginePath((config as { mac?: { engine?: string } }).mac?.engine) ?? die("no OmO desktop engine found");
  const { engine } = await openEngine(path);
  try {
    await fn(async (m, p) => (await engine.call(m, p as Record<string, unknown>)).result);
  } finally {
    await engine.close();
  }
};

type SelftestState = { okDay?: string; failDay?: string };

/** 6 × 7 on Calculator; with --report a failure tells 도리방 once a day, and a day already passed is skipped. */
export const selftest = async (config: DoriConfig, withReport: boolean): Promise<void> => {
  const statePath = macDir(config, "selftest.json");
  const state: SelftestState = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {};
  const today = kstDay(new Date());
  if (withReport && state.okDay === today) return void console.log("MAC_SELFTEST_SKIP passed today");
  const wasOpen = (await run(["pgrep", "-x", "Calculator"], { timeoutMs: 10_000 })).code === 0;
  if (!wasOpen) {
    await run(["open", "-g", "-a", "Calculator"], { timeoutMs: 20_000 });
    await Bun.sleep(2_000);
  }
  const r = await execute(config, SELFTEST);
  if (!wasOpen) await run(["osascript", "-e", 'quit app "Calculator"'], { timeoutMs: 20_000 });
  if (r.note.includes("잠겨")) return void console.log("MAC_SELFTEST_SKIP screen locked");
  console.log(`MAC_SELFTEST ${r.ok ? "ok" : "fail"} ${r.note}`.trim());
  if (r.ok) state.okDay = today;
  else if (withReport && state.failDay !== today) {
    state.failDay = today;
    await report(
      config,
      SELFTEST,
      r,
      "[맥 자가 시험 실패] OmO 화면 엔진이 이상해요. OmO 업데이트 뒤라면 손을 갈아 끼워야 할 수 있어요.\n",
    );
  }
  writeFileSync(statePath, JSON.stringify(state));
  if (!r.ok) process.exitCode = 1;
};

/** The 맥손 tab: works the queue, and runs the self-test once a day. */
const serve = async (config: DoriConfig): Promise<never> => {
  if (!inHerdr()) die("mac serve runs in a Herdr terminal (the 맥손 tab)");
  console.log("MAC_SERVE_READY");
  let nextTest = 0;
  let nextConsent = 0;
  for (;;) {
    try {
      // Permission prompts: new ones go to 도리방, the owner's presses are pressed (mac-consent.ts).
      if (Date.now() >= nextConsent) {
        nextConsent = Date.now() + CONSENT_EVERY_MS;
        const path = enginePath((config as { mac?: { engine?: string } }).mac?.engine);
        if (path) {
          const { engine } = await openEngine(path);
          try {
            await applyConsent(engine, config);
            await scanConsent(engine, config);
          } finally {
            await engine.close();
          }
        }
      }
      const job = isStopped(config) ? undefined : dequeue(config);
      if (job) await ("goal" in job ? doAndReport(config, job.id, job.goal, job.send) : runAndReport(config, job));
      else if (Date.now() >= nextTest) {
        nextTest = Date.now() + 3_600_000;
        await selftest(config, true);
      }
    } catch (e) {
      console.log(`MAC_SERVE_ERROR ${String(e).slice(0, 200)}`);
    }
    await Bun.sleep(3_000);
  }
};

const mac: Command = async ({ positionals, opt, values, config }) => {
  const [sub, a, b] = positionals;
  const send = values["no-send"] !== true;
  if (sub === "windows")
    return direct(config, async (call) => {
      for (const w of ((await call("windows")) as Win[]) ?? []) console.log(`${w.id}\t${w.app}\t${w.title}`);
    });
  if (sub === "look")
    return direct(config, async (call) => {
      const app = opt("app") ?? die("look needs --app APP");
      const w = findWindow(((await call("windows")) as Win[]) ?? [], app) ?? die(`no window for ${app}`);
      console.log(
        ((await call("ax.snapshot", { target: w.id, opts: { all: true, maxNodes: 400 } })) as { text: string }).text,
      );
    });
  if (sub === "press") return printSubmitted(await submit(config, taskFrom(opt), send));
  if (sub === "do") {
    const goal = opt("text") ?? die('do needs --text "맥에서 할 일"');
    const id = newId();
    if (!inHerdr()) {
      enqueue(config, { id, goal, send });
      return void console.log(`MAC_QUEUED ${id}`);
    }
    if (!(await doAndReport(config, id, goal, send))) process.exitCode = 1;
    return;
  }
  if (sub === "recipe" && a === "save" && b) {
    writeFileSync(recipesPath(config), JSON.stringify({ ...readRecipes(config), [b]: taskFrom(opt) }, null, 2));
    return void console.log(`MAC_RECIPE_SAVED ${b}`);
  }
  if (sub === "recipe" && a === "list")
    return void console.log(
      Object.entries(readRecipes(config))
        .map(([n, t]) => `${n}\t${t.app}\t${t.steps.join(" → ")}${t.expect ? `\t= ${t.expect}` : ""}`)
        .join("\n") || "(레시피 없음)",
    );
  if (sub === "recipe" && a === "run" && b)
    return printSubmitted(await submit(config, readRecipes(config)[b] ?? die(`no recipe ${b}`), send));
  if (sub === "stop") {
    writeFileSync(stopPath(config), new Date().toISOString());
    return void console.log("MAC_STOPPED");
  }
  if (sub === "resume") {
    rmSync(stopPath(config), { force: true });
    return void console.log("MAC_RESUMED");
  }
  if ((sub === "approve" || sub === "drop") && a)
    return void console.log(
      decidePending(config, a, sub === "approve")
        ? `MAC_${sub === "approve" ? "APPROVED" : "DROPPED"} ${a}`
        : `MAC_NO_PENDING ${a}`,
    );
  if (sub === "selftest") return selftest(config, values["report"] === true);
  if (sub === "serve") return serve(config);
  die(
    "mac windows | look --app A | do --text G | press --app A --steps S [--expect V] [--no-send] | recipe save|run N | recipe list | stop | resume | approve|drop ID | selftest [--report] | serve",
  );
};

export const macCommands: Readonly<Record<string, Command>> = { mac };
