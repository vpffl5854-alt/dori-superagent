import { describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { LOCK_STALE_MS } from "../src/checkpoint-lock.ts";
import { Checkpoints, type CheckpointInput } from "../src/checkpoints.ts";
import { withState } from "./fakes.ts";

// A separate process takes the journal lock through the real code, says LOCKED, and holds it until stdin gets a line.
const holder = (dir: string) => {
  const source = join(import.meta.dir, "..", "src", "checkpoints.ts");
  const script = `import { Checkpoints } from ${JSON.stringify(source)};
    const release = new Checkpoints(${JSON.stringify(dir)}).lock("demo-lane", Date.now());
    console.log("LOCKED");
    for await (const _ of console) break;
    release();`;
  const proc = Bun.spawn([process.execPath, "-e", script], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
  const locked = (async () => {
    let seen = "";
    for await (const chunk of proc.stdout) {
      seen += new TextDecoder().decode(chunk);
      if (seen.includes("LOCKED")) return;
    }
    throw new Error(`holder exited before locking: ${seen}`);
  })();
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("holder did not lock in 10 s")), 10_000).unref(),
  );
  return { proc, locked: Promise.race([locked, timeout]) };
};

const input: CheckpointInput = {
  step: "deploy",
  result: "completed",
  evidence: ["receipt:123"],
  remoteEffects: ["release:123"],
};

const next: CheckpointInput = { ...input, step: "next", remoteEffects: ["release:456"] };

describe("checkpoints", () => {
  test("a live writer in another process holds the lock; the next writer is refused, then writes once it is released", async () => {
    const state = withState();
    // Write before the holder starts: a write racing the holder's lock attempt can make the holder lose it and exit.
    const journal = new Checkpoints(state.dir);
    journal.write("demo-lane", input, Date.now());
    const { proc, locked } = holder(state.dir);
    try {
      await locked;
      const before = readFileSync(journal.path("demo-lane"), "utf8");
      expect(() => journal.write("demo-lane", next, Date.now())).toThrow(`writer locked: demo-lane (pid ${proc.pid}`);
      expect(readFileSync(journal.path("demo-lane"), "utf8")).toBe(before);
      proc.stdin.write("release\n");
      await proc.stdin.end();
      expect(await proc.exited).toBe(0);
      journal.write("demo-lane", next, Date.now());
      expect(journal.read("demo-lane").map((c) => c.step)).toEqual(["deploy", "next"]);
      expect(existsSync(`${journal.path("demo-lane")}.lock`)).toBe(false);
    } finally {
      proc.kill();
      state.done();
    }
  });

  test("a lock left by a writer killed mid-write is taken over at once", async () => {
    const state = withState();
    const { proc, locked } = holder(state.dir);
    try {
      const journal = new Checkpoints(state.dir);
      await locked;
      proc.kill("SIGKILL");
      await proc.exited;
      expect(existsSync(`${journal.path("demo-lane")}.lock`)).toBe(true);
      journal.write("demo-lane", input, Date.now());
      expect(journal.read("demo-lane").map((c) => c.step)).toEqual(["deploy"]);
      expect(existsSync(`${journal.path("demo-lane")}.lock`)).toBe(false);
    } finally {
      state.done();
    }
  });

  test("a lock older than the bound is taken over even when its pid is alive; a younger one is refused", () => {
    const state = withState();
    try {
      const journal = new Checkpoints(state.dir);
      journal.lock("demo-lane", 1000); // never released: this process stays alive
      expect(() => journal.write("demo-lane", input, 1000 + LOCK_STALE_MS - 1)).toThrow("writer locked");
      journal.write("demo-lane", input, 1000 + LOCK_STALE_MS);
      expect(journal.read("demo-lane")).toHaveLength(1);
      // The lock directory an earlier build left behind has no owner record; its age decides.
      mkdirSync(`${journal.path("demo-lane")}.lock`);
      expect(() => journal.write("demo-lane", next, Date.now())).toThrow("writer locked");
      journal.write("demo-lane", next, Date.now() + LOCK_STALE_MS + 1000);
      expect(journal.read("demo-lane").map((c) => c.step)).toEqual(["deploy", "next"]);
    } finally {
      state.done();
    }
  });

  test("a lock whose owner time cannot be read is aged by its mtime, not taken over at once", () => {
    const state = withState();
    try {
      const journal = new Checkpoints(state.dir);
      const lock = `${journal.path("demo-lane")}.lock`;
      mkdirSync(dirname(lock), { recursive: true });
      // A live writer on this host whose record holds an unreadable time.
      writeFileSync(lock, JSON.stringify({ pid: process.pid, host: hostname(), at: "not a time", nonce: "n" }));
      const changed = statSync(lock).mtimeMs;
      expect(() => journal.write("demo-lane", input, changed + LOCK_STALE_MS - 1000)).toThrow(
        `writer locked: demo-lane (pid ${process.pid}`,
      );
      expect(journal.read("demo-lane")).toEqual([]);
      journal.write("demo-lane", input, changed + LOCK_STALE_MS);
      expect(journal.read("demo-lane").map((c) => c.step)).toEqual(["deploy"]);
    } finally {
      state.done();
    }
  });

  test("a release leaves the lock a stale takeover installed between its ownership check and its removal", () => {
    const state = withState();
    const original = fs.readFileSync;
    try {
      const journal = new Checkpoints(state.dir);
      const lock = `${journal.path("demo-lane")}.lock`;
      const release = journal.lock("demo-lane", 1000);
      let other: (() => void) | undefined;
      // The release reads its record back; right after that read, a second writer takes the now stale lock over.
      const spy = spyOn(fs, "readFileSync").mockImplementation(((path: string, options: BufferEncoding) => {
        const raw = original(path, options);
        if (String(path).startsWith(lock)) {
          spy.mockRestore();
          other = new Checkpoints(state.dir).lock("demo-lane", 1000 + LOCK_STALE_MS);
        }
        return raw;
      }) as typeof fs.readFileSync);
      release();
      spy.mockRestore();
      expect(other).toBeDefined();
      expect(existsSync(lock)).toBe(true);
      expect(JSON.parse(readFileSync(lock, "utf8")).at).toBe(new Date(1000 + LOCK_STALE_MS).toISOString());
      release(); // a release that finds the other writer's lock in place puts it back
      expect(JSON.parse(readFileSync(lock, "utf8")).at).toBe(new Date(1000 + LOCK_STALE_MS).toISOString());
      other!();
      expect(readdirSync(dirname(lock))).toEqual([]);
    } finally {
      state.done();
    }
  });
});
