import { appendFileSync } from "node:fs";

// Preloaded into a CLI process by send-cli.test.ts: every request is appended to $DORI_TEST_FETCH_LOG and answered
// the way Telegram answers a successful call, so no request leaves the machine.
const log = process.env["DORI_TEST_FETCH_LOG"] ?? "";
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  appendFileSync(
    log,
    `${JSON.stringify({ url: String(input), body: typeof init?.body === "string" ? JSON.parse(init.body) : null })}\n`,
  );
  return new Response(JSON.stringify({ ok: true, result: { message_id: 99 } }), { status: 200 });
}) as typeof fetch;
