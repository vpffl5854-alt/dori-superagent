import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { askOmoProvider, askRef } from "../src/omo-provider.ts";

/** A home with one OmO provider "p", so the ask reaches the stubbed fetch instead of a real endpoint. */
const home = (): string => {
  const h = mkdtempSync(join(tmpdir(), "omo-provider-"));
  mkdirSync(join(h, ".omo", "agent"), { recursive: true });
  writeFileSync(
    join(h, ".omo", "agent", "models.json"),
    JSON.stringify({ providers: { p: { baseUrl: "https://p.test/v1" } } }),
  );
  writeFileSync(join(h, ".omo", "agent", "auth.json"), JSON.stringify({ p: { key: "k" } }));
  return h;
};

/** Answer every request with this response, and give back the undo. */
const answering = (status: number, body: unknown): (() => void) => {
  const real = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = real;
  };
};

test("a reasoning model that fills the whole budget is named as that, not as an empty answer", async () => {
  const restore = answering(200, { choices: [{ message: { content: "" }, finish_reason: "length" }] });
  try {
    expect(await askOmoProvider("p", "m", "q", 1_000, 800, home())).toEqual({
      error: "p spent all 800 tokens thinking and answered with nothing",
    });
  } finally {
    restore();
  }
});

test("a refused ask keeps the provider's own message, and askRef hands it to the caller", async () => {
  const restore = answering(429, { status_code: 429, message: "Too Many Requests" });
  try {
    expect(await askRef("p/m", "q", 1_000, 100, home())).toEqual({ error: "p answered 429: Too Many Requests" });
  } finally {
    restore();
  }
});
