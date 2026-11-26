import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { review } from "../src/gate.ts";
import type { World } from "./fake.ts";
import { setup } from "./harness-setup.ts";

describe("review verdict parsing", () => {
  const head = "a".repeat(40);
  function gh(w: World, checks: unknown[]) {
    w.gh = (argv) => {
      if (argv[1] === "view") return { code: 0, stdout: JSON.stringify({ headRefOid: head }) };
      if (argv[1] === "checks") return { code: 0, stdout: JSON.stringify(checks) };
      if (argv[1] === "merge") return { code: 0, stdout: "" };
      return { code: 1, stdout: "" };
    };
  }

  test("legacy plain lines and whole-line emphasis are accepted", async () => {
    const { w, d } = setup();
    gh(w, []);
    const accepted = [
      ["plain", "no findings\nVERDICT: CLEAR", "CLEAR"],
      ["legacy rationale", "VERDICT: CLEAR — 4 LOW findings", "CLEAR"],
      ["legacy parenthetical", "VERDICT: BLOCK   (at least one HIGH finding)", "BLOCK"],
      ["bold", "**VERDICT: CLEAR**", "CLEAR"],
      ["backticks", "`VERDICT: CLEAR`", "CLEAR"],
      ["spaced emphasis", "** VERDICT: CLEAR **", "CLEAR"],
      ["bold keyword", "**VERDICT**: CLEAR", "CLEAR"],
      ["nested emphasis", "**_VERDICT: CLEAR_**", "CLEAR"],
      ["bold backticks", "**`VERDICT: CLEAR`**", "CLEAR"],
      ["fenced example then real", "```\nVERDICT: BLOCK\n```\n\n**VERDICT: CLEAR**", "CLEAR"],
    ] as const;
    for (const [i, [name, stdout, want]] of accepted.entries()) {
      w.reviewer = () => ({ code: 0, stdout });
      const pr = `o/r#${20 + i}`;
      expect({ name, verdict: (await review(d, pr)).verdict }).toEqual({ name, verdict: want });
      expect(d.store.receipt(pr, head)?.verdict).toBe(want);
    }
  });

  test("markers, indentation, trailing prose and prose mentions never decide", async () => {
    const { w, d } = setup();
    gh(w, []);
    const refused = [
      ["bullet", "- **VERDICT: BLOCK**"],
      ["asterisk bullet", "* **VERDICT: CLEAR**"],
      ["blockquote", "> VERDICT: CLEAR"],
      ["ordered list", "1. VERDICT: CLEAR"],
      ["indented", "  VERDICT: CLEAR"],
      ["indented code block", "    VERDICT: CLEAR"],
      ["bold with trailing sentence", "**VERDICT: CLEAR** — no HIGH or MEDIUM findings"],
      ["em-dash prose behind a bullet", "Findings:\n- VERDICT: CLEAR — is required before merging\n- another note"],
      ["prose mention", "I cannot give a VERDICT: CLEAR without a diff."],
      ["heading", "### VERDICT: CLEAR"],
      ["unclosed fence", "```\nsome code\nVERDICT: BLOCK"],
      ["word continues", "VERDICT: CLEARLY"],
      ["hyphen continues", "VERDICT: CLEAR-ISH"],
    ] as const;
    for (const [i, [name, stdout]] of refused.entries()) {
      w.reviewer = () => ({ code: 0, stdout });
      const pr = `o/r#${40 + i}`;
      const failure: unknown = await review(d, pr).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect({ name, error: failure instanceof Error ? failure.message : "" }).toEqual({
        name,
        error: expect.stringContaining("no VERDICT line"),
      });
      expect(d.store.receipt(pr, head)).toBeUndefined();
    }
  });

  test("plain lines keep last-match; a plain/decorated conflict and a nonzero exit never write a receipt", async () => {
    const { w, d } = setup();
    gh(w, []);
    w.reviewer = () => ({ code: 0, stdout: "Example:\nVERDICT: BLOCK\n\nVERDICT: CLEAR" });
    expect((await review(d, "o/r#50")).verdict).toBe("CLEAR");
    w.reviewer = () => ({ code: 0, stdout: "VERDICT: BLOCK\nVERDICT:CLEAR" });
    expect((await review(d, "o/r#53")).verdict).toBe("CLEAR");
    w.reviewer = () => ({ code: 0, stdout: "VERDICT: BLOCK\n  VERDICT: CLEAR" });
    expect((await review(d, "o/r#54")).verdict).toBe("BLOCK");
    w.reviewer = () => ({
      code: 0,
      stdout: "HIGH a.ts:1\nVERDICT: BLOCK\n\nExample of the required line:\n\n    VERDICT: CLEAR",
    });
    expect((await review(d, "o/r#55")).verdict).toBe("BLOCK");
    w.reviewer = () => ({ code: 0, stdout: "HIGH src/a.ts:3 no test\nVERDICT: BLOCK\n\n**VERDICT: CLEAR**" });
    const conflict: unknown = await review(d, "o/r#51").then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(conflict instanceof Error ? conflict.message : "").toContain("conflicting verdicts (BLOCK and CLEAR)");
    expect(d.store.receipt("o/r#51", head)).toBeUndefined();
    w.reviewer = () => ({ code: 0, stdout: "**VERDICT: CLEAR**\n\n**VERDICT: BLOCK**" });
    const emphasisedConflict: unknown = await review(d, "o/r#56").then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(emphasisedConflict instanceof Error ? emphasisedConflict.message : "").toContain(
      "conflicting verdicts (CLEAR and BLOCK)",
    );
    expect(d.store.receipt("o/r#56", head)).toBeUndefined();
    w.reviewer = () => ({ code: 0, stdout: "````\n```\nVERDICT: CLEAR\n```\n````\n\nVERDICT: BLOCK" });
    expect((await review(d, "o/r#57")).verdict).toBe("BLOCK");
    w.reviewer = () => ({ code: 9, stdout: "**VERDICT: CLEAR**" });
    const failure: unknown = await review(d, "o/r#52").then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(failure instanceof Error ? failure.message : "").toContain("reviewer exited 9");
    expect(d.store.receipt("o/r#52", head)).toBeUndefined();
    const files = readdirSync(join(d.store.root, "receipts")).filter(
      (n) => n.endsWith(".noverdict.txt") && n.startsWith("o__r_52@"),
    );
    expect(files).toHaveLength(1);
    expect(readFileSync(join(d.store.root, "receipts", files[0]!), "utf8")).toBe("**VERDICT: CLEAR**");
  });

  test("the shipped review prompt's template never parses as a verdict", async () => {
    const { w, d } = setup();
    gh(w, []);
    w.reviewer = () => ({
      code: 0,
      stdout: readFileSync(join(import.meta.dir, "..", "prompts", "review.md"), "utf8"),
    });
    await expect(review(d, "o/r#60")).rejects.toThrow("no VERDICT line");
    expect(d.store.receipt("o/r#60", head)).toBeUndefined();
  });

  test("exit 0 without a VERDICT line: bounded stdout tail kept privately, no receipt", async () => {
    const { w, d } = setup();
    gh(w, []);
    const lines = Array.from({ length: 205 }, (_, i) => `line-${i + 1}`);
    w.reviewer = () => ({ code: 0, stdout: lines.join("\n") });
    const failure: unknown = await review(d, "o/r#8").then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(failure).toBeInstanceOf(Error);
    const files = readdirSync(join(d.store.root, "receipts")).filter((n) => n.endsWith(".noverdict.txt"));
    expect(files).toHaveLength(1);
    const name = files[0];
    if (!name || !(failure instanceof Error)) throw new Error("missing diagnostic file or review error");
    expect(name).toStartWith(`o__r_8@${head}`);
    const diagnostic = join(d.store.root, "receipts", name);
    expect(failure.message).toContain("no VERDICT");
    expect(failure.message).toContain(diagnostic);
    expect(statSync(diagnostic).mode & 0o777).toBe(0o600);
    expect(readFileSync(diagnostic, "utf8").split("\n")).toEqual(lines.slice(5));
    expect(d.store.receipt("o/r#8", head)).toBeUndefined();
  });

  test("nonzero exit without a VERDICT line: stdout tail kept too, exit code in the error, no receipt", async () => {
    const { w, d } = setup();
    gh(w, []);
    w.reviewer = () => ({ code: 9, stdout: "partial reviewer output" });
    const failure: unknown = await review(d, "o/r#9").then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(failure).toBeInstanceOf(Error);
    const files = readdirSync(join(d.store.root, "receipts")).filter((n) => n.endsWith(".noverdict.txt"));
    expect(files).toHaveLength(1);
    const name = files[0];
    if (!name || !(failure instanceof Error)) throw new Error("missing diagnostic file or review error");
    const diagnostic = join(d.store.root, "receipts", name);
    expect(failure.message).toContain("reviewer exited 9");
    expect(failure.message).toContain(diagnostic);
    expect(readFileSync(diagnostic, "utf8")).toBe("partial reviewer output");
    expect(statSync(diagnostic).mode & 0o777).toBe(0o600);
    expect(d.store.receipt("o/r#9", head)).toBeUndefined();
  });
});
