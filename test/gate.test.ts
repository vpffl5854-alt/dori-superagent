import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { mergeGate, review } from "../src/gate.ts";
import type { World } from "./fake.ts";
import { setup } from "./harness-setup.ts";

describe("review + merge gate", () => {
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

  test("merge is refused without a receipt, with an empty check list, with red checks; allowed at CLEAR + green", async () => {
    const { w, d } = setup();
    gh(w, []);
    await expect(mergeGate(d, "o/r#7")).rejects.toThrow("no review receipt");
    w.reviewer = () => ({ code: 0, stdout: "HIGH src/a.ts:3 ...\nVERDICT: BLOCK" });
    expect((await review(d, "o/r#7")).verdict).toBe("BLOCK");
    await expect(mergeGate(d, "o/r#7")).rejects.toThrow("is BLOCK");
    w.reviewer = () => ({ code: 0, stdout: "no findings\nVERDICT: CLEAR" });
    await review(d, "o/r#7", "some/model");
    expect(d.store.receipt("o/r#7", head)!.model).toBe("some/model");
    await expect(mergeGate(d, "o/r#7")).rejects.toThrow("never green");
    gh(w, [
      { name: "test", bucket: "fail" },
      { name: "lint", bucket: "pass" },
    ]);
    await expect(mergeGate(d, "o/r#7")).rejects.toThrow("test=fail");
    gh(w, [{ name: "test", bucket: "skipping" }]);
    await expect(mergeGate(d, "o/r#7")).rejects.toThrow("every check was skipped");
    gh(w, [
      { name: "test", bucket: "pass" },
      { name: "docs", bucket: "skipping" },
    ]);
    expect(await mergeGate(d, "o/r#7")).toBe(`MERGED o/r#7 head=${head}`);
    expect(w.calls.at(-1)!.argv).toContain("--match-head-commit");
    expect(
      w.usage.filter((e) => e.name === "dori.merge_decided").map((e) => (e as { outcome: string }).outcome),
    ).toEqual(["no_receipt", "review_block", "no_checks", "checks_red", "checks_all_skipped", "merged"]);
    expect(w.usage.filter((e) => e.name === "dori.review_completed")).toHaveLength(2);
  });

  test("a failed re-review at the same head invalidates the earlier CLEAR receipt and refuses merge", async () => {
    const { w, d } = setup();
    gh(w, [{ name: "test", bucket: "pass" }]);
    w.reviewer = () => ({ code: 0, stdout: "no findings\nVERDICT: CLEAR" });
    await review(d, "o/r#70");
    expect(await mergeGate(d, "o/r#70", { dryRun: true })).toBe(`MERGE_OK o/r#70 head=${head} (dry run)`);

    w.reviewer = () => ({ code: 0, stdout: "reviewer output without a verdict" });
    await expect(review(d, "o/r#70")).rejects.toThrow("no VERDICT");
    expect(d.store.receipt("o/r#70", head)).toBeUndefined();
    await expect(mergeGate(d, "o/r#70")).rejects.toThrow("no review receipt");
    // The failed run's diagnostic is kept beside the receipt it invalidated.
    const diagnostics = readdirSync(join(d.store.root, "receipts")).filter((n) => n.endsWith(".noverdict.txt"));
    expect(diagnostics).toHaveLength(1);
    expect(readFileSync(join(d.store.root, "receipts", diagnostics[0]!), "utf8")).toBe(
      "reviewer output without a verdict",
    );

    // A reviewer that exits non-zero cannot leave its own verdict, or an earlier one, behind.
    w.reviewer = () => ({ code: 3, stdout: "no findings\nVERDICT: CLEAR", stderr: "model overloaded" });
    await expect(review(d, "o/r#70")).rejects.toThrow("reviewer exited 3");
    expect(d.store.receipt("o/r#70", head)).toBeUndefined();
    await expect(mergeGate(d, "o/r#70")).rejects.toThrow("no review receipt");

    // A newer CLEAR at the same head restores eligibility.
    w.reviewer = () => ({ code: 0, stdout: "no findings\nVERDICT: CLEAR" });
    expect((await review(d, "o/r#70")).verdict).toBe("CLEAR");
    expect(await mergeGate(d, "o/r#70")).toBe(`MERGED o/r#70 head=${head}`);
  });

  test("a BLOCK re-review at the same head replaces the CLEAR receipt and refuses merge", async () => {
    const { w, d } = setup();
    gh(w, [{ name: "test", bucket: "pass" }]);
    w.reviewer = () => ({ code: 0, stdout: "VERDICT: CLEAR" });
    await review(d, "o/r#71");

    w.reviewer = () => ({ code: 0, stdout: "HIGH src/a.ts:3\nVERDICT: BLOCK" });
    expect((await review(d, "o/r#71")).verdict).toBe("BLOCK");
    expect(d.store.receipt("o/r#71", head)?.verdict).toBe("BLOCK");
    await expect(mergeGate(d, "o/r#71", { dryRun: true })).rejects.toThrow("is BLOCK");
  });

  test("a failed review at one head leaves another head's receipt untouched", async () => {
    const { w, d } = setup();
    const older = "b".repeat(40);
    let current = older;
    w.gh = (argv) => {
      if (argv[1] === "view") return { code: 0, stdout: JSON.stringify({ headRefOid: current }) };
      if (argv[1] === "checks") return { code: 0, stdout: JSON.stringify([{ name: "test", bucket: "pass" }]) };
      if (argv[0] === "api") return { code: 0, stdout: JSON.stringify({ total_count: 0, workflow_runs: [] }) };
      return { code: 0, stdout: "" };
    };
    w.reviewer = () => ({ code: 0, stdout: "VERDICT: CLEAR" });
    await review(d, "o/r#72");

    current = head;
    w.reviewer = () => ({ code: 0, stdout: "no verdict here" });
    await expect(review(d, "o/r#72")).rejects.toThrow("no VERDICT");
    expect(d.store.receipt("o/r#72", older)?.verdict).toBe("CLEAR");
    expect(d.store.receipt("o/r#72", head)).toBeUndefined();
    await expect(mergeGate(d, "o/r#72", { dryRun: true })).rejects.toThrow("no review receipt");

    current = older;
    expect(await mergeGate(d, "o/r#72", { dryRun: true })).toBe(`MERGE_OK o/r#72 head=${older} (dry run)`);
  });

  test("a reviewer that cannot start cannot leave the older CLEAR receipt behind", async () => {
    const { w, d } = setup();
    gh(w, []);
    w.reviewer = () => ({ code: 0, stdout: "VERDICT: CLEAR" });
    await review(d, "o/r#73");

    const deps = {
      ...d,
      exec: async (cmd: string) => {
        if (cmd === "gh") return { code: 0, stdout: JSON.stringify({ headRefOid: head }), stderr: "" };
        throw new Error("spawn omo ENOENT");
      },
    };
    await expect(review(deps, "o/r#73")).rejects.toThrow("spawn omo ENOENT");
    expect(d.store.receipt("o/r#73", head)).toBeUndefined();
    await expect(mergeGate(deps, "o/r#73", { dryRun: true })).rejects.toThrow("no review receipt");
    w.reviewer = () => ({ code: 0, stdout: "VERDICT: CLEAR" });
    expect((await review(d, "o/r#73")).verdict).toBe("CLEAR");
  });

  test("two overlapping reviews at one head: the second refuses, merge rejects the first, and a later review is eligible", async () => {
    const { w, d } = setup();
    gh(w, []);
    w.reviewer = () => ({ code: 0, stdout: "VERDICT: CLEAR" });
    await review(d, "o/r#74");

    let release!: () => void;
    const finish = new Promise<void>((r) => (release = r));
    let started!: () => void;
    const began = new Promise<void>((r) => (started = r));
    const deps = {
      ...d,
      exec: async (cmd: string, argv: readonly string[]) => {
        if (cmd === "gh")
          return {
            code: 0,
            stdout:
              argv[0] === "api"
                ? JSON.stringify({ total_count: 0, workflow_runs: [] })
                : argv[1] === "checks"
                  ? JSON.stringify([{ name: "test", bucket: "pass" }])
                  : JSON.stringify({ headRefOid: head }),
            stderr: "",
          };
        started();
        await finish;
        return { code: 0, stdout: "VERDICT: CLEAR", stderr: "" };
      },
    };
    const inflight = review(deps, "o/r#74");
    await began;
    expect(d.store.receipt("o/r#74", head)).toBeUndefined();
    await expect(mergeGate(deps, "o/r#74", { dryRun: true })).rejects.toThrow("review_in_progress");
    await expect(review(deps, "o/r#74")).rejects.toThrow("already in progress");

    release();
    expect((await inflight).verdict).toBe("CLEAR");
    expect(await mergeGate(deps, "o/r#74", { dryRun: true })).toBe(`MERGE_OK o/r#74 head=${head} (dry run)`);

    // The lock is gone: a later review can run, and its receipt is eligible again.
    expect((await review(deps, "o/r#74")).verdict).toBe("CLEAR");
    expect(await mergeGate(deps, "o/r#74", { dryRun: true })).toBe(`MERGE_OK o/r#74 head=${head} (dry run)`);
  });
});
