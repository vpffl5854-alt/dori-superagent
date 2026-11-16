import { describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CheckpointError, Checkpoints, type CheckpointInput } from "../src/checkpoints.ts";
import { Registry } from "../src/registry.ts";
import { withState } from "./fakes.ts";

const input: CheckpointInput = {
  step: "deploy",
  result: "completed",
  evidence: ["receipt:123"],
  remoteEffects: ["release:123"],
};

const next: CheckpointInput = { ...input, step: "next", remoteEffects: ["release:456"] };

describe("checkpoints", () => {
  test("persists completion and returns identical replay unchanged after restart", () => {
    const state = withState();
    try {
      const journal = new Checkpoints(state.dir);
      const written = journal.write("demo-lane", input, 1000);
      expect(written.unchanged).toBe(false);
      const before = readFileSync(journal.path("demo-lane"), "utf8");
      const restarted = new Checkpoints(state.dir);
      expect(
        restarted.write(
          "demo-lane",
          { remoteEffects: input.remoteEffects, evidence: input.evidence, result: input.result, step: input.step },
          2000,
        ),
      ).toEqual({ checkpoint: written.checkpoint, unchanged: true });
      expect(readFileSync(journal.path("demo-lane"), "utf8")).toBe(before);
      expect(restarted.read("demo-lane")).toEqual([written.checkpoint]);
    } finally {
      state.done();
    }
  });

  test("conflicting replay fails without overwriting or appending", () => {
    const state = withState();
    try {
      const journal = new Checkpoints(state.dir);
      const first = journal.write("demo-lane", input, 1000);
      const before = readFileSync(journal.path("demo-lane"), "utf8");
      expect(() =>
        new Checkpoints(state.dir).write("demo-lane", { ...input, remoteEffects: ["release:other"] }, 2000),
      ).toThrow("conflicting checkpoint step");
      expect(journal.read("demo-lane")).toEqual([first.checkpoint]);
      expect(readFileSync(journal.path("demo-lane"), "utf8")).toBe(before);
      expect(existsSync(`${journal.path("demo-lane")}.lock`)).toBe(false);
    } finally {
      state.done();
    }
  });

  test("a remote-effect receipt already recorded under one step is refused under another", () => {
    const state = withState();
    try {
      const journal = new Checkpoints(state.dir);
      const first = journal.write("demo-lane", input, 1000);
      expect(() => journal.write("demo-lane", { ...input, step: "deploy-again" }, 2000)).toThrow(
        "remote effect release:123 already recorded by step deploy",
      );
      expect(journal.read("demo-lane")).toEqual([first.checkpoint]);
    } finally {
      state.done();
    }
  });

  test("a corrupt record after a blank line is reported at its physical line", () => {
    const state = withState();
    try {
      const journal = new Checkpoints(state.dir);
      journal.write("demo-lane", input, 1000);
      appendFileSync(journal.path("demo-lane"), "\n{not json\n");
      expect(() => journal.read("demo-lane")).toThrow(`${journal.path("demo-lane")}:3:`);
    } finally {
      state.done();
    }
  });

  test("a stored record whose timestamp is not a string is refused", () => {
    const state = withState();
    try {
      const journal = new Checkpoints(state.dir);
      const { checkpoint } = journal.write("demo-lane", input, 1000);
      writeFileSync(journal.path("demo-lane"), `${JSON.stringify({ ...checkpoint, at: 1000 })}\n`);
      expect(() => journal.read("demo-lane")).toThrow("invalid key, timestamp, or duplicate step");
    } finally {
      state.done();
    }
  });

  test("dori checkpoint takes one receipt per --remote-effect and refuses a stray argument instead of dropping it", async () => {
    const state = withState();
    try {
      await new Registry(state.dir).write({
        key: "demo-lane",
        title: "demo",
        thread: "none",
        brief: "/b.md",
        done: "merged acme/app#1",
        openedAt: new Date().toISOString(),
      });
      const cli = async (...args: string[]) => {
        const proc = Bun.spawn(
          [
            process.execPath,
            join(import.meta.dir, "..", "src", "cli.ts"),
            "checkpoint",
            "demo-lane",
            "--result",
            "ok",
            "--evidence",
            "log",
            ...args,
          ],
          {
            env: { ...process.env, DORI_CONFIG: join(state.dir, "none.json"), DORI_STATE_DIR: state.dir },
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        return { code: await proc.exited, err: await new Response(proc.stderr).text() };
      };
      const journal = new Checkpoints(state.dir);
      const refused = await cli("--step", "push", "--remote-effect", "push:a", "push:b");
      expect(refused.code).not.toBe(0);
      expect(refused.err).toContain("unexpected argument push:b");
      expect(journal.read("demo-lane")).toEqual([]);
      expect((await cli("--step", "push", "--remote-effect", "push:a", "--remote-effect", "push:b")).code).toBe(0);
      expect(journal.read("demo-lane").map((c) => c.remoteEffects)).toEqual([["push:a", "push:b"]]);
    } finally {
      state.done();
    }
  });

  test("rejects malformed input, invalid keys, corrupt journals and duplicate stored steps", () => {
    const state = withState();
    try {
      const journal = new Checkpoints(state.dir);
      expect(journal.read("demo-lane")).toEqual([]);
      expect(() => journal.path("../escape")).toThrow(CheckpointError);
      expect(() => journal.write("demo-lane", { ...input, step: "" }, 1000)).toThrow(CheckpointError);
      const { checkpoint } = journal.write("demo-lane", input, 1000);
      appendFileSync(journal.path("demo-lane"), `${JSON.stringify(checkpoint)}\n`);
      expect(() => journal.read("demo-lane")).toThrow("duplicate step");
      expect(() => journal.write("demo-lane", next, 1000)).toThrow(CheckpointError);
    } finally {
      state.done();
    }
  });
});
