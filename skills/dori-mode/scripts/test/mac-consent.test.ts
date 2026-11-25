import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type DoriConfig, defaultConfig } from "../src/config.ts";
import {
  applyConsent,
  consentCallback,
  parseConsentPress,
  promptKey,
  readPrompt,
  recordDecision,
  scanConsent,
} from "../src/mac-consent.ts";
import type { Engine, Reply } from "../src/mac-engine.ts";
import { macDir } from "../src/mac-jobs.ts";

const PROMPT = [
  '- window "경고" [ref=e1] app=UserNotificationCenter (focused)',
  '  - statictext [ref=e3]: "‘Herdr Core.app’에서 ‘Finder.app’을(를) 제어하려고 합니다."',
  '  - button "도움말" [ref=e5]',
  '  - button "허용 안 함" [ref=e6]',
  '  - button "허용" [ref=e7]',
].join("\n");

const dirs: string[] = [];
const cfg = (): DoriConfig => {
  const d = mkdtempSync(join(tmpdir(), "mac-consent-"));
  dirs.push(d);
  return { ...defaultConfig(d), stateDir: d };
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const engine = (screen: { text: string; open: boolean }) => {
  const pressed: string[] = [];
  const e: Engine = {
    call: async (method: string, params: Record<string, unknown> = {}): Promise<Reply> => {
      if (method === "windows")
        return { result: screen.open ? [{ id: "569", app: "UserNotificationCenter", title: "", focused: true }] : [] };
      if (method === "ax.snapshot") return { result: { text: screen.open ? screen.text : "" } };
      if (method === "ax.perform") pressed.push(String(params["ref"]));
      return { result: {} };
    },
    close: async () => undefined,
  };
  return { e, pressed };
};

test("a prompt is read as its words and its choices, Help left out", () => {
  const v = readPrompt(PROMPT);
  expect(v.buttons).toEqual(["허용 안 함", "허용"]);
  expect(v.text).toContain("Finder.app");
  expect(promptKey("569", v)).toBe(promptKey("569", readPrompt(PROMPT)));
  expect(parseConsentPress(consentCallback("mabc", 1))).toEqual({ id: "mabc", n: 1 });
  expect(parseConsentPress("perm:a b:1")).toBeUndefined();
});

test("each new prompt is asked once; the owner's press is pressed while the same prompt shows", async () => {
  const c = cfg();
  const screen = { text: PROMPT, open: true };
  const { e, pressed } = engine(screen);
  expect(await scanConsent(e, c)).toBe(1);
  expect(await scanConsent(e, c)).toBe(0);
  const id = (readdirSync(macDir(c, "consent")).find((f) => f.endsWith(".json")) ?? "").replace(/\.json$/, "");
  expect(recordDecision(c, id, 0)).toBe(true);
  expect(await applyConsent(e, c)).toBe(1);
  expect(pressed).toEqual(["e6"]);
  expect(recordDecision(c, id, 1)).toBe(false);
});

test("a prompt that changed or closed before the press is left alone", async () => {
  const c = cfg();
  const screen = { text: PROMPT, open: true };
  const { e, pressed } = engine(screen);
  await scanConsent(e, c);
  const id = (readdirSync(macDir(c, "consent")).find((f) => f.endsWith(".json")) ?? "").replace(/\.json$/, "");
  recordDecision(c, id, 1);
  screen.text = PROMPT.replace("Finder.app", "Terminal.app");
  expect(await applyConsent(e, c)).toBe(0);
  expect(pressed).toEqual([]);
  screen.open = false;
  await scanConsent(e, c);
  expect(readdirSync(macDir(c, "consent"))).toEqual([]);
});
