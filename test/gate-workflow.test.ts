import { describe, expect, test } from "bun:test";
import { mergeGate, review } from "../src/gate.ts";
import type { World } from "./fake.ts";
import { setup } from "./harness-setup.ts";

describe("merge gate: workflow runs at the head", () => {
  const head = "a".repeat(40);
  type Runs = { workflow_runs?: unknown[]; total_count?: number } | { fail: string } | { body: string };
  function gh(w: World, checks: unknown[], runs: Runs = {}) {
    w.gh = (argv) => {
      if (argv[1] === "view") return { code: 0, stdout: JSON.stringify({ headRefOid: head }) };
      if (argv[1] === "checks") return { code: 0, stdout: JSON.stringify(checks) };
      if (argv[1] === "merge") return { code: 0, stdout: "" };
      if (argv[0] === "api") {
        if ("fail" in runs) return { code: 1, stdout: "", stderr: runs.fail };
        if ("body" in runs) return { code: 0, stdout: runs.body };
        const list = runs.workflow_runs ?? [];
        return {
          code: 0,
          stdout: JSON.stringify({ total_count: runs.total_count ?? list.length, workflow_runs: list }),
        };
      }
      return { code: 1, stdout: "" };
    };
  }

  async function clearAt(d: ReturnType<typeof setup>["d"], w: World) {
    w.reviewer = () => ({ code: 0, stdout: "VERDICT: CLEAR" });
    await review(d, "o/r#7");
  }

  let nextId = 1;
  type Run = {
    id?: number;
    workflow_id?: number;
    name?: string | null;
    event?: string;
    head_sha?: string;
    status?: string;
    conclusion?: string | null;
  };
  const run = (o: Run = {}) => ({
    id: nextId++,
    workflow_id: 10,
    name: "ci",
    event: "pull_request",
    head_sha: head,
    status: "completed",
    conclusion: "success",
    ...o,
  });
  const green = [
    { name: "cla", bucket: "pass" },
    { name: "cubic", bucket: "skipping" },
  ];

  test("an unapproved pull_request run at the exact head refuses although gh pr checks is green", async () => {
    const { w, d } = setup();
    gh(w, green, {
      workflow_runs: [run({ conclusion: "action_required" }), run({ workflow_id: 11, event: "pull_request_target" })],
    });
    await clearAt(d, w);
    const at = head.slice(0, 12);
    await expect(mergeGate(d, "o/r#7")).rejects.toThrow(
      `MERGE_REFUSED pull_request workflow run(s) not green at head ${at}: ci=action_required`,
    );
    await expect(mergeGate(d, "o/r#7", { dryRun: true })).rejects.toThrow("ci=action_required");
    const api = w.calls.filter((c) => c.cmd === "gh" && c.argv[0] === "api");
    expect(api.map((c) => c.argv[1])).toEqual([
      `repos/o/r/actions/runs?head_sha=${head}&event=pull_request&per_page=100`,
      `repos/o/r/actions/runs?head_sha=${head}&event=pull_request&per_page=100`,
    ]);
    expect(w.calls.some((c) => c.argv[1] === "merge")).toBe(false);
    expect(
      w.usage.filter((e) => e.name === "dori.merge_decided").map((e) => (e as { outcome: string }).outcome),
    ).toEqual(["workflow_pending"]);
  });

  test("queued, running, waiting and completed red runs at the head refuse", async () => {
    for (const state of [
      { status: "queued", conclusion: null },
      { status: "in_progress", conclusion: null },
      { status: "waiting", conclusion: null },
      { status: "completed", conclusion: "failure" },
      { status: "completed", conclusion: "cancelled" },
      { status: "completed", conclusion: "timed_out" },
      { status: "completed", conclusion: "startup_failure" },
    ]) {
      const { w, d } = setup();
      gh(w, green, { workflow_runs: [run(state)] });
      await clearAt(d, w);
      await expect(mergeGate(d, "o/r#7", { dryRun: true })).rejects.toThrow(`ci=${state.conclusion ?? state.status}`);
    }
    const queued = setup();
    gh(queued.w, green, { workflow_runs: [run({ id: 30 }), run({ id: 31, status: "queued", conclusion: null })] });
    await clearAt(queued.d, queued.w);
    await expect(mergeGate(queued.d, "o/r#7", { dryRun: true })).rejects.toThrow("ci=queued");
  });

  test("green runs plus other-head, other-event and superseded runs let the merge through", async () => {
    const { w, d } = setup();
    gh(w, green, {
      workflow_runs: [
        run({ id: 20, conclusion: "cancelled" }),
        run({ id: 21, conclusion: "success" }),
        run({ id: 22, workflow_id: 12, conclusion: "stale" }),
        run({ id: 23, workflow_id: 12, name: null }),
        run({ id: 24, head_sha: "b".repeat(40), conclusion: "action_required" }),
        run({ id: 25, event: "push", status: "queued", conclusion: null }),
        run({ id: 26, workflow_id: 13, event: "pull_request_target", status: "queued", conclusion: null }),
        run({ id: 27, workflow_id: 14, conclusion: "neutral" }),
      ],
    });
    await clearAt(d, w);
    expect(await mergeGate(d, "o/r#7", { dryRun: true })).toBe(`MERGE_OK o/r#7 head=${head} (dry run)`);
    expect(w.usage.filter((e) => e.name === "dori.merge_decided")).toEqual([]);
  });

  test("workflow status that cannot be read fails closed", async () => {
    const { w, d } = setup();
    gh(w, [{ name: "test", bucket: "pass" }], { fail: "HTTP 403: Resource not accessible by integration" });
    await clearAt(d, w);
    await expect(mergeGate(d, "o/r#7")).rejects.toThrow(
      `MERGE_REFUSED workflow runs at ${head.slice(0, 12)} could not be read: HTTP 403`,
    );
    await expect(mergeGate(d, "o/r#7", { dryRun: true })).rejects.toThrow(
      "Actions status unavailable (permission denied or Actions disabled)",
    );
    await expect(mergeGate(d, "o/r#7", { dryRun: true })).rejects.toThrow(
      "stays refused until the status can be verified",
    );
    gh(w, green, { total_count: 2, workflow_runs: [run({ status: "queued", conclusion: null })] });
    await expect(mergeGate(d, "o/r#7", { dryRun: true })).rejects.toThrow("only 1 of 2 runs returned");
    for (const runs of [
      { body: "warning: this is not json" },
      { total_count: 1, workflow_runs: [{}] },
      {
        total_count: 1,
        workflow_runs: [{ id: 1, workflow_id: 10, event: "pull_request", head_sha: head, status: "completed" }],
      },
      { body: JSON.stringify({ workflow_runs: [run()] }) },
    ]) {
      gh(w, green, runs);
      await expect(mergeGate(d, "o/r#7", { dryRun: true })).rejects.toThrow("could not be read");
    }
    expect(
      w.usage.filter((e) => e.name === "dori.merge_decided").map((e) => (e as { outcome: string }).outcome),
    ).toEqual(["workflow_status_unknown"]);
    gh(w, green, {
      total_count: 1,
      workflow_runs: [{ id: 1, workflow_id: 10, event: "pull_request", head_sha: head, status: "completed" }],
    });
    await expect(mergeGate(d, "o/r#7", { dryRun: true })).rejects.toThrow("has an invalid conclusion");
  });
});
