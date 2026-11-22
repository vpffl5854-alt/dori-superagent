/**
 * Dori reporting its own breakdowns: new lines in its logs are reduced to a signature (timestamps, numbers, ids and
 * random suffixes removed), benign chatter is dropped, and a signature seen often enough becomes an incident: one
 * GitHub issue, one backlog item with a fix brief, one message to the owner. The same signature is never reported
 * twice while its issue is open.
 */
import { createHash } from "node:crypto";

/** Lines that are normal operation, not a fault: reconnects the gateway asks for, progress, blank and code frames. */
export const DEFAULT_NOISE = [
  "gateway asked to reconnect",
  "gateway ready",
  "backfill fetched",
  "missed a heartbeat ack",
  "^Bun v\\d",
  "^\\s*\\d+ \\|",
  "^\\s*\\^+\\s*$",
  "^\\s*at ",
  "^\\s*\\^-+",
  // A chat message quoted in a log is someone's words, not Dori's fault.
  "^INBOUND ",
  // The network went away for a while: nothing in Dori's code or setup to fix.
  "ENOTFOUND|ETIMEDOUT|ECONNRESET|EAI_AGAIN|network is unreachable",
  "^SNS_OK|^SNS_HEAL_NOTHING|^SNS_HEAL_TRANSIENT|^SHORTS_(?:JOB|OK|SENT|UPLOADED)|^ER_READY|^HUNT ",
];

/** Lines that are a fault even in a stdout log. */
const FAULT =
  /error|failed|exception|traceback|enoent|eacces|timed? ?out|refused|denied|not found|name_taken|_FAILED|panic|fatal/i;

export const signature = (line: string): string =>
  line
    .replace(/^\[[^\]]*\]\s*/, "")
    .replace(/\d{4}-\d{2}-\d{2}[T ][\d:.]+Z?/g, "<time>")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<id>")
    .replace(/\b(?:pid|PID)[ =]\d+/g, "pid <n>")
    .replace(/\b\d{3,}\b/g, "<n>")
    .replace(/\b[0-9a-f]{12,}\b/gi, "<hex>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);

/** Secrets never leave the machine in an issue: bearer tokens, key=value secrets and long opaque strings. */
export const redact = (text: string): string =>
  text
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/((?:token|key|secret|password|cookie)["']?\s*[:=]\s*["']?)[^\s"',]+/gi, "$1[redacted]")
    .replace(/\b[A-Za-z0-9_\-]{40,}\b/g, "[redacted]");

export type Seen = { count: number; firstAt: string; lastAt: string; file: string; sample: string; issue?: string };
export type IncidentState = { offsets: Record<string, number>; seen: Record<string, Seen> };

export const scanText = (
  state: IncidentState,
  file: string,
  text: string,
  at: string,
  noise: readonly string[] = DEFAULT_NOISE,
): IncidentState => {
  const quiet = noise.map((n) => new RegExp(n, "i"));
  const seen = { ...state.seen };
  for (const line of text.split("\n")) {
    if (!line.trim() || quiet.some((q) => q.test(line)) || !FAULT.test(line)) continue;
    const sig = signature(line);
    const prev = seen[sig];
    seen[sig] = prev
      ? { ...prev, count: prev.count + 1, lastAt: at }
      : { count: 1, firstAt: at, lastAt: at, file, sample: redact(line.trim()).slice(0, 500) };
  }
  return { ...state, seen };
};

export const incidentKey = (sig: string): string =>
  `incident-${createHash("sha1").update(sig).digest("hex").slice(0, 8)}`;

/** Seen at least `threshold` times and not already carried by an open issue. */
export const dueIncidents = (state: IncidentState, threshold: number): string[] =>
  Object.entries(state.seen)
    .filter(([, s]) => s.count >= threshold && !s.issue)
    .sort((a, b) => b[1].count - a[1].count)
    .map(([sig]) => sig);

export const issueBody = (sig: string, s: Seen): string =>
  [
    "도리가 자기 로그에서 같은 고장을 반복해서 찾아 자동으로 신고했다.",
    "",
    `- 로그: \`${s.file}\``,
    `- 횟수: ${s.count}회 (${s.firstAt} ~ ${s.lastAt})`,
    `- 서명: \`${sig}\``,
    "",
    "예시 줄 (비밀값은 가렸다):",
    "```",
    s.sample,
    "```",
    "",
    "## 고치는 레인에게",
    "1. 로그 파일의 앞뒤를 읽고 원인을 찾는다. 같은 줄을 만드는 코드나 설정(launchd plist, ~/.dori-superagent/bin 스크립트, 저장소 코드)을 찾는다.",
    "2. 저장소 코드가 원인이면 실패하는 테스트를 먼저 쓰고 고친 뒤 `bun run ci` 통과, 이 이슈를 닫는 PR을 형 저장소(mine)에 올린다.",
    "3. 맥 설정이나 스크립트가 원인이면 백업을 만든 뒤 고치고, 무엇을 바꿨는지 이 이슈에 댓글로 남긴다.",
    "4. 고친 뒤 같은 로그에 이 줄이 다시 안 생기는지 한 주기 이상 지켜본다.",
  ].join("\n");

export const issueTitle = (sig: string): string => `[자동 신고] ${sig.slice(0, 90)}`;
