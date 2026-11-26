/** dori dorichat: 도리방's listener (button presses and the owner's text) and the approval buttons the briefing sends. */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Command, die } from "./cli-context.ts";
import { appendDecision } from "./cli-decisions.ts";
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
import { rememberText } from "./decisions.ts";
import { parseMacPress, stopWord } from "./mac.ts";
import { macGoal } from "./mac-brain.ts";
import { parseConsentPress, recordDecision } from "./mac-consent.ts";
import { decidePending, enqueue, newId, stopPath } from "./mac-jobs.ts";
import { type DorichatConfig, dorichatBot } from "./dorichat-bot.ts";
import type { Telegram } from "./messenger/telegram.ts";
import { decideFix } from "./cli-fixer-decide.ts";
import { parseFixPress } from "./fixer.ts";
import { run } from "./run.ts";

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

const harnessOf = (config: DoriConfig): readonly string[] =>
  (config as { incidents?: { harness?: readonly string[] } }).incidents?.harness ??
  die("no incidents.harness to reach the lead");

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
    const cp = parseConsentPress(cq.data);
    if (cp) {
      const ok = recordDecision(config, cp.id, cp.n);
      const label = cq.message?.reply_markup?.inline_keyboard?.[0]?.[cp.n]?.text ?? "";
      await tg.call("answerCallbackQuery", {
        callback_query_id: cq.id,
        text: ok ? `맥손이 "${label}"을(를) 누를게요` : "그 창은 이미 닫혔어요",
      });
      if (cq.message)
        await tg.call("editMessageReplyMarkup", {
          chat_id: cq.message.chat.id,
          message_id: cq.message.message_id,
          reply_markup: { inline_keyboard: [] },
        });
      return void console.log(`DORICHAT_CONSENT ${cp.id} ${cp.n} ok=${ok}`);
    }
    const fp = parseFixPress(cq.data);
    if (fp) {
      await tg.call("answerCallbackQuery", {
        callback_query_id: cq.id,
        text: fp.action === "go" ? "처리 중이에요" : "정리할게요",
      });
      const r = await decideFix(config, fp.key, fp.action === "go");
      if (r.done && cq.message)
        await tg.call("editMessageReplyMarkup", {
          chat_id: cq.message.chat.id,
          message_id: cq.message.message_id,
          reply_markup: { inline_keyboard: [] },
        });
      console.log(`DORICHAT_FIX ${fp.action} ${fp.key} done=${r.done}`);
      return void (await tg.send({ chatId: cq.message?.chat.id ?? cfg.chatId ?? 0 }, r.line));
    }
    const mp = parseMacPress(cq.data);
    if (mp) {
      const ok = decidePending(config, mp.id, mp.action === "go");
      const text = !ok
        ? `${mp.id}: 이미 처리했어요`
        : mp.action === "go"
          ? `${mp.id}: 진행 — 맥손이 할게요`
          : `${mp.id}: 버렸어요`;
      await tg.call("answerCallbackQuery", { callback_query_id: cq.id, text });
      if (cq.message)
        await tg.call("editMessageReplyMarkup", {
          chat_id: cq.message.chat.id,
          message_id: cq.message.message_id,
          reply_markup: { inline_keyboard: [] },
        });
      return void console.log(`DORICHAT_MAC ${mp.action} ${mp.id} ok=${ok}`);
    }
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
  const sw = stopWord(m.text);
  if (sw === "stop") writeFileSync(stopPath(config), new Date().toISOString());
  if (sw === "resume") rmSync(stopPath(config), { force: true });
  if (sw)
    await tg.send(
      { chatId: m.chat.id },
      sw === "stop" ? '맥 조작을 멈췄어요. 다시 하려면 "재개"' : "맥 조작을 다시 할 수 있어요",
    );
  const goal = macGoal(m.text);
  if (goal) {
    const id = newId();
    enqueue(config, { id, goal, send: true });
    console.log(`DORICHAT_MAC_DO ${id}`);
    return void (await tg.send({ chatId: m.chat.id }, `맥손에게 넘겼어요 (${id}). 끝나면 사진과 함께 알려 드릴게요`));
  }
  const remember = rememberText(m.text);
  if (remember) {
    appendDecision(config, remember, "도리방");
    console.log("DORICHAT_DECIDED");
    return void (await tg.send({ chatId: m.chat.id }, `기억했어요: ${remember}\n(모든 판이 일하기 전에 읽어요)`));
  }
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
