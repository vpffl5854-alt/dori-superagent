/** dori dorichat: 도리방's listener (button presses and the owner's text) and the approval buttons the briefing sends. */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Command, die } from "./cli-context.ts";
import type { DoriConfig } from "./config.ts";
import {
  type Approval,
  approvalKeyboard,
  forwardText,
  leadText,
  parsePress,
  type Press,
  pressAnswer,
} from "./dorichat.ts";
import { fetchHttp } from "./messenger/http.ts";
import { Telegram } from "./messenger/telegram.ts";
import { realClock, run } from "./run.ts";

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

type Update = {
  update_id: number;
  message?: { chat: { id: number }; from?: { id: number }; text?: string };
  callback_query?: {
    id: string;
    from: { id: number };
    data?: string;
    message?: { chat: { id: number }; message_id: number; reply_markup?: ReturnType<typeof approvalKeyboard> };
  };
};

const cfgOf = (config: DoriConfig): DorichatConfig => (config as { dorichat?: DorichatConfig }).dorichat ?? {};
const harnessOf = (config: DoriConfig): readonly string[] =>
  (config as { incidents?: { harness?: readonly string[] } }).incidents?.harness ??
  die("no incidents.harness to reach the lead");

export const dorichatBot = (config: DoriConfig): { tg: Telegram; cfg: DorichatConfig } | undefined => {
  const cfg = cfgOf(config);
  if (!cfg.tokenFile || !existsSync(cfg.tokenFile)) return undefined;
  return { tg: new Telegram(fetchHttp, realClock, readFileSync(cfg.tokenFile, "utf8").trim()), cfg };
};

/** The briefing's approvals as one message with a row of buttons per item. */
export const sendApprovals = async (config: DoriConfig, items: readonly Approval[]): Promise<boolean> => {
  const bot = dorichatBot(config);
  if (!bot?.cfg.chatId || items.length === 0) return false;
  await bot.tg.call("sendMessage", {
    chat_id: bot.cfg.chatId,
    text: "승인 기다리는 것 — 눌러서 정해 주세요",
    reply_markup: approvalKeyboard(items),
  });
  return true;
};

const decidedPath = (config: DoriConfig): string => join(config.stateDir, "dorichat-decided.json");
const readDecided = (config: DoriConfig): Record<string, string> => {
  try {
    return JSON.parse(readFileSync(decidedPath(config), "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
};
const writeDecided = (config: DoriConfig, d: Record<string, string>): void =>
  writeFileSync(decidedPath(config), JSON.stringify(d));

const act = async (config: DoriConfig, p: Press): Promise<boolean> => {
  const h = harnessOf(config);
  const lead = leadText(p);
  if (lead) return (await run([...h, "send", "lead", "--text", lead], { timeoutMs: 60_000 })).code === 0;
  if (p.action === "drop")
    return (
      (await run([...h, "backlog", "drop", p.id, "--text", "도리방 버튼으로 버림"], { timeoutMs: 60_000 })).code === 0
    );
  return true;
};

const handle = async (config: DoriConfig, tg: Telegram, cfg: DorichatConfig, u: Update): Promise<void> => {
  const cq = u.callback_query;
  if (cq) {
    if (cq.from.id !== cfg.ownerId)
      return void (await tg.call("answerCallbackQuery", { callback_query_id: cq.id, text: "주인만 누를 수 있어요" }));
    const p = parsePress(cq.data);
    if (!p) return void (await tg.call("answerCallbackQuery", { callback_query_id: cq.id }));
    // A second tap can land before the buttons are gone: an item already decided is not acted on again.
    const decided = readDecided(config);
    if (decided[p.id])
      return void (await tg.call("answerCallbackQuery", {
        callback_query_id: cq.id,
        text: `${p.id}: 이미 처리했어요 (${decided[p.id]})`,
      }));
    const ok = await act(config, p);
    if (ok) writeDecided(config, { ...decided, [p.id]: p.action });
    await tg.call("answerCallbackQuery", { callback_query_id: cq.id, text: pressAnswer(p, ok) });
    console.log(`DORICHAT_PRESS ${p.action} ${p.id} ok=${ok}`);
    if (!ok || !cq.message) return;
    // The decided item's row goes away, so the same yes cannot be given twice.
    const rows = (cq.message.reply_markup?.inline_keyboard ?? []).filter(
      (r) => !r.some((b) => b.callback_data.endsWith(`:${p.id}`)),
    );
    await tg.call("editMessageReplyMarkup", {
      chat_id: cq.message.chat.id,
      message_id: cq.message.message_id,
      reply_markup: { inline_keyboard: rows },
    });
    await tg.send({ chatId: cq.message.chat.id }, pressAnswer(p, ok));
    return;
  }
  const m = u.message;
  if (!m?.text || m.from?.id !== cfg.ownerId) return;
  if (m.text.trim() === "/start") return;
  const r = await run([...harnessOf(config), "send", "lead", "--text", forwardText(m.text, cfg.replyArgv ?? [])], {
    timeoutMs: 60_000,
  });
  console.log(`DORICHAT_TEXT forwarded exit=${r.code}`);
  await tg.send(
    { chatId: m.chat.id },
    r.code === 0 ? "리드에게 넘겼어요" : "리드에게 못 넘겼어요. 잠시 뒤 다시 보내 주세요",
  );
};

const dorichat: Command = async ({ config }) => {
  const bot = dorichatBot(config) ?? die("no dorichat.tokenFile, or the file is missing");
  if (!bot.cfg.ownerId) die("no dorichat.ownerId");
  const offsetPath = join(config.stateDir, "dorichat-offset");
  let offset = existsSync(offsetPath) ? Number(readFileSync(offsetPath, "utf8")) || 0 : 0;
  console.log("DORICHAT_READY");
  for (;;) {
    try {
      const updates = await bot.tg.call<Update[]>("getUpdates", {
        offset,
        timeout: 25,
        allowed_updates: ["message", "callback_query"],
      });
      for (const u of updates) {
        // The offset moves before the update is handled: getUpdates never hands it out twice, so a crash loses one
        // press rather than repeating it (a repeated 진행 would start the work twice).
        offset = u.update_id + 1;
        writeFileSync(offsetPath, String(offset));
        await handle(config, bot.tg, bot.cfg, u).catch((e) => console.log(`DORICHAT_ERROR ${String(e).slice(0, 200)}`));
      }
    } catch (e) {
      console.log(`DORICHAT_POLL_ERROR ${String(e).slice(0, 200)}`);
      await Bun.sleep(5_000);
    }
  }
};

export const dorichatCommands: Readonly<Record<string, Command>> = { dorichat };
