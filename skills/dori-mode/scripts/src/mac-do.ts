/**
 * dori mac do: a spoken request run end to end. A request done before is replayed from its learned recipe with no
 * model at all; if the replay fails (the app changed), the head works it out again. A success made only of presses
 * in one app is learned for next time. 도리방 gets the before/after photos, what was done, and which model decided.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dorichatBot } from "./dorichat-bot.ts";
import type { DoriConfig } from "./config.ts";
import { findWindow, type MacTask, type Win } from "./mac.ts";
import { enginePath, openEngine } from "./mac-engine.ts";
import { type GoalResult, runGoal } from "./mac-goal.ts";
import { hidIdleMs, isStopped, macConfig, macDir, submit } from "./mac-jobs.ts";
import { explainPrompt, parseQuick, type Quick, volumeScript } from "./mac-quick.ts";
import { runTask } from "./mac-run.ts";
import { ask, type ThinkConfig } from "./mac-think.ts";
import { askOmoProvider, withImage } from "./omo-provider.ts";
import { run } from "./run.ts";

type Learned = Record<string, MacTask>;
const learnedPath = (config: DoriConfig): string => macDir(config, "learned.json");
const readLearned = (config: DoriConfig): Learned =>
  existsSync(learnedPath(config)) ? (JSON.parse(readFileSync(learnedPath(config), "utf8")) as Learned) : {};
/** The same request in other spacing or punctuation is the same request. */
export const goalKey = (goal: string): string =>
  goal
    .replace(/소넷으로|sonnet으로|sonnet/gi, "")
    .replace(/[\s.,!?~]+/g, "")
    .toLowerCase();

/** Opens an app in the background; a Korean name ("계산기") is found through Spotlight's localized names. */
/** The name the Mac shows for an app (its display name, "TextEdit" -> "텍스트 편집기"); the name itself otherwise. */
export const shownAppName = async (app: string): Promise<string> => {
  const q = (field: string) =>
    run(
      ["mdfind", `kMDItemContentType == "com.apple.application-bundle" && ${field} == "${app.replace(/"/g, "")}.app"c`],
      {
        timeoutMs: 10_000,
      },
    );
  const path = ((await q("kMDItemFSName")).out.trim() || (await q("kMDItemDisplayName")).out.trim()).split("\n")[0];
  if (!path) return app;
  const shown = (await run(["mdls", "-raw", "-name", "kMDItemDisplayName", path], { timeoutMs: 10_000 })).out.trim();
  // Names read from the file system are decomposed Hangul (NFD); the engine's app names are composed (NFC).
  return shown && shown !== "(null)" ? shown.replace(/\.app$/, "").normalize("NFC") : app;
};

const openApp = async (app: string, background = true): Promise<boolean> => {
  const bg = background ? ["-g"] : [];
  if ((await run(["open", ...bg, "-a", app], { timeoutMs: 20_000 })).code === 0) return true;
  const found = (await run(["mdfind", "-name", app], { timeoutMs: 20_000 })).out
    .split("\n")
    .find((p) => p.endsWith(".app"));
  return found ? (await run(["open", ...bg, found], { timeoutMs: 20_000 })).code === 0 : false;
};

/** A quick command (mac-quick.ts) run at once, with its answer and, for the screen, a photo. */
const runQuick = async (
  q: Quick,
  think?: ThinkConfig,
): Promise<{ ok: boolean; text: string; photo?: Uint8Array<ArrayBuffer> }> => {
  if (q.kind === "screen" || q.kind === "explain") {
    const file = join(tmpdir(), `mac-screen-${Date.now()}.jpg`);
    const r = await run(["screencapture", "-x", "-t", "jpg", file], { timeoutMs: 20_000 });
    if (r.code !== 0 || !existsSync(file)) return { ok: false, text: "화면을 못 찍었어요" };
    // Small enough for a quick upload and a model's picture budget, big enough to read a dialog.
    await run(["sips", "-Z", "1600", file], { timeoutMs: 20_000 });
    const photo = new Uint8Array(readFileSync(file));
    rmSync(file, { force: true });
    if (q.kind === "screen") return { ok: true, text: "지금 맥 화면이에요", photo };
    const t = think ?? {};
    const a = await askOmoProvider(
      t.provider ?? "hive2",
      t.deepseekModel ?? "deepseek-ai/deepseek-v4.1-flash-1017",
      withImage(explainPrompt(q.question), photo),
      120_000,
    );
    return "text" in a
      ? { ok: true, text: a.text, photo }
      : { ok: false, text: `화면을 못 읽었어요: ${a.error}`, photo };
  }
  if (q.kind === "open") {
    const ok = await openApp(q.app, false);
    return { ok, text: ok ? `${q.app}을(를) 열었어요` : `${q.app}을(를) 못 찾았어요` };
  }
  const osa = (script: string) => run(["osascript", "-e", script], { timeoutMs: 10_000 });
  const before = Number((await osa("output volume of (get volume settings)")).out) || 0;
  const r = await osa(volumeScript(q, before));
  if (r.code !== 0) return { ok: false, text: "소리를 못 바꿨어요" };
  if (q.kind === "mute") return { ok: true, text: q.on ? "음소거했어요" : "음소거를 풀었어요" };
  const after = Number((await osa("output volume of (get volume settings)")).out) || 0;
  return { ok: true, text: `볼륨 ${before} → ${after}` };
};

export const doGoal = async (config: DoriConfig, goal: string): Promise<GoalResult & { replayed: boolean }> => {
  const c = macConfig(config);
  const path = enginePath(c.engine);
  const empty = { history: [], tiers: [], held: false, replayed: false };
  if (!path) return { ok: false, text: "OmO 화면 엔진을 못 찾았어요", ...empty };
  const { engine, caps } = await openEngine(path);
  try {
    if (caps.screenLocked || caps.displayAsleep)
      return { ok: false, text: "맥 화면이 잠겨 있거나 꺼져 있어요", ...empty };
    const base = {
      stopped: () => isStopped(config),
      sleep: (ms: number) => Bun.sleep(ms),
      waitMs: c.waitMs ?? 10_000,
      maxWaits: c.maxWaits ?? 30,
      photos: true,
      ownerIdleMs: hidIdleMs,
    };
    const learned = readLearned(config)[goalKey(goal)];
    if (learned) {
      // A learned task starts where the model's run started: with its app open.
      const wins = ((await engine.call("windows")).result as Win[] | undefined) ?? [];
      if (!findWindow(wins, learned.app)) {
        await openApp(learned.app);
        await Bun.sleep(1_500);
      }
      const r = await runTask(engine, learned, base);
      if (r.ok)
        return {
          ok: true,
          text: `배운 순서대로 했어요${r.shown.length ? `. 보이는 값: ${r.shown.slice(0, 3).join(", ")}` : ""}`,
          history: [{ act: `${learned.app}: ${learned.steps.join(" → ")}`, result: "레시피 그대로" }],
          tiers: [],
          held: false,
          replayed: true,
          ...(r.before ? { before: r.before } : {}),
          ...(r.after ? { after: r.after } : {}),
        };
    }
    const g = await runGoal(engine, goal, {
      ...base,
      think: (tier, p) => ask(tier, c.think ?? {}, p, run, macDir(config)),
      openApp: async (app) => void (await openApp(app)),
      appName: shownAppName,
      autoSend: c.autoSend ?? false,
      hold: async (task) => void (await submit(config, task, true)),
    });
    if (g.ok && g.recipe)
      writeFileSync(
        learnedPath(config),
        JSON.stringify({ ...readLearned(config), [goalKey(goal)]: g.recipe }, null, 2),
      );
    return { ...g, replayed: false };
  } finally {
    await engine.close();
  }
};

export const goalReport = (goal: string, g: GoalResult & { replayed: boolean }): string =>
  [
    `${g.ok ? "맥 작업 끝" : g.held ? "맥 작업 승인 대기" : "맥 작업 실패"}: ${goal}`,
    g.text,
    ...(g.history.length ? ["한 일:", ...g.history.map((h, i) => `${i + 1}. ${h.act} → ${h.result}`)] : []),
    g.replayed ? "모델: 안 씀 (배운 순서)" : `모델: ${g.tiers.join(" → ") || "-"}`,
    ...(g.ok && g.recipe ? ["다음엔 이 순서를 그대로 해요 (모델 없이)"] : []),
  ].join("\n");

export const doAndReport = async (config: DoriConfig, id: string, goal: string, send: boolean): Promise<boolean> => {
  const bot = send ? dorichatBot(config) : undefined;
  const chatId = bot?.cfg.chatId;
  const quick = parseQuick(goal);
  if (quick) {
    const q = await runQuick(quick, macConfig(config).think);
    console.log(`MAC_QUICK ${id} ${quick.kind} ok=${q.ok} ${q.text}`);
    if (bot && chatId)
      await (q.photo ? bot.tg.sendPhoto({ chatId }, q.photo, "screen.jpg", q.text) : bot.tg.send({ chatId }, q.text));
    return q.ok;
  }
  const g = await doGoal(config, goal);
  const text = goalReport(goal, g);
  console.log(`MAC_DO ${id} ok=${g.ok} tiers=${g.tiers.join(">") || "recipe"}\n${text}`);
  if (bot && chatId) {
    if (g.before) await bot.tg.sendPhoto({ chatId }, g.before, "before.png", "하기 전");
    if (g.after) await bot.tg.sendPhoto({ chatId }, g.after, "after.png", text);
    else await bot.tg.send({ chatId }, text);
  }
  return g.ok;
};
