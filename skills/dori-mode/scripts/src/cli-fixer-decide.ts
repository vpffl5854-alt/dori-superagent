/** The morning half of the nightly fixer: the results waiting for the owner, their buttons, and what a press does. */
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { DoriConfig } from "./config.ts";
import { dorichatBot } from "./dorichat-bot.ts";
import { FIX_PREFIX, type FixResult, fixAction, fixButtons, fixLine, parseResult } from "./fixer.ts";
import { cfgOf, harnessOf, resultPath } from "./fixer-places.ts";
import { run } from "./run.ts";

/** The fix lanes' results still waiting for the owner. */
export const pendingFixes = (config: DoriConfig): { key: string; result: FixResult }[] => {
  const { dir } = cfgOf(config);
  return (existsSync(dir) ? readdirSync(dir) : [])
    .filter((f) => f.startsWith(FIX_PREFIX) && f.endsWith(".json") && !f.endsWith(".done.json"))
    .flatMap((f) => {
      const result = parseResult(readFileSync(join(dir, f), "utf8"));
      return result ? [{ key: basename(f, ".json"), result }] : [];
    });
};

/** 합치기 / PR 올리기 (go) or 버리기 (drop): what the owner's press does; the answer is the line to show them. */
export const decideFix = async (
  config: DoriConfig,
  key: string,
  go: boolean,
): Promise<{ done: boolean; line: string }> => {
  const c = cfgOf(config);
  const path = resultPath(c.dir, key);
  const r = parseResult(existsSync(path) ? readFileSync(path, "utf8") : "");
  if (!r) return { done: true, line: `${key}: 결과가 없거나 이미 정했어요` };
  const not = (line: string) => ({ done: false, line });
  const a = fixAction(r);
  const h = harnessOf(config);
  const pr = r.pr ? /\/pull\/(\d+)$/.exec(r.pr)?.[1] : undefined;
  let line: string;
  if (go && a === "merge" && pr) {
    const checks = await run(["gh", "pr", "checks", pr, "--repo", c.repo], { timeoutMs: 60_000 });
    if (checks.code !== 0)
      return not(`${key}: PR 검사가 아직 초록이 아니에요. 나중에 다시 눌러 주세요\n${checks.out.trim().slice(0, 300)}`);
    const m = await run(["gh", "pr", "merge", pr, "--repo", c.repo, "--merge", "--delete-branch"], {
      timeoutMs: 120_000,
    });
    if (m.code !== 0) return not(`${key}: 합치기 실패 — ${(m.err || m.out).trim().slice(0, 200)}`);
    const pull = await run(["git", "-C", c.live, "pull", "--ff-only", c.remote, c.branch], { timeoutMs: 120_000 });
    line =
      pull.code === 0
        ? `${key}: 합쳤고 맥 작업 폴더에도 받았어요 ${r.pr}`
        : `${key}: 합쳤지만 맥 작업 폴더로는 못 받았어요(리드가 받게 할게요) ${r.pr}`;
    if (pull.code !== 0)
      await run([
        ...h,
        "send",
        "lead",
        "--text",
        `[밤 점검] ${r.pr} 합쳐짐. ${c.live}에 pull --ff-only 실패: 받아 줘.`,
      ]);
  } else if (go && a === "open" && r.repo && r.head && r.title && r.bodyFile) {
    const o = await run(
      ["gh", "pr", "create", "--repo", r.repo, "--head", r.head, "--title", r.title, "--body-file", r.bodyFile],
      { timeoutMs: 120_000 },
    );
    if (o.code !== 0) return not(`${key}: PR 올리기 실패 — ${(o.err || o.out).trim().slice(0, 200)}`);
    line = `${key}: PR 올렸어요 ${o.out.trim().split("\n").at(-1)}`;
  } else {
    if (pr) await run(["gh", "pr", "close", pr, "--repo", c.repo, "--delete-branch"], { timeoutMs: 120_000 });
    line = `${key}: ${a ? "버렸어요" : "확인했어요"}`;
  }
  await run([...h, "done", key], { timeoutMs: 60_000 });
  const wt = join(c.home, "worktrees", key);
  if (existsSync(wt)) await run(["git", "-C", c.live, "worktree", "remove", "--force", wt], { timeoutMs: 60_000 });
  writeFileSync(join(c.dir, `${key}.done.json`), JSON.stringify({ ...r, decided: go ? "go" : "drop", line }));
  rmSync(path, { force: true });
  return { done: true, line };
};

/** One 도리방 message per waiting result, with its buttons (fixer.ts fixButtons). */
export const sendFixes = async (config: DoriConfig): Promise<number> => {
  const bot = dorichatBot(config);
  const pending = pendingFixes(config);
  if (!bot?.cfg.chatId) return 0;
  for (const p of pending)
    await bot.tg.call("sendMessage", {
      chat_id: bot.cfg.chatId,
      text: `[어젯밤 고친 것] ${fixLine(p.key, p.result)}`,
      reply_markup: { inline_keyboard: [fixButtons(p.key, p.result)] },
    });
  return pending.length;
};
