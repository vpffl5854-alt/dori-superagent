import { expect, test } from "bun:test";

import { aggregate, type Call, cheapestReliable, parseSession, renderReport } from "../src/cost-report.ts";

const assistant = (ts: string, extra: Record<string, unknown>) =>
  JSON.stringify({
    type: "message",
    timestamp: ts,
    message: {
      role: "assistant",
      provider: "p",
      model: "m",
      usage: { input: 100, output: 10, cacheRead: 900, cost: { total: 0.5 } },
      stopReason: "stop",
      ...extra,
    },
  });

test("a session log becomes one call per assistant message, with cached prompt tokens counted as input", () => {
  const text = [
    JSON.stringify({ type: "session", id: "s" }),
    JSON.stringify({ type: "message", timestamp: "2026-11-01T00:00:00Z", message: { role: "user", content: [] } }),
    assistant("2026-11-01T00:00:01Z", {}),
    assistant("2026-11-01T00:00:02Z", {
      stopReason: "error",
      usage: { input: 0, costUnknown: true },
      providerDiagnostic: { httpStatus: 429 },
    }),
    "not json",
    assistant("2026-10-31T23:59:59Z", { stopReason: "aborted", providerDiagnostic: { category: "x" } }),
  ].join("\n");
  expect(parseSession("s", text)).toEqual([
    {
      session: "s",
      month: "2026-11",
      model: "p/m",
      input: 1000,
      output: 10,
      cost: 0.5,
      costKnown: true,
      outcome: "ok",
    },
    {
      session: "s",
      month: "2026-11",
      model: "p/m",
      input: 0,
      output: 0,
      cost: 0,
      costKnown: false,
      outcome: "error",
      errorKind: "429",
    },
    {
      session: "s",
      month: "2026-10",
      model: "p/m",
      input: 1000,
      output: 10,
      cost: 0.5,
      costKnown: true,
      outcome: "aborted",
    },
  ]);
});

const call = (session: string, model: string, outcome: Call["outcome"], cost = 0.1, costKnown = true): Call => ({
  session,
  month: "2026-11",
  model,
  input: 10,
  output: 1,
  cost,
  costKnown,
  outcome,
  ...(outcome === "error" ? { errorKind: "429" } : {}),
});

test("an error the session called again after is a retry; the session's last error is not", () => {
  const [stats] = aggregate([call("a", "m", "error"), call("a", "m", "ok"), call("b", "m", "error")]);
  expect(stats).toMatchObject({ model: "m", calls: 3, errors: 2, retries: 1, errorKinds: { "429": 2 } });
});

test("an abort is the owner stopping a turn and does not lower the success rate", () => {
  const [stats] = aggregate([call("a", "m", "ok"), call("a", "m", "aborted"), call("a", "m", "error")]);
  expect(stats?.successRate).toBe(0.5);
  expect(stats?.aborted).toBe(1);
});

test("the pick is the cheapest per successful call among reliable models with known cost", () => {
  const many = (model: string, n: number, outcome: Call["outcome"], cost: number, known = true) =>
    Array.from({ length: n }, (_, i) => call(`${model}${i}`, model, outcome, cost, known));
  const stats = aggregate([
    ...many("pricey", 60, "ok", 1),
    ...many("cheap", 60, "ok", 0.1),
    ...many("flaky", 50, "ok", 0.01),
    ...many("flaky", 10, "error", 0),
    ...many("unknown", 60, "ok", 0, false),
    ...many("tiny", 5, "ok", 0),
  ]);
  expect(cheapestReliable(stats)?.model).toBe("cheap");
});

test("the report has one row per model and says when nothing can be recommended", () => {
  const report = renderReport("2026-11", aggregate([call("a", "m", "ok", 0.25)]));
  expect(report).toContain("# 모델 비용 보고서 2026-11");
  expect(report).toContain("| m | 1 | 10 | 0.25 | 0 | 0 | 100.0% | - |");
  expect(report).toContain("추천 없음");
});
