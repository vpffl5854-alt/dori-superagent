import { expect, test } from "bun:test";

import { dueIncidents, incidentKey, issueBody, redact, scanText, signature } from "../src/incidents.ts";

const empty = { offsets: {}, seen: {} };

test("a signature drops times, ids and numbers so the same fault reads the same every time", () => {
  const a = signature("[2026-11-22T10:00:01Z] ENOENT: open '/x/lock.f63d6540-0f37-48b8-b5c7-75c27dbd1171' pid=4321");
  const b = signature("[2026-11-23T11:59:59Z] ENOENT: open '/x/lock.0a1b2c3d-0f37-48b8-b5c7-75c27dbd9999' pid=77");
  expect(a).toBe(b);
  expect(a).toBe("ENOENT: open '/x/lock.<id>' pid <n>");
});

test("faults are counted; normal chatter, quoted chat messages and network blips are not", () => {
  const log = [
    "discord gateway: gateway asked to reconnect",
    'INBOUND discord guild 1 2 3 [수신 | a] "error 났어요"',
    "TypeError: getaddrinfo ENOTFOUND discord.com",
    '{"error":{"kind":"name_taken","message":"a live terminal is already named x"}}',
    '{"error":{"kind":"name_taken","message":"a live terminal is already named x"}}',
    "all good",
  ].join("\n");
  const s = scanText(empty, "a.err.log", log, "t1");
  expect(Object.values(s.seen).map((v) => v.count)).toEqual([2]);
});

test("a fault becomes an incident at the threshold, and never twice once it has an issue", () => {
  let s = scanText(empty, "f.log", "Error: boom\nError: boom", "t1");
  expect(dueIncidents(s, 3)).toEqual([]);
  s = scanText(s, "f.log", "Error: boom", "t2");
  expect(dueIncidents(s, 3)).toEqual(["Error: boom"]);
  expect(s.seen["Error: boom"]).toMatchObject({ count: 3, firstAt: "t1", lastAt: "t2" });
  s = { ...s, seen: { ...s.seen, "Error: boom": { ...s.seen["Error: boom"]!, issue: "https://x/1" } } };
  expect(dueIncidents(s, 3)).toEqual([]);
});

test("secrets never reach an issue", () => {
  expect(redact("Authorization: Bearer abc.def token=sk_live_123 ok")).toBe(
    "Authorization: Bearer [redacted] token=[redacted] ok",
  );
  expect(redact(`x ${"a".repeat(45)} y`)).toBe("x [redacted] y");
});

test("the issue names the log, the count and what the fixing lane should do; the key is stable", () => {
  const body = issueBody("Error: boom", {
    count: 5,
    firstAt: "t1",
    lastAt: "t2",
    file: "f.log",
    sample: "Error: boom",
  });
  expect(body).toContain("`f.log`");
  expect(body).toContain("5회");
  expect(body).toContain("bun run ci");
  expect(incidentKey("Error: boom")).toMatch(/^incident-[0-9a-f]{8}$/);
  expect(incidentKey("Error: boom")).toBe(incidentKey("Error: boom"));
});
