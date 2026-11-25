/**
 * One spoken Mac request ("계산기로 6 곱하기 7 해줘") worked out a step at a time: the model sees the controls by
 * name, answers one action, the hand does it, and the result goes back into the next question. A press goes through
 * runTask, so the stop switch and the owner-in-front wait hold for every press; a dangerous one ends the run and is
 * held for 도리방. DeepSeek decides until it fails twice, then Sonnet.
 */
import {
  type Act,
  actLine,
  DEEPSEEK_FAILS,
  MAX_TURNS,
  nextTier,
  parseAct,
  prompt,
  type Tier,
  type Turn,
  wantsSonnet,
} from "./mac-brain.ts";
import { dangerousSteps, findRef, findWindow, type MacTask, type Win } from "./mac.ts";
import type { Engine } from "./mac-engine.ts";
import { type RunOpts, runTask } from "./mac-run.ts";
import type { Thought } from "./mac-think.ts";

export type GoalDeps = RunOpts & {
  readonly think: (tier: Tier, prompt: string) => Promise<Thought>;
  readonly openApp: (app: string) => Promise<void>;
  /** Hold a dangerous press for the owner's 진행. */
  readonly hold: (task: MacTask) => Promise<void>;
};

export type GoalResult = {
  readonly ok: boolean;
  readonly text: string;
  readonly history: readonly Turn[];
  readonly tiers: readonly Tier[];
  readonly held: boolean;
  /** When every act was a press in one app: the steps, worth keeping as a recipe. */
  readonly recipe?: MacTask;
  readonly before?: Uint8Array<ArrayBuffer>;
  readonly after?: Uint8Array<ArrayBuffer>;
};

const photo = async (e: Engine, target: string): Promise<Uint8Array<ArrayBuffer> | undefined> => {
  const r = (await e.call("capture", { target, caps: { maxWidth: 900, maxBytes: 2_000_000 } })).result as
    | { data?: string | null }
    | undefined;
  return r?.data ? new Uint8Array(Buffer.from(r.data, "base64")) : undefined;
};

export const runGoal = async (e: Engine, goal: string, d: GoalDeps): Promise<GoalResult> => {
  let tier: Tier = wantsSonnet(goal) ? "sonnet" : "deepseek";
  const tiers: Tier[] = [tier];
  const history: Turn[] = [];
  const acts: Act[] = [];
  let fails = 0;
  let app: string | undefined;
  let before: Uint8Array<ArrayBuffer> | undefined;
  const windows = async (): Promise<Win[]> => ((await e.call("windows")).result as Win[] | undefined) ?? [];
  const snapshotOf = async (id: string): Promise<string> =>
    ((await e.call("ax.snapshot", { target: id, opts: { all: true, maxNodes: 400 } })).result as { text?: string })
      ?.text ?? "";
  const finish = async (ok: boolean, text: string, held = false): Promise<GoalResult> => {
    const w = app ? findWindow(await windows(), app) : undefined;
    const after = d.photos && w ? await photo(e, w.id) : undefined;
    const presses = acts.filter((a) => a.do === "press");
    const oneApp = new Set(presses.map((a) => a.app)).size === 1 && acts.every((a) => a.do !== "type");
    const recipe =
      ok && presses.length && oneApp ? { app: presses[0]?.app ?? "", steps: presses.map((a) => a.step) } : undefined;
    return {
      ok,
      text,
      history,
      tiers,
      held,
      ...(recipe ? { recipe } : {}),
      ...(before ? { before } : {}),
      ...(after ? { after } : {}),
    };
  };
  const failed = (): "same" | "switched" | "out" => {
    fails++;
    const next = nextTier(tier, fails);
    if (!next) return "out";
    if (next === tier) return "same";
    tier = next;
    tiers.push(tier);
    fails = 0;
    history.push({ act: "모델 바꿈", result: `${tier} 이(가) 이어서 함` });
    return "switched";
  };
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    if (d.stopped()) return finish(false, '도리방 "멈춰"로 멈췄어요');
    const wins = await windows();
    const w = app ? findWindow(wins, app) : undefined;
    if (w && d.photos && !before) before = await photo(e, w.id);
    const snapshot = w ? await snapshotOf(w.id) : "";
    const thought = await d.think(tier, prompt(goal, [...new Set(wins.map((x) => x.app))], w?.app, snapshot, history));
    const act = "text" in thought ? parseAct(thought.text) : undefined;
    if (!act) {
      history.push({ act: "(모델 답 이상)", result: "error" in thought ? thought.error : "JSON 한 개로 답하지 않음" });
      if (failed() === "out") return finish(false, "모델이 답을 제대로 못 했어요");
      continue;
    }
    if (act.do === "done") return finish(true, act.answer);
    if (act.do === "fail") {
      // DeepSeek giving up hands the task to Sonnet at once; Sonnet giving up ends it.
      history.push({ act: actLine(act), result: "모델이 포기" });
      if (tier === "sonnet") return finish(false, act.reason);
      fails = DEEPSEEK_FAILS - 1;
      failed();
      continue;
    }
    let result = "";
    let ok = true;
    if (act.do === "open") {
      await d.openApp(act.app);
      await d.sleep(1_500);
      app = act.app;
      ok = Boolean(findWindow(await windows(), act.app));
      result = ok ? "열었음" : "창이 안 보임";
    } else if (act.do === "look") {
      app = act.app;
      ok = Boolean(findWindow(wins, act.app));
      result = ok ? "봤음" : "그 앱 창이 없음";
    } else if (act.do === "press") {
      app = act.app;
      if (dangerousSteps([act.step]).length) {
        await d.hold({ app: act.app, steps: [act.step] });
        return finish(false, `"${act.step}"은(는) 되돌릴 수 없는 버튼이라 도리방 승인을 기다려요`, true);
      }
      const r = await runTask(e, { app: act.app, steps: [act.step] }, { ...d, photos: false });
      if (!r.ok && (r.note.includes("쓰는 중") || r.note.includes("멈춰"))) return finish(false, r.note);
      ok = r.ok;
      result = r.ok ? `눌렀음${r.shown.length ? `, 보이는 값: ${r.shown.slice(0, 3).join(", ")}` : ""}` : r.note;
    } else {
      app = act.app;
      const tw = findWindow(wins, act.app);
      const ref = tw ? findRef(await snapshotOf(tw.id), act.field) : undefined;
      const r = ref ? await e.call("ax.typeText", { ref, text: act.text }) : undefined;
      ok = Boolean(r && !r.error);
      result = ok ? "입력함" : ref ? `입력 못 함: ${r?.error?.message}` : `"${act.field}" 칸을 못 찾음`;
    }
    history.push({ act: actLine(act), result });
    // Only what worked is learned: a failed press in the recipe would fail every replay.
    if (ok) acts.push(act);
    if (!ok && failed() === "out") return finish(false, `더 못 하겠어요: ${result}`);
  }
  return finish(false, `${MAX_TURNS}번 해도 끝나지 않아서 멈췄어요`);
};
