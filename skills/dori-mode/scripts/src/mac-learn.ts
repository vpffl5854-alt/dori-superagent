/**
 * What 맥손 keeps between tasks. The history of every spoken task (`history.jsonl`) is what the nightly fixer reads
 * for failures. The tips (`tips.json`) are per app: when a task failed on one way and then got done another way, the
 * model writes one line about the way that worked, and every later question about that app carries it, so the next
 * task starts with the way that works (the Discord Quick Switcher, a URL opened rather than typed).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Turn } from "./mac-brain.ts";

export type HistoryEntry = {
  readonly at: string;
  readonly id: string;
  readonly goal: string;
  readonly ok: boolean;
  readonly held: boolean;
  readonly text: string;
  readonly turns: readonly Turn[];
};

export const appendHistory = (dir: string, e: HistoryEntry): void => {
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, "history.jsonl"), `${JSON.stringify(e)}\n`);
};

export const readHistory = (dir: string, since: number): HistoryEntry[] => {
  const path = join(dir, "history.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .flatMap((l) => {
      try {
        const e = JSON.parse(l) as HistoryEntry;
        return Date.parse(e.at) >= since ? [e] : [];
      } catch {
        return [];
      }
    });
};

/**
 * A failure worth fixing in the code: not one held for the owner's button, stopped by them, waiting while they used
 * the app, refused as not doable, or met with a locked screen. Those are 맥손 doing what it should.
 */
export const fixableFailure = (e: HistoryEntry): boolean =>
  !e.ok && !e.held && !/멈춰|쓰는 중|할 수 없는 일|잠겨 있거나|꺼져 있어요|내가 쓰지 않은 글/.test(e.text);

const TIPS_MAX = 6;
const key = (app: string): string => app.normalize("NFC").trim().toLowerCase();

const readTips = (dir: string): Record<string, string[]> => {
  try {
    return JSON.parse(readFileSync(join(dir, "tips.json"), "utf8")) as Record<string, string[]>;
  } catch {
    return {};
  }
};

export const tipsOf = (dir: string, app: string): string[] => readTips(dir)[key(app)] ?? [];

/** Keeps the newest few per app; the same tip again (any case) moves to the end instead of repeating. */
export const addTip = (dir: string, app: string, tip: string): void => {
  const all = readTips(dir);
  const same = (t: string) => t.toLowerCase() === tip.toLowerCase();
  all[key(app)] = [...(all[key(app)] ?? []).filter((t) => !same(t)), tip].slice(-TIPS_MAX);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "tips.json"), JSON.stringify(all, null, 2));
};

export const tipPrompt = (goal: string, app: string, turns: readonly Turn[]): string =>
  [
    `A Mac task in the app "${app}" first failed on some ways and was then done another way.`,
    `Goal (Korean): ${goal}`,
    "What was done, in order (action -> result):",
    ...turns.map((t, i) => `${i + 1}. ${t.act} -> ${t.result}`),
    "",
    `Write ONE line for the next task in "${app}": which way works there and which does not, in English, at most 40`,
    'words, naming the actions (press, type, key ["cmd","k"], menu, open with "url"). Nothing about this goal\'s',
    "own text. If nothing general was learned, answer NONE.",
  ].join("\n");

/** The tip in a model's answer: its first line, or undefined for NONE or an answer that is no line. */
export const parseTip = (answer: string): string | undefined => {
  const line = answer
    .trim()
    .split("\n")[0]
    ?.replace(/^[-*\s"']+|["'\s]+$/g, "")
    .trim();
  return line && !/^none\b/i.test(line) && line.length >= 10 ? line.slice(0, 300) : undefined;
};
