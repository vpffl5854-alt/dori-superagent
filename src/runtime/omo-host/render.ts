// A host session has no screen. `read` renders its transcript tail as the lines a TUI pane would show, so the parsers
// that read a lane's screen (launch's startup checks, the freshness sweep, supervision, pause) work unchanged: the
// agent's text and tool output as printed, `Error: ...` for a failed turn, and a footer drawn from the live state.
import { rec, str } from "./exec.ts";

/** Lines of one tool result kept, as a pane keeps a tool's output collapsed to its first rows. */
const RESULT_LINES = 12;
const ARGS_CHARS = 160;

const lines = (text: string): string[] => text.replace(/\s+$/, "").split("\n");

const textOf = (part: Record<string, unknown>): string | undefined =>
  part["type"] === "text" ? str(part["text"]) : undefined;

const partsOf = (content: unknown): Record<string, unknown>[] =>
  typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content.map(rec) : [];

const callLine = (part: Record<string, unknown>): string => {
  const args = rec(part["arguments"]);
  const shown = str(args["command"]) ?? str(args["code"]) ?? JSON.stringify(args);
  return `• ${str(part["name"]) ?? "tool"} ${lines(shown)[0]?.slice(0, ARGS_CHARS) ?? ""}`.trimEnd();
};

function messageLines(message: Record<string, unknown>): string[] {
  const parts = partsOf(message["content"]);
  const role = message["role"];
  if (role === "user") return parts.flatMap((p) => lines(textOf(p) ?? "").map((l) => `> ${l}`));
  if (role === "toolResult") {
    const mark = message["isError"] === true ? "  ✗ " : "  ";
    return parts.flatMap((p) => lines(textOf(p) ?? "").slice(0, RESULT_LINES)).map((l) => `${mark}${l}`);
  }
  if (role !== "assistant") return [];
  const out = parts.flatMap((p) => (p["type"] === "toolCall" ? [callLine(p)] : lines(textOf(p) ?? "")));
  const error = str(message["errorMessage"]);
  return error === undefined ? out : [...out, ...lines(`Error: ${error}`)];
}

/** The transcript entries (`read --tail` order, oldest first) as screen lines; entries that are not messages draw nothing. */
export const renderEntries = (entries: readonly unknown[]): string[] =>
  entries.flatMap((entry) => {
    const e = rec(entry);
    return e["type"] === "message" ? messageLines(rec(e["message"])) : [];
  });

const elapsed = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const [h, m] = [Math.floor(s / 3600), Math.floor((s % 3600) / 60)];
  return `${h ? `${h}h ` : ""}${h || m ? `${m}m ` : ""}${s % 60}s`;
};

const questionLine = (title: string | undefined, options: unknown): string => {
  const labels = (Array.isArray(options) ? options : []).flatMap((o) =>
    typeof o === "string" ? [o] : (str(rec(o)["label"]) ?? []),
  );
  return `? ${lines(title ?? "(question)")[0]}${labels.length ? ` [${labels.join(" / ")}]` : ""}`;
};

/**
 * A question the agent asked (`? <title> [option / option]`): it waits for the answer as its next prompt. The question
 * tool's request carries `questions[]` ({ header, question, options: [{ label }] }), one line each; a select dialog
 * has its own title and string options.
 */
const questionLines = (state: Record<string, unknown>): string[] =>
  [state["pendingQuestions"], state["pendingDialogs"]].flatMap((list) =>
    (Array.isArray(list) ? list.map(rec) : []).flatMap((q) =>
      Array.isArray(q["questions"])
        ? q["questions"].map(rec).map((s) => questionLine(str(s["question"]) ?? str(s["header"]), s["options"]))
        : [questionLine(str(q["title"]) ?? str(q["question"]), q["options"])],
    ),
  );

const count = (value: unknown): number => (typeof value === "number" && value > 0 ? value : 0);

/**
 * The background work an idle turn waits on (a shell the agent's bash detached, a child session). omo lists the goal
 * monitor there too, which runs for every session with a goal and is no work of its own.
 */
const backgroundWork = (lifecycle: Record<string, unknown>): number => {
  const on = rec(lifecycle["waitingOn"]);
  const sources = Array.isArray(on["background"]) ? on["background"].map(rec) : [];
  return (
    count(on["children"]) +
    sources.filter((s) => s["source"] !== "goal-monitor").reduce((n, s) => n + count(s["activeCount"]), 0)
  );
};

/**
 * What a pane's footer shows: any open question, then `Working (<time in this state>)` while a turn runs (supervision
 * reads the duration), `Running (<time>) · waiting on N background task(s)` while the agent waits on its own
 * background work (a lane in a long command is not stalled), the bare idle prompt `❯` otherwise (the freshness sweep's
 * idle check), then the goal as omo's footer names it.
 */
export function footerLines(state: Record<string, unknown>, goal: string, now: number): string[] {
  const lifecycle = rec(state["lifecycle"]);
  const since = Date.parse(str(lifecycle["since"]) ?? "");
  const time = elapsed(Number.isNaN(since) ? 0 : now - since);
  const working = state["isStreaming"] === true || state["isCompacting"] === true;
  const waiting = backgroundWork(lifecycle);
  const status = working
    ? `Working (${time})`
    : waiting
      ? `Running (${time}) · waiting on ${waiting} background task${waiting === 1 ? "" : "s"}`
      : "❯";
  const goalLine = goal === "active" ? "Pursuing goal" : goal === "none" ? [] : `Goal ${goal}`;
  return [...questionLines(state), status, ...(Array.isArray(goalLine) ? goalLine : [goalLine])];
}
