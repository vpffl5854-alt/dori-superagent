/**
 * macOS permission prompts ("Herdr Core.app에서 Finder.app을(를) 제어하려고 합니다") handed to the owner's phone.
 * 맥손 watches for them; a new one goes to 도리방 as a photo with its text and one button per choice. The owner's
 * press is pressed on the Mac by 맥손, and only if the same prompt is still there: a prompt that changed or closed is
 * left alone. Nothing here ever answers a prompt by itself (see isConsentApp in mac.ts).
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { DoriConfig } from "./config.ts";
import { dorichatBot } from "./dorichat-bot.ts";
import type { Win } from "./mac.ts";
import type { Engine } from "./mac-engine.ts";
import { macDir, newId } from "./mac-jobs.ts";

/** Windows that are prompts (not System Settings itself, a normal window the owner works in). */
const PROMPT_APPS = /usernotificationcenter|securityagent|coreservicesuiagent|coreauth/i;
const SKIP_BUTTON = /^(도움말|help)$/i;

export type PromptView = { readonly text: string; readonly buttons: readonly string[] };
type Saved = {
  readonly id: string;
  readonly windowId: string;
  readonly app: string;
  readonly key: string;
  readonly buttons: readonly string[];
};

/** The prompt's words and its choice buttons from its accessibility snapshot. */
export const readPrompt = (snapshot: string): PromptView => ({
  text: [...snapshot.matchAll(/- statictext[^\n]*?: "([^"\n]+)"/g)].map((m) => m[1] ?? "").join("\n"),
  buttons: [...snapshot.matchAll(/- button "([^"\n]+)" \[ref=e\d+\]/g)]
    .map((m) => m[1] ?? "")
    .filter((b) => b && !SKIP_BUTTON.test(b)),
});

/** The same window showing the same words is the same prompt. */
export const promptKey = (windowId: string, v: PromptView): string =>
  createHash("sha256")
    .update(`${windowId}\n${v.text}\n${v.buttons.join("|")}`)
    .digest("hex")
    .slice(0, 16);

export const consentCallback = (id: string, n: number): string => `perm:${id}:${n}`;
export const parseConsentPress = (data: string | undefined): { id: string; n: number } | undefined => {
  const m = /^perm:([A-Za-z0-9]+):(\d{1,2})$/.exec(data ?? "");
  return m?.[1] && m[2] ? { id: m[1], n: Number(m[2]) } : undefined;
};

/** 도리방's press, written by the listener (launchd) for 맥손 (Herdr) to carry out. */
export const recordDecision = (config: DoriConfig, id: string, n: number): boolean => {
  if (!existsSync(macDir(config, "consent", `${id}.json`))) return false;
  writeFileSync(macDir(config, "consent", `${id}.decision`), String(n));
  return true;
};

const snapshotOf = async (e: Engine, id: string): Promise<string> =>
  ((await e.call("ax.snapshot", { target: id, opts: { all: true, maxNodes: 200 } })).result as { text?: string })
    ?.text ?? "";

/** New prompts on screen go to 도리방 once each. */
export const scanConsent = async (e: Engine, config: DoriConfig): Promise<number> => {
  const bot = dorichatBot(config);
  const chatId = bot?.cfg.chatId;
  const wins = (((await e.call("windows")).result as Win[] | undefined) ?? []).filter((w) => PROMPT_APPS.test(w.app));
  const saved = readdirSync(macDir(config, "consent"))
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(macDir(config, "consent", f), "utf8")) as Saved);
  // A prompt that has closed (the owner answered it at the Mac) is forgotten; a late press for it is refused.
  for (const p of saved)
    if (!wins.some((w) => w.id === p.windowId) && !existsSync(macDir(config, "consent", `${p.id}.decision`)))
      rmSync(macDir(config, "consent", `${p.id}.json`), { force: true });
  const seen = saved.map((p) => p.key);
  let sent = 0;
  for (const w of wins) {
    const v = readPrompt(await snapshotOf(e, w.id));
    const key = promptKey(w.id, v);
    if (!v.buttons.length || seen.includes(key)) continue;
    const id = newId();
    writeFileSync(
      macDir(config, "consent", `${id}.json`),
      JSON.stringify({ id, windowId: w.id, app: w.app, key, buttons: v.buttons }),
    );
    console.log(`MAC_CONSENT_ASKED ${id} ${w.app} ${v.buttons.join("|")}`);
    sent++;
    if (!bot || !chatId) continue;
    const shot = (await e.call("capture", { target: w.id, caps: { maxWidth: 800 } })).result as
      | { data?: string }
      | undefined;
    if (shot?.data)
      await bot.tg.sendPhoto(
        { chatId },
        new Uint8Array(Buffer.from(shot.data, "base64")),
        "prompt.png",
        "맥에 권한 창이 떴어요",
      );
    await bot.tg.call("sendMessage", {
      chat_id: chatId,
      text: `맥 권한 창 (${w.app})\n${v.text.slice(0, 600)}\n\n어떻게 할까요? 누르시면 맥손이 그대로 눌러요.`,
      reply_markup: {
        inline_keyboard: [v.buttons.map((b, n) => ({ text: b, callback_data: consentCallback(id, n) }))],
      },
    });
  }
  return sent;
};

/** The owner's presses, pressed on the Mac if the very same prompt is still showing; each answer goes back to 도리방. */
export const applyConsent = async (e: Engine, config: DoriConfig): Promise<number> => {
  const bot = dorichatBot(config);
  const tell = async (t: string) =>
    bot?.cfg.chatId ? void (await bot.tg.send({ chatId: bot.cfg.chatId }, t)) : undefined;
  let done = 0;
  for (const f of readdirSync(macDir(config, "consent")).filter((x) => x.endsWith(".decision"))) {
    const id = f.replace(/\.decision$/, "");
    const n = Number(readFileSync(macDir(config, "consent", f), "utf8"));
    rmSync(macDir(config, "consent", f), { force: true });
    const path = macDir(config, "consent", `${id}.json`);
    if (!existsSync(path)) continue;
    const p = JSON.parse(readFileSync(path, "utf8")) as Saved;
    rmSync(path, { force: true });
    const name = p.buttons[n];
    const snap = await snapshotOf(e, p.windowId);
    const ref = name
      ? new RegExp(`- button "${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}" \\[ref=(e\\d+)\\]`).exec(snap)?.[1]
      : undefined;
    if (!snap || promptKey(p.windowId, readPrompt(snap)) !== p.key || !ref) {
      await tell(`권한 창이 이미 닫혔거나 바뀌어서 안 눌렀어요 (${name ?? "?"})`);
      continue;
    }
    const r = await e.call("ax.perform", { ref, action: "AXPress" });
    console.log(`MAC_CONSENT_PRESSED ${id} ${name} ok=${!r.error}`);
    await tell(r.error ? `"${name}"을(를) 못 눌렀어요: ${r.error.message}` : `맥 권한 창에서 "${name}"을(를) 눌렀어요`);
    done++;
  }
  return done;
};
