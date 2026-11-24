/** dori decide --text T [--source S] / dori decisions: append to and print the owner's decision ledger. */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Command, die } from "./cli-context.ts";
import type { DoriConfig } from "./config.ts";
import { decisionLine, LEDGER_HEAD } from "./decisions.ts";

export const ledgerPath = (config: DoriConfig): string => join(dirname(config.stateDir), "decisions.md");

export const appendDecision = (config: DoriConfig, text: string, source: string, now = new Date()): string => {
  const path = ledgerPath(config);
  if (!existsSync(path)) writeFileSync(path, LEDGER_HEAD);
  const line = decisionLine(now, text, source);
  appendFileSync(path, `${line}\n`);
  return line;
};

const decide: Command = async ({ opt, config }) => {
  const text = opt("text") ?? die("decide needs --text");
  console.log(`DECIDED ${appendDecision(config, text, opt("source") ?? "리드")}`);
};

const decisions: Command = async ({ config }) => {
  const path = ledgerPath(config);
  console.log(existsSync(path) ? readFileSync(path, "utf8") : "(아직 결정 없음)");
};

export const decisionsCommands: Readonly<Record<string, Command>> = { decide, decisions };
