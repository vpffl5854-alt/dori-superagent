/** dori sns scrape | run | heal: public-profile scrapers for YouTube, Instagram, Threads and TikTok, self-healing. */
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Browser, chromium } from "playwright-core";
import { type Command, die } from "./cli-context.ts";
import { fill } from "./config.ts";
import { run } from "./run.ts";
import {
  CANARIES,
  checkField,
  errorLine,
  loadRules,
  parseErrors,
  parseTarget,
  profileUrl,
  SELECTORS_PATH,
  type SnsConfig,
  saveRules,
  toRepair,
  withSelector,
} from "./sns.ts";
import { analyzeDom, openPage, readField } from "./sns-browser.ts";
import { deploy, type HealState, healField, mayAttempt, noteAttempt } from "./sns-heal.ts";

const notify = async (cfg: SnsConfig, text: string) => {
  if (cfg.notifyArgv?.length) await run(fill(cfg.notifyArgv, { text }), { timeoutMs: 60_000 });
};

/** Scrapes one profile; every unhealthy field is appended to the error log the healer reads. */
const scrape = async (browser: Browser, dir: string, platform: string, handle: string): Promise<boolean> => {
  const rule = loadRules()[platform] ?? die(`no rules for ${platform}`);
  const page = await openPage(browser, profileUrl(rule, handle)).catch(() => null);
  const result: Record<string, readonly string[]> = {};
  let healthy = true;
  for (const [field, f] of Object.entries(rule.fields)) {
    const check = page
      ? checkField(f, await readField(page, f.selector, f.attr))
      : { ok: false, values: [], matched: 0, reason: "page did not open" };
    result[field] = check.values;
    console.log(
      `${check.ok ? "SNS_OK" : "SNS_BROKEN"} ${platform}:${handle} ${field} ${check.ok ? check.values.length : check.reason}`,
    );
    if (check.ok) continue;
    healthy = false;
    const e = {
      at: new Date().toISOString(),
      platform,
      handle,
      field,
      selector: f.selector,
      reason: check.reason ?? "",
    };
    appendFileSync(join(dir, "errors.jsonl"), errorLine(e));
  }
  await page?.close();
  mkdirSync(join(dir, "latest"), { recursive: true });
  writeFileSync(
    join(dir, "latest", `${platform}-${handle}.json`),
    JSON.stringify({ at: new Date().toISOString(), ...result }, null, 2),
  );
  return healthy;
};

/** Reads the error log past the last offset, repairs each broken platform field once, and deploys what it healed. */
const heal = async (browser: Browser, dir: string, cfg: SnsConfig) => {
  const log = join(dir, "errors.jsonl");
  const offsetPath = join(dir, "heal-offset");
  if (!existsSync(log)) return void console.log("SNS_HEAL_NOTHING");
  const offset = existsSync(offsetPath) ? Number(readFileSync(offsetPath, "utf8")) || 0 : 0;
  const size = statSync(log).size;
  const fresh = readFileSync(log).subarray(Math.min(offset, size)).toString("utf8");
  writeFileSync(offsetPath, String(size));
  const statePath = join(dir, "heal-state.json");
  let state: HealState = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {};
  const day = new Date().toISOString().slice(0, 10);
  const repairs = toRepair(parseErrors(fresh));
  if (repairs.length === 0) return void console.log("SNS_HEAL_NOTHING");
  for (const e of repairs) {
    const key = `${e.platform}.${e.field}`;
    if (!mayAttempt(state, key, day)) {
      console.log(`SNS_HEAL_SKIPPED ${key} tried twice today`);
      continue;
    }
    state = noteAttempt(state, key, day);
    writeFileSync(statePath, JSON.stringify(state, null, 2));
    const rules = loadRules();
    const rule = rules[e.platform]?.fields[e.field];
    if (!rule) continue;
    const page = await openPage(browser, profileUrl(rules[e.platform]!, e.handle)).catch(() => null);
    if (!page) {
      console.log(`SNS_HEAL_FAILED ${key} page did not open`);
      continue;
    }
    const ask = async (prompt: string) => {
      if (!cfg.omo || !cfg.model) return null;
      const r = await run([cfg.omo, "--model", cfg.model, "-p", prompt], { timeoutMs: 180_000 });
      return r.code === 0 ? r.out : null;
    };
    const pairRule = rule.pair ? rules[e.platform]?.fields[rule.pair] : undefined;
    const pairCount = pairRule
      ? checkField(pairRule, await readField(page, pairRule.selector, pairRule.attr)).values.length
      : undefined;
    const { picked, report } = await healField(e.platform, e.field, rule, {
      analyze: () => analyzeDom(page, rule),
      read: (s) => readField(page, s, rule.attr),
      ask,
      ...(pairCount !== undefined ? { pairCount } : {}),
    });
    await page.close();
    if (!picked) {
      console.log(`SNS_HEAL_FAILED ${key} ${report.matching} matching elements, no candidate passed`);
      await notify(cfg, `[SNS] ${key} 셀렉터가 깨졌는데 자동 수리 실패 (맞는 요소 ${report.matching}개). 확인 필요.`);
      continue;
    }
    saveRules(withSelector(rules, e.platform, e.field, picked.selector));
    const deployed = cfg.deploy
      ? await deploy(
          run,
          dirname(SELECTORS_PATH),
          SELECTORS_PATH,
          `fix(sns): heal ${key} selector\n\n${rule.selector} -> ${picked.selector} (${picked.source}, ${picked.check.matched} values)`,
          cfg.push ?? null,
        )
      : "written, not deployed";
    console.log(
      `SNS_HEALED ${key} ${JSON.stringify(rule.selector)} -> ${JSON.stringify(picked.selector)} source=${picked.source} values=${picked.check.matched} ${deployed}`,
    );
    await notify(
      cfg,
      `[SNS] ${key} 셀렉터 자동 수리: ${rule.selector} → ${picked.selector} (${picked.check.matched}개 확인, ${deployed})`,
    );
  }
};

const sns: Command = async ({ positionals, values, config }) => {
  const cfg = config.sns ?? {};
  const dir = join(config.stateDir, "sns");
  mkdirSync(dir, { recursive: true });
  const sub = positionals[0];
  const browser = await chromium.launch({ headless: true });
  try {
    if (sub === "scrape") {
      const [, platform = die("scrape needs a platform"), handle = die("scrape needs a handle")] = positionals;
      return void (await scrape(browser, dir, platform, handle));
    }
    if (sub === "run") {
      for (const t of cfg.targets ?? CANARIES) {
        const target = parseTarget(t);
        if (target) await scrape(browser, dir, target.platform, target.handle);
        else console.log(`SNS_BAD_TARGET ${t}`);
      }
      if (values["heal"] === true) await heal(browser, dir, cfg);
      return;
    }
    if (sub === "heal") return await heal(browser, dir, cfg);
    die("sns needs scrape, run or heal");
  } finally {
    await browser.close();
  }
};

export const snsCommands: Readonly<Record<string, Command>> = { sns };
