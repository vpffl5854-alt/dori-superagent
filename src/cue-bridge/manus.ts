/**
 * Manus API calls for the Cue bridge: send a Discord message to the Cue task, then poll that task for Cue's reply.
 *
 * The API key has account-wide rights, so it only ever travels in the x-manus-api-key header and is never logged.
 * task.sendMessage is limited to 10 calls a minute, so every send goes through one shared rate limiter.
 */
import { CredentialError } from "./credentials.ts";

export const MANUS_BASE = "https://api.manus.ai";
export const SEND_PER_MINUTE = 10;

export type HttpRequest = {
  readonly method: "GET" | "POST";
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
};
type HttpResponse = { readonly status: number; readonly body: string };
export type Http = (req: HttpRequest) => Promise<HttpResponse>;

export const fetchHttp: Http = async (req) => {
  const res = await fetch(req.url, {
    method: req.method,
    headers: req.headers,
    ...(req.body === undefined ? {} : { body: req.body }),
    signal: AbortSignal.timeout(60_000),
  });
  return { status: res.status, body: await res.text() };
};

export class ManusError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ManusError";
  }
}

export type ManusClient = {
  readonly agentList: () => Promise<unknown>;
  readonly sendMessage: (taskId: string, content: string) => Promise<unknown>;
  readonly listMessages: (taskId: string) => Promise<unknown>;
  readonly taskDetail: (taskId: string) => Promise<unknown>;
};

const call = async (
  http: Http,
  apiKey: string,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<unknown> => {
  const res = await http({
    method,
    url: `${MANUS_BASE}${path}`,
    headers: { "x-manus-api-key": apiKey, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (res.status === 401 || res.status === 403)
    throw new CredentialError(`the Manus API key was rejected (${res.status})`);
  if (res.status >= 300) throw new ManusError(`manus ${path} -> ${res.status} ${res.body.slice(0, 160)}`, res.status);
  try {
    return JSON.parse(res.body) as unknown;
  } catch {
    throw new ManusError(`manus ${path} returned non-JSON (${res.status})`, res.status);
  }
};

export const manusClient = (http: Http, apiKey: string): ManusClient => ({
  agentList: () => call(http, apiKey, "GET", "/v2/agent.list"),
  sendMessage: (taskId, content) =>
    call(http, apiKey, "POST", "/v2/task.sendMessage", { task_id: taskId, message: { content } }),
  listMessages: (taskId) => call(http, apiKey, "GET", `/v2/task.listMessages?task_id=${encodeURIComponent(taskId)}`),
  taskDetail: (taskId) => call(http, apiKey, "GET", `/v2/task.detail?task_id=${encodeURIComponent(taskId)}`),
});

export type RateLimiter = { readonly take: () => Promise<void> };

/** At most `perWindow` sends in any `windowMs`, in call order; the wait is computed from a clock the test supplies. */
export const rateLimiter = (
  perWindow: number,
  windowMs: number,
  deps: { readonly now: () => number; readonly sleep: (ms: number) => Promise<void> },
): RateLimiter => {
  const sent: number[] = [];
  return {
    take: async () => {
      for (;;) {
        const t = deps.now();
        while (sent.length && t - sent[0]! >= windowMs) sent.shift();
        if (sent.length < perWindow) {
          sent.push(t);
          return;
        }
        await deps.sleep(sent[0]! + windowMs - t);
      }
    },
  };
};

export type ManusMessage = { readonly id: string; readonly role: string; readonly content: string };

/** The message list of a task, from whatever shape the response wraps it in. */
export const parseMessages = (raw: unknown): ManusMessage[] => {
  const seen = new Set<unknown>();
  const find = (v: unknown): unknown[] | undefined => {
    if (!v || typeof v !== "object" || seen.has(v)) return undefined;
    seen.add(v);
    if (Array.isArray(v)) return v;
    for (const key of ["messages", "data", "result", "items"]) {
      const hit = find((v as Record<string, unknown>)[key]);
      if (hit) return hit;
    }
    return undefined;
  };
  return (find(raw) ?? [])
    .map((m) => {
      const r = (m ?? {}) as Record<string, unknown>;
      const content = typeof r["content"] === "string" ? r["content"] : r["text"];
      return {
        id: String(r["id"] ?? r["message_id"] ?? ""),
        role: String(r["role"] ?? r["sender"] ?? ""),
        content: typeof content === "string" ? content : "",
      };
    })
    .filter((m) => m.id !== "" && m.content.trim() !== "");
};

/**
 * Cue's replies past `afterId`, oldest first. The first poll after a send passes the id of the message just sent; when
 * that id is not in the list yet (the API lags) nothing counts as new, because posting a reply that predates the send
 * would put an old answer in the room as if it answered the new message.
 */
export const repliesAfter = (messages: readonly ManusMessage[], afterId: string | undefined): ManusMessage[] => {
  if (afterId === undefined) return messages.filter((m) => m.role !== "user");
  const start = messages.findIndex((m) => m.id === afterId);
  if (start < 0) return [];
  return messages.slice(start + 1).filter((m) => m.role !== "user");
};
