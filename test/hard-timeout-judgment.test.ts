import { describe, expect, test } from "bun:test";
import { elapsedMin, overLimit, parsePaneRows } from "../src/hard-timeout.ts";

const MIN = 60_000;
const T0 = 1_000_000;

const row = (address: string, name: string | undefined, createdMs: number | undefined) => ({
  address,
  ...(name === undefined ? {} : { name }),
  ...(createdMs === undefined ? {} : { created_ms: createdMs }),
});

describe("hard limit judgment", () => {
  test("elapsed minutes count from created_ms, whole minutes, never negative", () => {
    expect(elapsedMin(T0, T0)).toBe(0);
    expect(elapsedMin(T0, T0 + 59_999)).toBe(0);
    expect(elapsedMin(T0, T0 + 61 * MIN)).toBe(61);
    expect(elapsedMin(T0, T0 - 5 * MIN)).toBe(0);
  });

  test("the threshold is strict: exactly the limit is not over, one minute more is", () => {
    expect(overLimit(T0, T0 + 60 * MIN, 60)).toBe(false);
    expect(overLimit(T0, T0 + 60 * MIN + 1, 60)).toBe(true);
    expect(overLimit(T0, T0 + 61 * MIN, 60)).toBe(true);
  });

  test("rows without a numeric created_ms, and another machine's rows, are skipped; a bad payload throws", () => {
    const rows = parsePaneRows(
      JSON.stringify({
        terminals: [
          row("t1", "a", 5),
          row("t2", "b", undefined),
          { address: "t3", name: "c", created_ms: "5" },
          { address: "other/t4", name: "d", created_ms: 5 },
          row("t5", undefined, 5),
        ],
      }),
    );
    expect(rows).toEqual([
      { address: "t1", name: "a", createdMs: 5 },
      { address: "t5", createdMs: 5 },
    ]);
    expect(() => parsePaneRows("not json")).toThrow();
    expect(() => parsePaneRows(JSON.stringify({}))).toThrow("no terminals array");
  });
});
