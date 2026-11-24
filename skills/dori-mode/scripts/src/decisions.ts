/**
 * 지브의 결정 장부: standing decisions the owner made once ("끝난 레인은 닫아라"), kept in one file every Dori pane
 * reads before it works, so the owner never has to say the same thing twice. One line per decision, newest last,
 * with the day and where it was said. Nothing is ever rewritten; a decision that changes gets a new line.
 */

export const LEDGER_HEAD = [
  "# 지브의 결정 장부",
  "",
  "지브가 한 번 정한 것. 슈퍼도리의 모든 판(리드·duty·레인·디코도리)은 일하기 전에 이 파일을 읽고 따른다.",
  "같은 주제로 줄이 여러 개면 **아래쪽(최신)** 이 이긴다. 줄을 지우거나 고치지 않고, 바뀌면 새 줄을 더한다.",
  "",
].join("\n");

/** The day in Korea. */
export const kstDay = (d: Date): string => new Date(d.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);

export const decisionLine = (when: Date, text: string, source: string): string =>
  `- ${kstDay(when)} · ${text.replace(/\s+/g, " ").trim()} (출처: ${source})`;

/** "기억해: …" / "기억해 …" in 도리방 is a decision to record; the text after it is the decision. */
export const rememberText = (message: string): string | undefined => {
  const m = /^\s*기억해\s*[:：]?\s*(.+)$/su.exec(message);
  const t = m?.[1]?.trim();
  return t && t.length >= 2 ? t : undefined;
};
