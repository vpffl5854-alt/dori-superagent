/**
 * The head of 슈퍼도리 컴퓨터 유즈, the pure part. Ideas taken from the two open systems at the top of OSWorld
 * (Pointer, OpenAPA; both MIT, read for their design, no code copied):
 * - a gate first: can this be done at all? A model that cannot say no makes up a finished-looking result;
 * - a plan of milestones that describe states ("메모에 새 메모가 열려 있다"), not clicks, so a moved button or an
 *   unexpected sheet does not break it, and the plan may be rewritten mid-way;
 * - every turn starts by looking back at what the last action did before choosing the next;
 * - one executor with every tool a person has: controls by name, the menu bar, key chords, typing.
 * The model sees the app as text (controls by name, the menu bar), so a model without vision can decide.
 * DeepSeek first; Sonnet after two failures, or from the start when the owner asks for it.
 */

export type Act =
  | { readonly do: "open"; readonly app: string }
  | { readonly do: "look"; readonly app: string }
  | { readonly do: "press"; readonly app: string; readonly step: string }
  | { readonly do: "type"; readonly app: string; readonly field: string; readonly text: string }
  | { readonly do: "menu"; readonly app: string; readonly path: readonly string[] }
  | { readonly do: "key"; readonly app: string; readonly keys: readonly string[] }
  | { readonly do: "done"; readonly answer: string }
  | { readonly do: "fail"; readonly reason: string };

/** One answer: the action, what the model made of the last step, and a rewritten plan when it changed its mind. */
export type Decision = { readonly act: Act; readonly reflect?: string; readonly plan?: readonly string[] };
export type Plan =
  | { readonly feasible: true; readonly milestones: readonly string[] }
  | { readonly feasible: false; readonly reason: string };

export type Tier = "deepseek" | "sonnet";
export type Turn = { readonly act: string; readonly result: string };

/** Escalate to Sonnet after this many failures on DeepSeek; give up after this many on Sonnet. */
export const DEEPSEEK_FAILS = 2;
export const SONNET_FAILS = 3;
export const MAX_TURNS = 25;
const SNAPSHOT_MAX = 16_000;
const MENUS_MAX = 4_000;
const ACTIONS = "open, look, press, type, menu, key, done, fail";

/** The owner asked for Sonnet in the request itself ("소넷으로 …"). */
export const wantsSonnet = (goal: string): boolean => /소넷|sonnet/i.test(goal);

/** Which model decides next, or undefined when the task should give up. */
export const nextTier = (tier: Tier, fails: number): Tier | undefined =>
  tier === "deepseek"
    ? fails >= DEEPSEEK_FAILS
      ? "sonnet"
      : "deepseek"
    : fails >= SONNET_FAILS
      ? undefined
      : "sonnet";

/** 도리방 text that is a Mac task: "맥 …", "맥에서 …", "맥: …". */
export const macGoal = (text: string): string | undefined => {
  const m = /^\s*맥(?:에서)?\s*[:：]?\s+(.+)$/su.exec(text);
  const g = m?.[1]?.trim();
  return g && g.length >= 2 ? g : undefined;
};

export const planPrompt = (goal: string, apps: readonly string[]): string =>
  [
    "You will operate the owner's Mac in the background. Before anything is touched, decide two things.",
    `Goal (Korean): ${goal}`,
    `Open apps: ${apps.join(", ") || "(none)"}. Any installed Mac app can be opened by name.`,
    "",
    "1. Can this be done with Mac apps, the menu bar, the keyboard and the mouse, without tricks? If it needs",
    "   something the Mac does not have, or makes no sense, it is not feasible. Saying no is better than faking it.",
    "2. If feasible: 2-6 milestones, each a STATE the screen should be in (not a click). Korean.",
    "Answer with ONE JSON object and nothing else:",
    '{"feasible":true,"milestones":["계산기가 열려 있다","계산기 화면에 42가 보인다"]}',
    '{"feasible":false,"reason":"<Korean: why not>"}',
  ].join("\n");

export const prompt = (
  goal: string,
  apps: readonly string[],
  app: string | undefined,
  snapshot: string,
  menus: string,
  plan: readonly string[],
  history: readonly Turn[],
): string =>
  [
    "You operate a Mac for the owner, in the background, one action at a time.",
    `Goal (Korean): ${goal}`,
    ...(plan.length ? ["Plan (states to reach, in order):", ...plan.map((m, i) => `  ${i + 1}. ${m}`)] : []),
    "",
    `Open apps: ${apps.join(", ") || "(none)"}`,
    app
      ? `Controls of "${app}" (role "name" [ref] : value):\n${snapshot.slice(0, SNAPSHOT_MAX)}`
      : "No app looked at yet.",
    ...(app && menus
      ? [`Menu bar of "${app}" (menu > item (shortcut), [x] = disabled):\n${menus.slice(0, MENUS_MAX)}`]
      : []),
    "",
    "Done so far:",
    ...(history.length ? history.map((h, i) => `${i + 1}. ${h.act} -> ${h.result}`) : ["(nothing)"]),
    "",
    "First look back: did the last action do what you expected? Then pick the next action toward the next milestone.",
    'Answer with ONE JSON object and nothing else: {"reflect":"<Korean, one line>", ...one action..., "plan":[...]?}',
    "Actions (put the fields next to reflect):",
    '"do":"open","app":"<app name>"            open an app in the background (Korean or English name)',
    '"do":"look","app":"<app name>"            switch to another app (the app you work in is shown again every turn)',
    '"do":"press","app":"<app>","step":"<exact control name, or its ref like e12 when it has no name>"',
    '   the window\'s own top-left buttons are pressable as "창 닫기", "창 최소화", "창 확대"',
    '"do":"type","app":"<app>","field":"<exact field name, or its ref like e449>","text":"<text>"',
    '"do":"menu","app":"<app>","path":["파일","신규"]   choose a menu bar item by its labels above',
    '"do":"key","app":"<app>","keys":["cmd","n"]        press a key chord in that app',
    '"do":"done","answer":"<one Korean sentence: what was done, and the result the owner asked for>"',
    '"do":"fail","reason":"<Korean: why it cannot be done>"',
    'Add "plan":[...] only when the plan above turned out wrong. Say done only when the screen shows the last milestone.',
    "Use only names, refs and menu labels shown above. Never pay, delete, send or post unless the goal says so.",
    "A key chord or a menu needs a window of the app: never close or cancel the app's last window (a file-open panel is one; use its own buttons such as 새로운 문서 / New Document instead).",
    "Never answer a permission or password prompt (허용, Allow, 암호): stop with fail and say what it asks; the owner decides.",
    "Never type into a field that already shows text (it is the owner's own writing) unless the goal says to change it.",
  ].join("\n");

const str = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const strs = (v: unknown): string[] | undefined =>
  Array.isArray(v) && v.length > 0 && v.every(str) ? v.map((x) => (x as string).trim()) : undefined;

/** The first JSON object in a model's answer. */
const firstObject = (answer: string): Record<string, unknown> | undefined => {
  const start = answer.indexOf("{");
  const end = answer.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    const o = JSON.parse(answer.slice(start, end + 1)) as unknown;
    return o && typeof o === "object" ? (o as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
};

export const parsePlan = (answer: string): Plan | undefined => {
  const o = firstObject(answer);
  if (o?.["feasible"] === false && str(o["reason"])) return { feasible: false, reason: o["reason"].trim() };
  const milestones = strs(o?.["milestones"]);
  return o?.["feasible"] === true && milestones ? { feasible: true, milestones } : undefined;
};

/** The action in a model's answer; an unknown action or a missing field is no action. */
export const parseAct = (answer: string): Act | undefined => parseDecision(answer)?.act;

export const parseDecision = (answer: string): Decision | undefined => {
  const o = firstObject(answer);
  if (!o) return undefined;
  const d = o["do"];
  const app = str(o["app"]) ? o["app"].trim() : undefined;
  const act: Act | undefined =
    d === "open" && app
      ? { do: d, app }
      : d === "look" && app
        ? { do: d, app }
        : d === "press" && app && str(o["step"])
          ? { do: d, app, step: o["step"].trim() }
          : d === "type" && app && str(o["field"]) && typeof o["text"] === "string"
            ? { do: d, app, field: o["field"].trim(), text: o["text"] }
            : d === "menu" && app && strs(o["path"])
              ? { do: d, app, path: strs(o["path"]) ?? [] }
              : d === "key" && app && strs(o["keys"])
                ? { do: d, app, keys: (strs(o["keys"]) ?? []).map((k) => k.toLowerCase()) }
                : d === "done" && str(o["answer"])
                  ? { do: d, answer: o["answer"].trim() }
                  : d === "fail" && str(o["reason"])
                    ? { do: d, reason: o["reason"].trim() }
                    : undefined;
  if (!act) return undefined;
  const plan = strs(o["plan"]);
  return {
    act,
    ...(str(o["reflect"]) ? { reflect: o["reflect"].trim().slice(0, 200) } : {}),
    ...(plan ? { plan } : {}),
  };
};

/** What the next question says about an answer that was no action: the model is told the actions that exist. */
export const badAnswerNote = (answer: string): string => {
  const d = firstObject(answer)?.["do"];
  return typeof d === "string"
    ? `"${d}"는 없는 동작이거나 칸이 빠짐 (있는 동작: ${ACTIONS})`
    : "JSON 한 개로 답하지 않음";
};

export const actLine = (a: Act): string =>
  a.do === "press"
    ? `${a.app}: "${a.step}" 누름`
    : a.do === "type"
      ? `${a.app}: "${a.field}"에 "${a.text.slice(0, 40)}" 입력`
      : a.do === "menu"
        ? `${a.app}: 메뉴 ${a.path.join(" > ")}`
        : a.do === "key"
          ? `${a.app}: 단축키 ${a.keys.join("+")}`
          : a.do === "open"
            ? `${a.app} 열기`
            : a.do === "look"
              ? `${a.app} 보기`
              : a.do === "done"
                ? `끝: ${a.answer}`
                : `포기: ${a.reason}`;
