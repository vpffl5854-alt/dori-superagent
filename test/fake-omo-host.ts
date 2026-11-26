// A fake `omo host session ... --json` over an in-memory set of sessions: one JSON line on stdout per call, exit 3 with
// `{ action: "refuse", reason }` for a host refusal, as the real CLI answers.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Exec, ExecResult } from "../src/runtime/exec.ts";

export type HostSession = {
  id: string;
  name?: string;
  cwd: string;
  /** `get_state` as the host reports it (isStreaming, pendingQuestions, lifecycle, sessionFile, ...). */
  state: Record<string, unknown>;
  entries: unknown[];
  /** Parked (idle past eviction, or closed): not listed, and resumed by any verb that names it, as the host does. */
  parked?: boolean;
};

export const SOCKET = "/home/u/.omo/agent/rpc/rpc.sock";
const ok = (value: Record<string, unknown>): ExecResult => ({
  code: 0,
  stdout: `${JSON.stringify(value)}\n`,
  stderr: "",
});
const refuse = (reason: string): ExecResult => ({
  code: 3,
  stdout: `${JSON.stringify({ action: "refuse", reason, detail: `host refused: ${reason}` })}\n`,
  stderr: "",
});
const flag = (args: readonly string[], name: string): string | undefined => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};

export const goalFile = (s: HostSession): string =>
  join(dirname(String(s.state["sessionFile"])), "extensions", "goal", `${s.id}.json`);
export const writeGoal = (s: HostSession, status: string): void => {
  mkdirSync(dirname(goalFile(s)), { recursive: true });
  writeFileSync(goalFile(s), JSON.stringify({ version: 1, goal: { status } }));
};

export class FakeOmoHost {
  readonly sessions = new Map<string, HostSession>();
  readonly calls: string[][] = [];
  /** A reason the next call of this verb is refused with, once. */
  readonly refuseNext = new Map<string, string>();
  /** Where opened sessions' files live (a temp dir in tests that read goal records). */
  constructor(private readonly sessionsDir = "/nonexistent/sessions") {}

  add(over: Partial<HostSession> & { id: string }): HostSession {
    const s: HostSession = {
      cwd: "/repo",
      entries: [],
      ...over,
      state: {
        isStreaming: false,
        sessionId: over.id,
        sessionFile: join(this.sessionsDir, "--repo--", `x_${over.id}.jsonl`),
        cwd: over.cwd ?? "/repo",
        ...over.state,
      },
    };
    this.sessions.set(s.id, s);
    return s;
  }

  readonly exec: Exec = async (cmd, argv) => {
    if (cmd !== "omo" || argv[0] !== "host" || argv[1] !== "session" || argv.at(-1) !== "--json")
      return { code: 2, stdout: "", stderr: `unexpected ${cmd} ${argv.join(" ")}` };
    const args = argv.slice(2, -1);
    this.calls.push(args);
    const [verb = "", ref = ""] = args;
    const refused = this.refuseNext.get(verb);
    if (refused !== undefined) {
      this.refuseNext.delete(verb);
      return refuse(refused);
    }
    if (verb === "open") {
      const id = `00000000-0000-4000-8000-${String(this.sessions.size + 1).padStart(12, "0")}`;
      const name = flag(args, "--name");
      this.add({ id, cwd: flag(args, "--cwd") ?? "/", ...(name === undefined ? {} : { name }) });
      return ok({ action: "open", sessionId: "rpc-1", durableSessionId: id, socket: SOCKET });
    }
    if (verb === "list") {
      const sessions = [...this.sessions.values()]
        .filter((s) => !s.parked)
        .map((s) => ({
          durableSessionId: s.id,
          name: s.name,
          cwd: s.cwd,
          status: "open",
          archived: false,
          activity: s.state["isStreaming"] === true ? "running" : "idle",
        }));
      return ok({ action: "list", socket: SOCKET, sessions });
    }
    const s = this.sessions.get(ref);
    if (s === undefined) return refuse("unknown_session");
    s.parked = false;
    const text = args[2] ?? "";
    switch (verb) {
      case "state":
        return ok({ action: "state", durableSessionId: s.id, state: s.state });
      case "read":
        return ok({ action: "read", entries: s.entries.slice(-Number(flag(args, "--tail") ?? s.entries.length)) });
      case "prompt": {
        if (s.state["isStreaming"] === true) return refuse("busy");
        const goal = /^\/goal (pause|resume)$/.exec(text.trim())?.[1];
        if (goal !== undefined) {
          writeGoal(s, goal === "pause" ? "paused" : "active");
          return ok({ action: "prompt", disposition: "handled" });
        }
        s.entries.push({ type: "message", message: { role: "user", content: text } });
        s.state = { ...s.state, isStreaming: true };
        return ok({ action: "prompt", disposition: "started" });
      }
      case "steer":
        return ok({ action: "steer", disposition: "queued", streaming: s.state["isStreaming"] === true });
      case "abort": {
        const aborted = s.state["isStreaming"] === true;
        s.state = { ...s.state, isStreaming: false };
        return ok({ action: "abort", acknowledged: true, aborted });
      }
      case "close":
        s.parked = true;
        return ok({ action: "close", closed: true });
      default:
        return { code: 2, stdout: `${JSON.stringify({ action: "error", reason: "usage" })}\n`, stderr: "" };
    }
  };
}
