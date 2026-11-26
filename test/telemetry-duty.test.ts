import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DutyCounts } from "../src/telemetry.ts";
import { type Rig, rig, summaryAttrs } from "./telemetry-rig.ts";

const tick: DutyCounts = { ticks: 1, flushed: 1, nudges: 0, escalations: 0, lost: 0, stuck: 0 };

/**
 * A bucket written by a version from before `stuck` existed: every counter it knew, and no key for the new one.
 * `??` does not fill that gap (the object is not nullish), so the first sum into it is what these tests watch.
 */
const seedOldBucket = (r: Rig, sinceAgo: number) =>
  writeFileSync(
    join(r.home, "telemetry.json"),
    `${JSON.stringify({
      installId: "a".repeat(64),
      noticeShown: true,
      installedSent: true,
      lastActiveDay: "2026-11-02",
      duty: { ticks: 5, flushed: 5, nudges: 0, escalations: 0, lost: 0, since: r.now() - sinceAgo },
    })}\n`,
  );

describe("the duty summary", () => {
  test("sums ticks and sends at most once an hour", async () => {
    const r = rig();
    for (let i = 0; i < 60; i++) {
      r.t.duty(tick);
      await r.t.flush(5000);
      r.advance(60_000);
    }
    expect(r.logs()).toEqual([]);
    r.t.duty({ ...tick, nudges: 1, stuck: 2 });
    await r.t.flush(5000);
    expect(r.names()).toEqual(["dori.duty_summary"]);
    const attrs = summaryAttrs(r.logs()[0]!.body);
    expect([attrs["dori.ticks"], attrs["dori.flushed"], attrs["dori.nudges"], attrs["dori.stuck"]]).toEqual([
      "61",
      "61",
      "1",
      "2",
    ]);
    r.t.duty(tick);
    await r.t.flush(5000);
    expect(r.logs()).toHaveLength(1);
  });

  test("a stored bucket from before a counter existed is normalized, not summed into NaN", async () => {
    const r = rig();
    seedOldBucket(r, 30 * 60_000);
    r.t.duty({ ...tick, stuck: 2 });
    await r.t.flush(5000);
    expect(r.logs()).toEqual([]);

    // Before the hour boundary the bucket is stored: the new counter must be a number there, never null.
    const stored = readFileSync(join(r.home, "telemetry.json"), "utf8");
    expect(JSON.parse(stored).duty).toEqual({
      since: r.now() - 30 * 60_000,
      ticks: 6,
      flushed: 6,
      nudges: 0,
      escalations: 0,
      lost: 0,
      stuck: 2,
    });
    expect(stored).not.toContain("null");

    // Reaching the boundary emits the bucket, and every counter is a real integer.
    r.advance(40 * 60_000);
    r.t.duty(tick);
    await r.t.flush(5000);
    expect(r.names()).toEqual(["dori.duty_summary"]);
    const body = r.logs()[0]!.body;
    expect(body).not.toContain("NaN");
    const attrs = summaryAttrs(body);
    expect([attrs["dori.ticks"], attrs["dori.stuck"]]).toEqual(["7", "2"]);
  });

  test("a stored bucket already past the hour emits on the first sum, with its counters intact", async () => {
    const r = rig();
    seedOldBucket(r, 90 * 60_000);
    r.t.duty({ ...tick, stuck: 3 });
    await r.t.flush(5000);
    expect(r.names()).toEqual(["dori.duty_summary"]);
    const body = r.logs()[0]!.body;
    expect(body).not.toContain("NaN");
    const attrs = summaryAttrs(body);
    expect([attrs["dori.ticks"], attrs["dori.flushed"], attrs["dori.stuck"]]).toEqual(["6", "6", "3"]);
  });
});
