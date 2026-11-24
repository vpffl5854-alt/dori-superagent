/**
 * dori notify --level now|later --text T [--source S]: every 슈퍼도리 alert in one place. `now` is something the owner
 * must see at once (a new repeating fault, a bounty to race for) and goes to 도리방 straight away; `later` is worth
 * knowing but can wait (an SNS selector that broke and healed) and waits in a queue for the next morning briefing.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Command, die } from "./cli-context.ts";
import { dorichatBot } from "./cli-dorichat.ts";
import type { DoriConfig } from "./config.ts";

export type Queued = { readonly at: string; readonly source: string; readonly text: string };

const queuePath = (config: DoriConfig): string => join(config.stateDir, "notify-queue.jsonl");

/** What waits for the briefing; a line that is not JSON is skipped. */
export const readQueue = (config: DoriConfig): Queued[] =>
  existsSync(queuePath(config))
    ? readFileSync(queuePath(config), "utf8")
        .split("\n")
        .flatMap((l) => {
          try {
            return l.trim() ? [JSON.parse(l) as Queued] : [];
          } catch {
            return [];
          }
        })
    : [];

/** Empties the queue once the briefing that carried it went out. */
export const clearQueue = (config: DoriConfig): void => {
  if (existsSync(queuePath(config))) writeFileSync(queuePath(config), "");
};

const notify: Command = async ({ opt, config }) => {
  const level = opt("level") ?? "later";
  if (level !== "now" && level !== "later") die("--level is now or later");
  const text = opt("text") ?? die("notify needs --text");
  const source = opt("source") ?? "도리";
  if (level === "later") {
    appendFileSync(queuePath(config), `${JSON.stringify({ at: new Date().toISOString(), source, text })}\n`);
    return void console.log("NOTIFY_QUEUED");
  }
  const bot = dorichatBot(config);
  if (!bot?.cfg.chatId) die("no 도리방 bot (dorichat.tokenFile / chatId)");
  await bot.tg.send({ chatId: bot.cfg.chatId }, `[${source}] ${text}`);
  console.log("NOTIFY_SENT");
};

export const notifyCommands: Readonly<Record<string, Command>> = { notify };
