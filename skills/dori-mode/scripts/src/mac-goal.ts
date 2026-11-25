/**
 * One spoken Mac request ("계산기로 6 곱하기 7 해줘") worked out end to end: the gate and the plan first
 * (mac-brain.ts), then one action a turn with a look back at the last one, the hand doing each (mac-acts.ts), and the
 * result going into the next question. DeepSeek decides until it fails twice or gives up, then Sonnet.
 */
import {
  actLine,
  badAnswerNote,
  DEEPSEEK_FAILS,
  MAX_TURNS,
  nextTier,
  parseDecision,
  parsePlan,
  planPrompt,
  prompt,
  type Tier,
  type Turn,
  wantsSonnet,
} from "./mac-brain.ts";
import { findWindow, type MacTask, modelView, type Win } from "./mac.ts";
import { doAct, menuView } from "./mac-acts.ts";
import type { Engine } from "./mac-engine.ts";
import type { RunOpts } from "./mac-run.ts";
import type { Thought } from "./mac-think.ts";

export type GoalDeps = RunOpts & {
  readonly think: (tier: Tier, prompt: string) => Promise<Thought>;
  readonly openApp: (app: string) => Promise<void>;
  /** Hold a dangerous step for the owner's 진행. */
  readonly hold: (task: MacTask) => Promise<void>;
  /** The name the Mac shows for an app the model named in English or Korean ("TextEdit" -> "텍스트 편집기"). */
  readonly appName?: (app: string) => Promise<string>;
};

export type GoalResult = {
  readonly ok: boolean;
  readonly text: string;
  readonly history: readonly Turn[];
  readonly tiers: readonly Tier[];
  readonly held: boolean;
  readonly plan?: readonly string[];
  /** When every step that worked can be replayed by name, menu or key in one app: worth keeping as a recipe. */
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
  const steps: { app: string; step: string }[] = [];
  let replayable = true;
  let fails = 0;
  let app: string | undefined;
  /** The app's window the model chose with look; unset, the front titled one. */
  let title: string | undefined;
  const names = new Map<string, string>();
  const named = async (a: string): Promise<string> => {
    if (!names.has(a)) names.set(a, d.appName ? await d.appName(a).catch(() => a) : a);
    return names.get(a) ?? a;
  };
  let plan: readonly string[] = [];
  let before: Uint8Array<ArrayBuffer> | undefined;
  const menus = new Map<string, string>();
  const windows = async (): Promise<Win[]> => ((await e.call("windows")).result as Win[] | undefined) ?? [];
  const snapshotOf = async (id: string): Promise<string> =>
    ((await e.call("ax.snapshot", { target: id, opts: { all: true, maxNodes: 3000 } })).result as { text?: string })
      ?.text ?? "";
  const finish = async (ok: boolean, text: string, held = false): Promise<GoalResult> => {
    const w = app ? findWindow(await windows(), app, title) : undefined;
    const after = d.photos && w ? await photo(e, w.id) : undefined;
    const apps = new Set(steps.map((s) => s.app));
    const recipe =
      ok && replayable && steps.length && apps.size === 1
        ? { app: steps[0]?.app ?? "", steps: steps.map((s) => s.step) }
        : undefined;
    return {
      ok,
      text,
      history,
      tiers,
      held,
      ...(plan.length ? { plan } : {}),
      ...(recipe ? { recipe } : {}),
      ...(before ? { before } : {}),
      ...(after ? { after } : {}),
    };
  };
  const toSonnet = (): void => {
    tier = "sonnet";
    tiers.push(tier);
    fails = 0;
    history.push({ act: "모델 바꿈", result: "sonnet 이(가) 이어서 함" });
  };
  const failed = (): "same" | "switched" | "out" => {
    fails++;
    const next = nextTier(tier, fails);
    if (!next) return "out";
    if (next === tier) return "same";
    toSonnet();
    return "switched";
  };

  // The gate: a "not feasible" from DeepSeek is asked of Sonnet once more; Sonnet's no ends the task untouched.
  for (;;) {
    const thought = await d.think(tier, planPrompt(goal, [...new Set((await windows()).map((w) => w.app))]));
    const p = "text" in thought ? parsePlan(thought.text) : undefined;
    if (p?.feasible === true) plan = p.milestones;
    if (p?.feasible === false) {
      history.push({ act: "할 수 있나 판단", result: `안 됨: ${p.reason}` });
      if (tier === "sonnet") return finish(false, `할 수 없는 일이라 손대지 않았어요: ${p.reason}`);
      toSonnet();
      continue;
    }
    break;
  }

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    if (d.stopped()) return finish(false, '도리방 "멈춰"로 멈췄어요');
    const wins = await windows();
    const w = app ? findWindow(wins, app, title) : undefined;
    const titles = w ? wins.filter((x) => x.app === w.app && x.title.trim()).map((x) => x.title) : [];
    if (w && d.photos && !before) before = await photo(e, w.id);
    const snapshot = w ? await snapshotOf(w.id) : "";
    if (w && !menus.has(w.app)) menus.set(w.app, await menuView(e, w.id).catch(() => ""));
    const q = prompt(
      goal,
      [...new Set(wins.map((x) => x.app))],
      w?.app,
      modelView(snapshot),
      w ? (menus.get(w.app) ?? "") : "",
      plan,
      history,
      w ? [w.title, ...titles.filter((t) => t !== w.title)] : [],
    );
    const thought = await d.think(tier, q);
    const dec = "text" in thought ? parseDecision(thought.text) : undefined;
    if (!dec) {
      history.push({ act: "(모델 답 이상)", result: "error" in thought ? thought.error : badAnswerNote(thought.text) });
      if (failed() === "out") return finish(false, "모델이 답을 제대로 못 했어요");
      continue;
    }
    if (dec.plan) plan = dec.plan;
    const act = "app" in dec.act ? { ...dec.act, app: await named(dec.act.app) } : dec.act;
    const look = dec.reflect ? ` (돌아보기: ${dec.reflect})` : "";
    if (act.do === "done") return finish(true, act.answer);
    if (act.do === "fail") {
      // DeepSeek giving up hands the task to Sonnet at once; Sonnet giving up ends it.
      history.push({ act: actLine(act) + look, result: "모델이 포기" });
      if (tier === "sonnet") return finish(false, act.reason);
      fails = DEEPSEEK_FAILS - 1;
      failed();
      continue;
    }
    if (act.do === "look" || act.do === "open" || act.app !== app) title = act.do === "look" ? act.window : undefined;
    app = act.app;
    const r = await doAct(e, act, { ...d, wins, ...(w ? { shown: w } : {}), snapshot, windows });
    if (r.end) return finish(false, r.end.text, r.end.held);
    history.push({ act: actLine(act) + look, result: r.result });
    // Only what worked is learned: a failed step in the recipe would fail every replay.
    if (r.ok && r.step) steps.push({ app: act.app, step: r.step });
    if (r.ok && (act.do === "type" || (act.do === "press" && !r.step))) replayable = false;
    if (!r.ok && failed() === "out") return finish(false, `더 못 하겠어요: ${r.result}`);
  }
  return finish(false, `${MAX_TURNS}번 해도 끝나지 않아서 멈췄어요`);
};
