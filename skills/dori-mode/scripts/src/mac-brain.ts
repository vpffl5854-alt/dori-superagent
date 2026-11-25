/**
 * The head of 슈퍼도리 컴퓨터 유즈, the pure part: what the model sees (the goal, the open apps, one app's controls
 * by name as text, so a model that cannot see pictures can still decide), the one action it may answer with, and
 * which model decides. DeepSeek first; Sonnet after two failures, or from the start when the owner asks for it.
 */

export type Act =
  | { readonly do: "open"; readonly app: string }
  | { readonly do: "look"; readonly app: string }
  | { readonly do: "press"; readonly app: string; readonly step: string }
  | { readonly do: "type"; readonly app: string; readonly field: string; readonly text: string }
  | { readonly do: "done"; readonly answer: string }
  | { readonly do: "fail"; readonly reason: string };

export type Tier = "deepseek" | "sonnet";
export type Turn = { readonly act: string; readonly result: string };

/** Escalate to Sonnet after this many failures on DeepSeek; give up after this many on Sonnet. */
export const DEEPSEEK_FAILS = 2;
export const SONNET_FAILS = 3;
export const MAX_TURNS = 15;
const SNAPSHOT_MAX = 8_000;

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

export const prompt = (
  goal: string,
  apps: readonly string[],
  app: string | undefined,
  snapshot: string,
  history: readonly Turn[],
): string =>
  [
    "You operate a Mac for the owner, in the background, one action at a time.",
    `Goal (Korean): ${goal}`,
    "",
    `Open apps: ${apps.join(", ") || "(none)"}`,
    app
      ? `Controls of "${app}" (role "name" [ref] : value):\n${snapshot.slice(0, SNAPSHOT_MAX)}`
      : "No app looked at yet.",
    "",
    "Done so far:",
    ...(history.length ? history.map((h, i) => `${i + 1}. ${h.act} -> ${h.result}`) : ["(nothing)"]),
    "",
    "Answer with ONE JSON object and nothing else, one of:",
    '{"do":"open","app":"<app name>"}            open an app in the background (Korean or English name)',
    '{"do":"look","app":"<app name>"}            read that app\'s controls',
    '{"do":"press","app":"<app>","step":"<exact control name>"}   press a control by its exact name above',
    '{"do":"type","app":"<app>","field":"<exact field name>","text":"<text>"}   put text into a field',
    '{"do":"done","answer":"<one Korean sentence: what was done, and the result the owner asked for>"}',
    '{"do":"fail","reason":"<Korean: why it cannot be done>"}',
    "Use only names that appear in the controls. Never pay, delete, send or post unless the goal says so.",
  ].join("\n");

const str = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

/** The first JSON object in the model's answer, as an action; anything else is undefined. */
export const parseAct = (answer: string): Act | undefined => {
  const start = answer.indexOf("{");
  const end = answer.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(answer.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const d = o["do"];
  if (d === "open" && str(o["app"])) return { do: d, app: o["app"].trim() };
  if (d === "look" && str(o["app"])) return { do: d, app: o["app"].trim() };
  if (d === "press" && str(o["app"]) && str(o["step"])) return { do: d, app: o["app"].trim(), step: o["step"].trim() };
  if (d === "type" && str(o["app"]) && str(o["field"]) && typeof o["text"] === "string")
    return { do: d, app: o["app"].trim(), field: o["field"].trim(), text: o["text"] };
  if (d === "done" && str(o["answer"])) return { do: d, answer: o["answer"].trim() };
  if (d === "fail" && str(o["reason"])) return { do: d, reason: o["reason"].trim() };
  return undefined;
};

export const actLine = (a: Act): string =>
  a.do === "press"
    ? `${a.app}: "${a.step}" 누름`
    : a.do === "type"
      ? `${a.app}: "${a.field}"에 "${a.text.slice(0, 40)}" 입력`
      : a.do === "open"
        ? `${a.app} 열기`
        : a.do === "look"
          ? `${a.app} 보기`
          : a.do === "done"
            ? `끝: ${a.answer}`
            : `포기: ${a.reason}`;
