import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const SKIP = new Set(["node_modules", ".git", "test", "dist"]);
const DOC_FILE = /\.(md|ts)$/;

function* docs(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* docs(path);
    else if (DOC_FILE.test(name) && !name.endsWith(".test.ts")) yield path;
  }
}

const OLD_RULE = [
  /one binary on PATH/i,
  /the one of the two on PATH/i,
  /Both binaries or neither/i,
  /refuses when both or neither/i,
  /both herdr and hc are on PATH/i,
  /the one of [`'"]?herdr[`'"]? and [`'"]?hc[`'"]? on PATH/i,
  /PATH 上仅有/,
  /两个都在或都不在/,
  /das eine Programm auf dem PATH/,
  /Beide oder keines/,
  /l'unico binario nel PATH/,
  /Entrambi o nessuno/,
  /PATH にある方のひとつ/,
  /両方ある、またはどちらもない/,
];

describe("runtime default wording", () => {
  test("no doc, prompt, skill reference or source comment still describes the old both-on-PATH refusal", () => {
    const hits: string[] = [];
    for (const path of docs(ROOT)) {
      const text = readFileSync(path, "utf8");
      for (const pattern of OLD_RULE) if (pattern.test(text)) hits.push(`${path.slice(ROOT.length + 1)}: ${pattern}`);
    }
    expect(hits).toEqual([]);
  });
});
