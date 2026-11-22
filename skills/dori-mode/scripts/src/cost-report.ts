/**
 * The cost report: every model call the agent sessions made in one month, read from the omo session
 * logs (`sessionsDir/<cwd>/<session>.jsonl`, one assistant message per call with its provider, model,
 * token usage, cost and stop reason). Per model it gives calls, average input length, cost, failures,
 * retries (a failed call the session called again after) and success rate, then names the cheapest
 * model that is reliable enough. The pick is a recommendation; no lane's model is changed.
 */
export type Call = {
  readonly session: string;
  readonly month: string;
  readonly model: string;
  readonly input: number;
  readonly output: number;
  readonly cost: number;
  readonly costKnown: boolean;
  readonly outcome: "ok" | "error" | "aborted";
  readonly errorKind?: string;
};

type Usage = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: { total?: number };
  costUnknown?: boolean;
};
type Assistant = {
  role?: string;
  provider?: string;
  model?: string;
  usage?: Usage;
  stopReason?: string;
  providerDiagnostic?: { category?: string; httpStatus?: number };
};

/** One session file's calls; a line that is not JSON or not an assistant message is skipped. */
export const parseSession = (session: string, text: string): Call[] => {
  const out: Call[] = [];
  for (const line of text.split("\n")) {
    if (!line.includes('"assistant"')) continue;
    let o: { type?: string; timestamp?: string; message?: Assistant };
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const m = o.message;
    if (o.type !== "message" || m?.role !== "assistant" || typeof o.timestamp !== "string") continue;
    const outcome = m.stopReason === "error" ? "error" : m.stopReason === "aborted" ? "aborted" : "ok";
    const d = m.providerDiagnostic;
    out.push({
      session,
      month: o.timestamp.slice(0, 7),
      model: `${m.provider ?? "?"}/${m.model ?? "?"}`,
      // The prompt the model read: fresh input plus what came from or went into the prompt cache.
      input: (m.usage?.input ?? 0) + (m.usage?.cacheRead ?? 0) + (m.usage?.cacheWrite ?? 0),
      output: m.usage?.output ?? 0,
      cost: m.usage?.cost?.total ?? 0,
      costKnown: m.usage?.costUnknown !== true,
      outcome,
      ...(outcome === "error" ? { errorKind: d?.httpStatus ? String(d.httpStatus) : (d?.category ?? "unknown") } : {}),
    });
  }
  return out;
};

export type ModelStats = {
  readonly model: string;
  readonly calls: number;
  readonly avgInput: number;
  readonly output: number;
  readonly cost: number;
  readonly costUnknown: number;
  readonly errors: number;
  readonly aborted: number;
  readonly retries: number;
  /** ok / (ok + error); an abort is the owner stopping the turn, not the model failing. */
  readonly successRate: number;
  readonly errorKinds: Readonly<Record<string, number>>;
};

export const aggregate = (calls: readonly Call[]): ModelStats[] => {
  const retried = new Set<Call>();
  const bySession = new Map<string, Call[]>();
  for (const c of calls) bySession.set(c.session, [...(bySession.get(c.session) ?? []), c]);
  for (const list of bySession.values())
    list.forEach((c, i) => {
      if (c.outcome === "error" && i < list.length - 1) retried.add(c);
    });
  const groups = new Map<string, Call[]>();
  for (const c of calls) groups.set(c.model, [...(groups.get(c.model) ?? []), c]);
  return [...groups.entries()]
    .map(([model, list]) => {
      const ok = list.filter((c) => c.outcome === "ok").length;
      const errors = list.filter((c) => c.outcome === "error");
      const errorKinds: Record<string, number> = {};
      for (const e of errors) errorKinds[e.errorKind ?? "unknown"] = (errorKinds[e.errorKind ?? "unknown"] ?? 0) + 1;
      return {
        model,
        calls: list.length,
        avgInput: Math.round(list.reduce((s, c) => s + c.input, 0) / list.length),
        output: list.reduce((s, c) => s + c.output, 0),
        cost: list.reduce((s, c) => s + c.cost, 0),
        costUnknown: list.filter((c) => !c.costKnown).length,
        errors: errors.length,
        aborted: list.length - ok - errors.length,
        retries: errors.filter((c) => retried.has(c)).length,
        successRate: ok + errors.length === 0 ? 0 : ok / (ok + errors.length),
        errorKinds,
      };
    })
    .sort((a, b) => b.calls - a.calls);
};

export const MIN_CALLS = 50;
export const MIN_SUCCESS = 0.95;

/** The cheapest model per successful call among those with enough calls, a known cost and MIN_SUCCESS. */
export const cheapestReliable = (stats: readonly ModelStats[]): ModelStats | null => {
  const perOk = (s: ModelStats) => s.cost / Math.max(1, s.calls - s.errors - s.aborted);
  const fit = stats.filter((s) => s.calls >= MIN_CALLS && s.costUnknown === 0 && s.successRate >= MIN_SUCCESS);
  return fit.sort((a, b) => perOk(a) - perOk(b))[0] ?? null;
};

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

export const renderReport = (month: string, stats: readonly ModelStats[]): string => {
  const pick = cheapestReliable(stats);
  const rows = stats.map(
    (s) =>
      `| ${s.model} | ${s.calls} | ${s.avgInput} | ${s.costUnknown > 0 ? `${s.cost.toFixed(2)} (+${s.costUnknown} unknown)` : s.cost.toFixed(2)} | ${s.errors} | ${s.retries} | ${pct(s.successRate)} | ${
        Object.entries(s.errorKinds)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([k, n]) => `${k}×${n}`)
          .join(", ") || "-"
      } |`,
  );
  return [
    `# 모델 비용 보고서 ${month}`,
    "",
    `호출 ${stats.reduce((s, x) => s + x.calls, 0)}건, 비용 $${stats.reduce((s, x) => s + x.cost, 0).toFixed(2)} (비용 미상 호출은 합계에서 빠짐)`,
    "",
    "| 모델 | 호출 | 평균 입력 토큰 | 비용 $ | 실패 | 재시도 | 성공률 | 주요 실패 |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows,
    "",
    pick
      ? `추천: 성공률 ${pct(MIN_SUCCESS)} 이상·호출 ${MIN_CALLS}건 이상 중 성공 1건당 가장 싼 모델은 \`${pick.model}\` (${pct(pick.successRate)}).`
      : `추천 없음: 비용이 알려진 모델 중 성공률 ${pct(MIN_SUCCESS)} 이상·호출 ${MIN_CALLS}건 이상인 모델이 없다.`,
    "",
  ].join("\n");
};
