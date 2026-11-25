/** 도리방's bot: its token file, the owner who alone may press or type, and the chat it talks in. */
import { existsSync, readFileSync } from "node:fs";
import type { DoriConfig } from "./config.ts";
import { fetchHttp } from "./messenger/http.ts";
import { Telegram } from "./messenger/telegram.ts";
import { realClock } from "./run.ts";

export type DorichatConfig = {
  /** File holding 도리방's bot token (outside the repo, 0600). */
  readonly tokenFile?: string;
  /** The owner's Telegram user id: only the owner's presses and text count. */
  readonly ownerId?: number;
  /** The private chat with the owner (the same number as ownerId for a private chat). */
  readonly chatId?: number;
  /** The argv the lead answers with, shown in the forwarded line (`… "<답>"`). */
  readonly replyArgv?: readonly string[];
};

const cfgOf = (config: DoriConfig): DorichatConfig => (config as { dorichat?: DorichatConfig }).dorichat ?? {};
export const dorichatBot = (config: DoriConfig): { tg: Telegram; cfg: DorichatConfig } | undefined => {
  const cfg = cfgOf(config);
  if (!cfg.tokenFile || !existsSync(cfg.tokenFile)) return undefined;
  return { tg: new Telegram(fetchHttp, realClock, readFileSync(cfg.tokenFile, "utf8").trim()), cfg };
};
