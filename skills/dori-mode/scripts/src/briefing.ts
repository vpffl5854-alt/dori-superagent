/**
 * The morning briefing: one short Telegram message with what happened since the last one — lanes that finished, are
 * still working or were lost, faults, shorts, the backlog waiting for the owner's yes, and this month's model cost.
 * Everything comes from files Dori already writes; a source that is not connected says so instead of guessing.
 */

export type LaneFact = { readonly key: string; readonly summary: string };
export type Briefing = {
  readonly now: Date;
  readonly finished: readonly LaneFact[];
  readonly working: readonly LaneFact[];
  readonly lost: readonly LaneFact[];
  readonly faults: readonly string[];
  readonly shorts: readonly string[];
  readonly approvals: readonly string[];
  /** Alerts that could wait (`dori notify --level later`), since the last briefing. */
  readonly alerts?: readonly string[];
  readonly cost?: { readonly month: string; readonly total: number; readonly calls: number; readonly unknown: number };
  readonly weather?: string;
};

/** A section shows this many lines; the rest is a count, so one busy night cannot push the message past Telegram's limit. */
export const SECTION_MAX = 5;
const LINE_MAX = 90;
const DAYS = ["일", "월", "화", "수", "목", "금", "토"];

const clip = (s: string): string => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > LINE_MAX ? `${one.slice(0, LINE_MAX - 1)}…` : one;
};

const section = (title: string, lines: readonly string[]): string[] => {
  if (lines.length === 0) return [];
  const shown = lines.slice(0, SECTION_MAX).map((l) => `- ${clip(l)}`);
  const more = lines.length > SECTION_MAX ? [`- 외 ${lines.length - SECTION_MAX}건`] : [];
  return [`[${title}] ${lines.length}건`, ...shown, ...more, ""];
};

/** The time in Korea: the Mac's own zone is not assumed. */
const kst = (d: Date): { md: string; day: string; hm: string } => {
  const k = new Date(d.getTime() + 9 * 3_600_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    md: `${k.getUTCMonth() + 1}/${k.getUTCDate()}`,
    day: DAYS[k.getUTCDay()] ?? "",
    hm: `${pad(k.getUTCHours())}:${pad(k.getUTCMinutes())}`,
  };
};

export const renderBriefing = (b: Briefing): string => {
  const t = kst(b.now);
  const lane = (l: LaneFact) => (l.summary ? `${l.key}: ${l.summary}` : l.key);
  const body = [
    ...section("끝난 일", b.finished.map(lane)),
    ...section("진행 중", b.working.map(lane)),
    ...section("멈춘 레인", b.lost.map(lane)),
    ...section("문제", b.faults),
    ...section("쇼츠", b.shorts),
    ...section("승인 기다리는 것", b.approvals),
    ...section("알림", b.alerts ?? []),
  ];
  const cost = b.cost
    ? `[이번 달 비용] $${b.cost.total.toFixed(2)} (호출 ${b.cost.calls.toLocaleString("en-US")}건${b.cost.unknown > 0 ? `, 비용 모름 ${b.cost.unknown.toLocaleString("en-US")}건` : ""})`
    : "[이번 달 비용] 확인 못 함";
  return [
    `도리 아침 브리핑 · ${t.md}(${t.day}) ${t.hm}`,
    "",
    ...(body.length > 0 ? body : ["밤사이 새로 생긴 일 없음", ""]),
    cost,
    `[날씨] ${b.weather ?? "미연결 (위치를 정하면 붙여요)"}`,
  ].join("\n");
};

/** The first line of a lane's final answer or report, without the READY/DONE word it starts with. */
export const laneSummary = (text: string | undefined): string =>
  (text ?? "")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l !== "")
    ?.replace(/^(?:READY|DONE)\b[:\s]*/i, "") ?? "";

/** What each log is, in the owner's words: a briefing line names the job, not the file. */
export const SOURCE_NAMES: Readonly<Record<string, string>> = {
  "shorts-daily.err.log": "쇼츠 자동 제작",
  "shorts-daily.log": "쇼츠 자동 제작",
  "sns-heal.log": "SNS 수집",
  "discord-inbound.err.log": "디코 수신",
  "discord-inbound.log": "디코 수신",
  "instinct-bridge-launchd.err.log": "인스팅트 연결",
  "watchdog.err.log": "감시 작업",
  "er.err.log": "의무실",
  "lead-launcher.err.log": "리드 실행기",
};
export const sourceName = (file: string): string => SOURCE_NAMES[file] ?? file.replace(/\.(?:err\.)?log$/, "");

export const plainPrompt = (text: string): string =>
  [
    "아래는 슈퍼도리(AI 비서)가 주인에게 보내는 아침 브리핑이다. 주인은 개발자가 아니다. 휴대폰으로 3초 안에 읽히게 쉬운 한국어로 다시 써라.",
    "규칙:",
    "- 사실을 더하거나 빼지 않는다. 링크(URL), 금액($), 건수(N건), 횟수는 글자 그대로 둔다.",
    "- 커밋 번호, 파일 경로, 브랜치 이름, 영어 코드·로그 문장은 빼고 무슨 일인지만 짧은 우리말로 쓴다.",
    "- 레인 이름(omh-port4 같은 것)은 앞에 그대로 두되, 뒤 설명은 한 줄 15~30자로 줄인다.",
    "- [섹션] 제목 줄과 '- ' 목록 모양은 그대로 둔다. 인사말·맺음말·이모지는 넣지 않는다. 다시 쓴 브리핑만 출력한다.",
    "예: '- omh-port4: 증거 실재 검증 완료: ready가 --evidence 값을 실제로 검사한다(커밋 c79ba48)' → '- omh-port4: 완료 보고 때 증거를 실제로 확인하게 고침'",
    "예: '- 쇼츠 자동 제작: SHORTS_FAILED topics slot gave nothing (exit <n>) (1회)' → '- 쇼츠 자동 제작: 주제를 못 골라 실패 (1회)'",
    "예: '- hunt-bun-49082: oven-sh/bun#49082' → '- hunt-bun-49082: bun 버그 고치기 후보 (oven-sh/bun#49082)'",
    "",
    text,
  ].join("\n");

/** The rewrite is used only when it kept every link and number of the original; otherwise the original goes out. */
export const keepsFacts = (original: string, rewritten: string): boolean => {
  if (rewritten.trim().length < 20) return false;
  const facts = original.match(/https?:\/\/\S+|\$[\d.,]+|\d[\d,]*(?:\.\d+)?건/g) ?? [];
  return facts.every((f) => rewritten.includes(f));
};
