/**
 * The central router: every inbound message, whatever messenger it came from, is sorted into one
 * of four kinds and sent to the one place that handles that kind. Chat goes to the fast model,
 * coding to a lane or to Devin (by the Devin rules in prompts/lead.md), video to a render job, and
 * a status question to the status report. Handlers are injected, so the router decides and the
 * caller owns how each destination is reached.
 */
import type { UnifiedMessage } from "./messenger/unified.ts";

export type RouteKind = "chat" | "coding" | "video" | "status";
export type Destination = "fast-model" | "lane" | "devin" | "render" | "status";
export type Route = { readonly kind: RouteKind; readonly destination: Destination; readonly reason: string };

export type RouterOptions = {
  /** False when the Devin subscription is out (or Devin is switched off): coding then always opens a lane. */
  readonly devinAvailable: boolean;
};

const STATUS =
  /상태|진행\s*상황|어디까지|진척|현황|레인\s*목록|뭐\s*하고\s*있|\bstatus\b|\bprogress\b|what'?s running/i;
/** Words that only ever mean code: they win over video and status words in the same message. */
const CODE_STRONG =
  /코드|코딩|버그|리팩터|리팩토링|구현|커밋|브랜치|테스트\s*(?:가|를|을|이|도|는)?\s*(?:깨|실패|통과|돌려|실행|작성|추가|짜|고쳐|케이스|코드|커버리지)|타입\s*에러|함수|컴파일|\bpr\b|\bci\b|\bbugs?\b|refactor|implement|\bcommit\b|\bbranch\b|\btests?\b|\.(?:ts|tsx|js|py|rs|go)\b|```/i;
/** Words that mean code unless the message is about a video ("자막 고쳐" is a video edit). */
const CODE_WEAK = /고쳐|빌드|배포|마이그레이션|\bfix\b|\bbuild\b|\bdeploy\b|\bmigrat/i;
const VIDEO =
  /영상|동영상|쇼츠|숏츠|릴스|렌더|자막|썸네일|moviepy|ffmpeg|\bvideos?\b|\bshorts\b|\brender|\breels?\b|\.mp4\b/i;

/** lead.md: one-line fixes and anything the owner is waiting on stay off Devin. */
const LANE_ONLY = /한\s*줄|오타|간단|빨리|바로|급해|typo|one-?line|quick/i;
/** lead.md: work behind a login or another service's auth is not sent to Devin. */
const NEEDS_AUTH = /로그인|인증|login|oauth|2fa/i;
/** lead.md: multi-file implementation, refactors, root-cause hunts and migrations go to Devin. */
const DEVIN_WORK =
  /리팩터|리팩토링|구현|여러\s*파일|원인|추적|마이그레이션|refactor|implement|root\s*cause|investigate|migrat/i;

/** The owner naming the lead ("리드 이거 해줘", "리드한테 전달해") always means work for the lead, whatever the words. */
const LEAD = /(?:^|[^가-힣])리드/;

export const classify = (text: string): RouteKind => {
  if (LEAD.test(text)) return "coding";
  const strong = CODE_STRONG.test(text);
  if (STATUS.test(text) && !strong) return "status";
  if (strong) return "coding";
  if (VIDEO.test(text)) return "video";
  if (CODE_WEAK.test(text)) return "coding";
  return "chat";
};

const codingRoute = (text: string, opts: RouterOptions): Route => {
  const lane = (reason: string): Route => ({ kind: "coding", destination: "lane", reason });
  if (!opts.devinAvailable) return lane("Devin is unavailable");
  if (LANE_ONLY.test(text)) return lane("small or urgent change");
  if (NEEDS_AUTH.test(text)) return lane("needs a login Devin cannot do");
  if (DEVIN_WORK.test(text)) return { kind: "coding", destination: "devin", reason: "self-contained multi-step work" };
  return lane("default coding destination");
};

export const route = (text: string, opts: RouterOptions): Route => {
  const kind = classify(text);
  if (kind === "coding") return codingRoute(text, opts);
  if (kind === "video") return { kind, destination: "render", reason: "video request" };
  if (kind === "status") return { kind, destination: "status", reason: "status question" };
  return { kind, destination: "fast-model", reason: "conversation" };
};

/** One handler per destination; each returns the reply text for the sender. */
export type Handlers = Readonly<Record<Destination, (msg: UnifiedMessage) => Promise<string>>>;

export const dispatch = async (
  msg: UnifiedMessage,
  opts: RouterOptions,
  handlers: Handlers,
): Promise<{ readonly route: Route; readonly reply: string }> => {
  const r = route(msg.text, opts);
  return { route: r, reply: await handlers[r.destination](msg) };
};

/** Devin is on unless DORI_DEVIN=off (the subscription ran out, or the owner switched it off). */
export const routerOptionsFromEnv = (env: Readonly<Record<string, string | undefined>>): RouterOptions => ({
  devinAvailable: env["DORI_DEVIN"]?.trim().toLowerCase() !== "off",
});

/** The suffix every INBOUND line carries, so the lead reads the router's pick next to the message. */
export const routeTag = (msg: UnifiedMessage, opts: RouterOptions): string => {
  const r = route(msg.text, opts);
  return ` route=${r.kind}:${r.destination}`;
};
