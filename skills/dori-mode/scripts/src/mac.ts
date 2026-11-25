/**
 * 슈퍼도리 컴퓨터 유즈, the pure part: a step is a control's name (alternatives split by `|`, since a control's name
 * changes with its state: AC "모두 지우기" becomes C "지우기"), found in the engine's accessibility snapshot. A step
 * whose name pays, deletes, sends or posts is dangerous and waits for the owner's button press in 도리방.
 */

export type MacTask = { readonly app: string; readonly steps: readonly string[]; readonly expect?: string };

/** Words on a control whose press cannot be taken back. "지우기" (clear) is not one: it only clears a field. */
const DANGER =
  /결제|구매|주문|송금|이체|삭제|휴지통|보내기|전송|게시|공유|업로드|탈퇴|해지|\b(pay|buy|purchase|order|delete|remove|trash|send|post|publish|submit|share|upload)\b/i;
/** Key chords that delete, quit or send: Return alone sends a chat message in most chat apps. */
const DANGER_KEYS = /^(cmd\+(q|delete|backspace|return|enter)|cmd\+shift\+(delete|backspace)|return|enter)$/i;

/**
 * A step is a control's name (alternatives split by `|`), a menu path ("menu:파일>신규") or a key chord
 * ("key:cmd+n"). Recipes keep all three, so a learned task can use the menu bar and shortcuts too.
 */
export type Step =
  | { readonly kind: "press"; readonly name: string }
  | { readonly kind: "menu"; readonly path: string[] }
  | { readonly kind: "key"; readonly keys: string[] };
export const menuStep = (path: readonly string[]): string => `menu:${path.join(">")}`;
export const keyStep = (keys: readonly string[]): string => `key:${keys.join("+")}`;
export const parseStep = (step: string): Step =>
  step.startsWith("menu:")
    ? {
        kind: "menu",
        path: step
          .slice(5)
          .split(">")
          .map((p) => p.trim())
          .filter(Boolean),
      }
    : step.startsWith("key:")
      ? {
          kind: "key",
          keys: step
            .slice(4)
            .split("+")
            .map((k) => k.trim().toLowerCase())
            .filter(Boolean),
        }
      : { kind: "press", name: step };

/**
 * Apps that ask for the owner's consent: macOS permission prompts (UserNotificationCenter), password and Touch ID
 * sheets, Gatekeeper, System Settings. A press there can grant an app control of the Mac, so it is always the owner's
 * call: every step in them waits for 도리방, whatever its name ("허용" is not a dangerous word anywhere else).
 */
export const isConsentApp = (app: string): boolean =>
  /usernotificationcenter|securityagent|coreservicesuiagent|coreauth|시스템 설정|system settings|system preferences/i.test(
    app,
  );

export const dangerousSteps = (steps: readonly string[]): string[] =>
  steps.filter((s) => {
    const st = parseStep(s);
    return st.kind === "key"
      ? DANGER_KEYS.test(st.keys.join("+"))
      : DANGER.test(st.kind === "menu" ? st.path.join(" ") : s);
  });

/** "6, 곱하기 ,7" -> ["6", "곱하기", "7"]. */
export const parseSteps = (text: string): string[] =>
  text
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const reEscape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The ref of the first control named like the step (any alternative), buttons before other roles. A step may also
 * be a ref the snapshot shows (`e449`), for a control without a name such as a note's text area.
 */
export const findRef = (snapshot: string, step: string): string | undefined => {
  if (/^e\d+$/.test(step)) return snapshot.includes(`[ref=${step}]`) ? step : undefined;
  const names = step.split("|").map((n) => n.trim());
  for (const role of ["button", "[a-z]+"])
    for (const n of names) {
      const m = new RegExp(`^\\s*- ${role} "${reEscape(n)}" \\[ref=(e\\d+)\\]`, "m").exec(snapshot);
      if (m?.[1]) return m[1];
    }
  return undefined;
};

/** The name a ref's control carries, so a press by ref is checked for danger like a press by name. */
export const nameOf = (snapshot: string, ref: string): string | undefined =>
  new RegExp(`- [a-z]+ "([^"]*)" \\[ref=${reEscape(ref)}\\]`).exec(snapshot)?.[1];

/** Secrets never leave the Mac in a model's question: bearer tokens, key=value secrets and long opaque strings. */
export const redactSecrets = (text: string): string =>
  text
    .replace(/Bearer\s+\S+/gi, "Bearer [가림]")
    .replace(
      /((?:token|key|secret|password|passwd|cookie|토큰|비밀번호|키)["']?\s*[:=]?\s*["']?)[A-Za-z0-9_\-./+]{16,}/gi,
      "$1[가림]",
    )
    .replace(/[A-Za-z0-9_-]{32,}/g, "[가림]");

const ACTIONABLE =
  /^\s*- (button|menubutton|popupbutton|checkbox|radiobutton|tab|link|menuitem|textfield|textarea|searchfield|combobox|slider|incrementor) /;

/**
 * What the model sees of an app: controls it can act on first, then labelled and text lines, each value cut short
 * and secrets hidden, at most `max` lines. A long list (a notes list) must not push the toolbar out of view.
 */
export const modelView = (snapshot: string, max = 250): string => {
  const lines = snapshot.split("\n").map((l) => redactSecrets(l.replace(/: "([^"]{60})[^"]*"/, ': "$1…"')));
  const keep = new Set(lines.flatMap((l, i) => (ACTIONABLE.test(l) ? [i] : [])).slice(0, max));
  for (const [i, l] of lines.entries()) if (keep.size < max && /"|: /.test(l)) keep.add(i);
  return lines.filter((_, i) => keep.has(i)).join("\n");
};

/** Whether some control in the snapshot shows the expected value (`…: "42"`). */
export const showsValue = (snapshot: string, value: string): boolean =>
  new RegExp(`: "${reEscape(value)}"`).test(snapshot);

/** The values the snapshot's text fields show, for the report line. */
export const shownValues = (snapshot: string): string[] =>
  [...snapshot.matchAll(/- (?:statictext|textfield|textarea)[^\n]*?: "([^"\n]*)"/g)].map((m) => m[1] ?? "");

export type Win = { readonly id: string; readonly app: string; readonly title: string; readonly focused: boolean };

/**
 * The app's window; an app name matches its Korean or English name loosely ("계산기" or "Calculator"). A window
 * with a title comes first: an app opened twice can list an untitled window the accessibility tree does not know.
 */
export const findWindow = (wins: readonly Win[], app: string): Win | undefined => {
  const a = app.toLowerCase();
  const exact = wins.filter((w) => w.app.toLowerCase() === a);
  const loose = exact.length ? exact : wins.filter((w) => w.app.toLowerCase().includes(a));
  return loose.find((w) => w.title.trim()) ?? loose[0];
};

/** 도리방 words for the stop switch: "멈춰" stops every Mac action, "재개" lets them run again. */
export const stopWord = (text: string): "stop" | "resume" | undefined => {
  const t = text.trim().replace(/[!.~\s]+$/u, "");
  return t === "멈춰" ? "stop" : t === "재개" ? "resume" : undefined;
};

export type MacPress = { readonly action: "go" | "drop"; readonly id: string };
export const macCallback = (action: MacPress["action"], id: string): string => `mac:${action}:${id}`;
export const parseMacPress = (data: string | undefined): MacPress | undefined => {
  const m = /^mac:(go|drop):([A-Za-z0-9-]+)$/.exec(data ?? "");
  return m?.[1] && m[2] ? { action: m[1] as MacPress["action"], id: m[2] } : undefined;
};

export const approvalText = (id: string, t: MacTask, danger: readonly string[]): string =>
  [
    `맥 조작 승인 필요 (${id})`,
    `앱: ${t.app}`,
    `누를 순서: ${t.steps.join(" → ")}`,
    `되돌릴 수 없는 버튼: ${danger.join(", ")}`,
  ].join("\n");

export const reportText = (t: MacTask, ok: boolean, shown: readonly string[], note = ""): string =>
  [
    `${ok ? "맥 작업 끝" : "맥 작업 실패"}: ${t.app}`,
    `누른 순서: ${t.steps.join(" → ")}`,
    ...(t.expect ? [`기대한 값: ${t.expect} → ${ok ? "맞음" : "다름"}`] : []),
    ...(shown.length ? [`지금 보이는 값: ${shown.slice(0, 3).join(", ")}`] : []),
    ...(note ? [note] : []),
  ].join("\n");

/** The self-test: 6 × 7 on Calculator must read 42. */
export const SELFTEST: MacTask = {
  app: "계산기",
  steps: ["모두 지우기|지우기|AC|C", "6", "곱하기|Multiply", "7", "등호|Equals"],
  expect: "42",
};
