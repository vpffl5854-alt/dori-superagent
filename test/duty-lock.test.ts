import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { main } from "../src/cli.ts";
import { Refusal } from "../src/refusal.ts";
import { acquire, release } from "../src/loop-lock.ts";
import { World } from "./fake.ts";
import { captureIo } from "./inbox-setup.ts";

describe("one duty loop per home", () => {
  test("a second dori duty refuses while a live loop holds duty/lock, and runs once the lock is released", async () => {
    const d = new World().deps();
    const lock = d.store.lockPath("duty");
    const first = acquire(d, lock);
    if (!("nonce" in first)) throw new Error(`could not take the lock: ${first.holder}`);
    await expect(main(["duty", "--once"], d)).rejects.toThrow(Refusal);
    await expect(main(["duty", "--once"], d)).rejects.toThrow(
      `another duty loop runs in this home (locked by pid ${process.pid})`,
    );
    release(d, first.nonce, lock);
    expect((await captureIo(() => main(["duty", "--once"], d))).code).toBe(0);
    expect(existsSync(lock)).toBe(false);
  });

  test("the hourly loop's lock is separate: holding it does not stop the duty loop", async () => {
    const d = new World().deps();
    const loop = acquire(d);
    if (!("nonce" in loop)) throw new Error("could not take the loop lock");
    expect((await captureIo(() => main(["duty", "--once"], d))).code).toBe(0);
    release(d, loop.nonce);
  });
});
