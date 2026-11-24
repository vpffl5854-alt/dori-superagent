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
