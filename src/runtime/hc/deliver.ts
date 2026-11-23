import type { Exec } from "../exec.ts";
import type { AgentIdentity, AgentStatus, DeliverOptions, DeliverOutcome, Key, SubmitResult } from "../types.ts";
import { hcCall, isKind } from "./exec.ts";
import { type HcProbe, probe, probeWithWord } from "./probe.ts";

const KEY_NAMES: Readonly<Record<Key, string>> = { enter: "enter", escape: "esc" };
const ENTER_TRIES = 3;
const SETTLE_MS = 400;

export type Sleep = (ms: number) => Promise<void>;

/** What waits in omo's input box (the text after the last `❯` down to the rule under it), or undefined with no box. */
export function inputDraft(screen: string): string | undefined {
  const lines = screen.split("\n").map((l) => l.trimEnd());
  const at = lines.findLastIndex((l) => l.trimStart().startsWith("❯"));
  if (at < 0) return undefined;
  const box = [(lines[at] ?? "").trimStart().slice(1)];
  for (const l of lines.slice(at + 1)) {
    if (/^[─━]{10,}$/.test(l.trim())) break;
    box.push(l);
  }
  return box.join("\n").trim();
}

/**
 * hc's `send` pastes and then presses Enter, and omo can miss that Enter (2026-11-24: the lead's input held a message for
 * 49 minutes). Text left in the input also blocks every later delivery, because idle needs an empty input (#62). hc
 * only sends when no person's draft is there, so whatever waits now is ours: press Enter until the input is empty.
 * An unreadable screen or one with no omo input box is no evidence of a missed Enter.
 */
async function submitted(exec: Exec, id: string, sleep: Sleep): Promise<boolean> {
  for (let attempt = 0; attempt <= ENTER_TRIES; attempt++) {
    await sleep(SETTLE_MS);
    let draft: string | undefined;
    try {
      draft = inputDraft(String((await hcCall(exec, ["read", id]))["text"] ?? ""));
    } catch {
      return true;
    }
    if (!draft) return true;
    if (attempt < ENTER_TRIES) await hcCall(exec, ["keys", id, KEY_NAMES.enter]).catch(() => undefined);
  }
  return false;
}

const scrub = (message: string, text: string): string => (text === "" ? message : message.replaceAll(text, "<text>"));
const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The status after hc refused a compare-and-send; a failed re-read is reported as unknown. */
async function statusNow(exec: Exec, id: string): Promise<AgentStatus> {
  try {
    return (await probe(exec, id)).status;
  } catch {
    return "unknown";
  }
}

/**
 * Delivers one message as one argv element (nothing is expanded by a shell). Probe first: a shell in front is
 * `no-agent` whatever the reported status says (a suspended agent, #66), and blocked/error need `force`. hc's
 * `send` pastes and presses Enter atomically, so its refusals (`status_mismatch`, `blocked`) typed nothing and are
 * `not-ready`; an unknown or finished terminal is `no-agent`; any other failure may have arrived and is
 * `ambiguous` (#89). No outcome, detail or failure carries the text.
 */
export async function deliver(
  exec: Exec,
  id: string,
  text: string,
  opts: DeliverOptions = {},
  sleep: Sleep = (ms) => Bun.sleep(ms),
): Promise<DeliverOutcome> {
  const { when = "idle", force = false } = opts;
  let probed: HcProbe;
  try {
    probed = await probeWithWord(exec, id);
  } catch (e) {
    process.stderr.write(`dori: hc get ${id} failed (${messageOf(e)}); holding delivery\n`);
    return { kind: "not-ready", status: "unknown" };
  }
  const before = probed.probe;
  if (before.status === "gone" || before.shellInFront) return { kind: "no-agent" };
  if (!force && (before.status === "blocked" || before.status === "error"))
    return { kind: "not-ready", status: before.status };
  // A terminal that has never reported (status null, no shell in front: an editor, a program without OSC 7501) gets
  // nothing typed into it whatever `when` says: its state is unknown, so the message stays queued.
  if (before.status === "unknown") return { kind: "not-ready", status: "unknown" };
  // `done` is the program's own "turn finished, waiting": typing is what it waits for, and `--if` takes only idle|working.
  // Idle read off the screen while hc's own word is still `working` (#178): gate on that word, so hc refuses (and the
  // message stays queued) if omo moves to blocked or idle in between. omo reports `working` for a turn too, so a turn
  // that starts in the one round trip between the screen read and this send still passes.
  const screenIdle = when === "idle" && before.status === "idle" && probed.word === "working";
  const gate =
    when === "any" || (when === "idle" && before.status === "done") ? [] : ["--if", screenIdle ? "working" : when];
  const argv = ["send", id, ...gate, ...(force ? ["--force"] : []), "--", text];
  let result: Record<string, unknown>;
  try {
    result = await hcCall(exec, argv, { redact: text });
  } catch (e) {
    if (isKind(e, "blocked")) return { kind: "not-ready", status: "blocked" };
    if (isKind(e, "status_mismatch")) return { kind: "not-ready", status: await statusNow(exec, id) };
    if (isKind(e, "not_found", "finished")) return { kind: "no-agent" };
    const detail = scrub(
      e instanceof Error && "reason" in e && typeof e.reason === "string" ? e.reason : messageOf(e),
      text,
    );
    return {
      kind: "ambiguous",
      detail: detail || "hc send did not complete",
      failure: e instanceof Error ? new Error(scrub(e.message, text)) : detail,
    };
  }
  if (!(await submitted(exec, id, sleep))) {
    const into: AgentIdentity = {
      ...(before.agent === undefined ? {} : { agent: before.agent }),
      ...(before.pgid === undefined ? {} : { pgid: before.pgid }),
    };
    return {
      kind: "typed",
      into,
      failure: new Error(`hc ${id}: the text is in the input but Enter did not submit it`),
    };
  }
  const turn = typeof result["turn"] === "number" ? result["turn"] : undefined;
  const started = typeof result["started"] === "boolean" ? result["started"] : undefined;
  return { kind: "delivered", ...(turn === undefined ? {} : { turn }), ...(started === undefined ? {} : { started }) };
}

/** The operator's explicit `--to-shell`: only into a session whose probe says `shell`; no gate (a shell reports none). */
export async function typeIntoShell(exec: Exec, id: string, text: string): Promise<boolean> {
  if ((await probe(exec, id)).status !== "shell") return false;
  await hcCall(exec, ["send", id, "--", text], { redact: text });
  return true;
}

/** An earlier delivery left its text in the input: press only Enter, and only into the agent it was typed into (#108). */
export async function submitTyped(exec: Exec, id: string, into: AgentIdentity, sleep: Sleep): Promise<SubmitResult> {
  const now = await probe(exec, id);
  if (now.status === "gone") return "wait";
  if (now.shellInFront) return "changed";
  if (into.agent !== undefined && now.agent !== into.agent) return "changed";
  if (into.pgid !== undefined && now.pgid !== into.pgid) return "changed";
  await hcCall(exec, ["keys", id, KEY_NAMES.enter]);
  return (await submitted(exec, id, sleep)) ? "submitted" : "wait";
}

export async function keys(exec: Exec, id: string, names: readonly Key[]): Promise<void> {
  await hcCall(exec, ["keys", id, ...names.map((k) => KEY_NAMES[k])]);
}

export async function read(exec: Exec, id: string, lines: number, unwrapped = false): Promise<string> {
  const result = await hcCall(exec, ["read", id, "--lines", String(lines)]);
  const text = typeof result["text"] === "string" ? result["text"] : "";
  if (!unwrapped) return text;
  const cols = (await hcCall(exec, ["get", id]))["cols"];
  return typeof cols === "number" && cols > 0 ? joinWrapped(text, cols) : text;
}

/**
 * hc prints screen rows with trailing blanks cut and says nothing about wrapping, so a row that fills the terminal is
 * taken as wrapped: `cols` cells wide (cut inside a word: joined as is), or `cols - 1` when the wrap fell on a space
 * that was cut (joined with that space put back, so `rate` + `limit` reads `rate limit` again). Width is counted in
 * terminal cells (a CJK character or an emoji is two). A line the agent printed exactly that wide is joined to the next
 * one too: callers must not treat a joined line as one message (launch strips only the warning text, never a line).
 */
export const joinWrapped = (text: string, cols: number): string => {
  const lines: string[] = [];
  let glue: string | undefined;
  for (const row of text.split("\n")) {
    if (glue === undefined) lines.push(row);
    else lines[lines.length - 1] += glue + row;
    const width = Bun.stringWidth(row);
    glue = cols <= 1 || width < cols - 1 ? undefined : width >= cols ? "" : " ";
  }
  return lines.join("\n");
};
