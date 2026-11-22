import { expect, test } from "bun:test";

import { diagnose, erTick, prescribe } from "../src/er.ts";
import type { Lane } from "../src/registry.ts";

test.each([
  ["Error: 429 Too Many Requests", "rate-limit"],
  ["provider overloaded, retrying", "rate-limit"],
  ["You have hit your usage limit", "rate-limit"],
  ["Error: model hive2/foo not found", "model-dead"],
  ["unknown model: deepseek-v3", "model-dead"],
  ["prompt is too long: 210000 tokens > 200000 maximum", "context-overflow"],
  ["401 Unauthorized: invalid api key", "auth"],
] as const)("%p is %p", (screen, d) => {
  expect(diagnose(`❯ working\n${screen}\n`)).toBe(d);
});

test("a healthy screen has no diagnosis", () => {
  expect(diagnose("• Working (12s)\n✓ bun test  425 pass")).toBeNull();
});

test("an error that scrolled above the last lines is history, not a diagnosis", () => {
  const screen = ["429 Too Many Requests", ...Array.from({ length: 20 }, (_, i) => `step ${i} ok`)].join("\n");
  expect(diagnose(screen)).toBeNull();
});

test("auth is named before rate-limit when both show, so a bad key is never waited out", () => {
  expect(diagnose("401 unauthorized\n429 too many requests")).toBe("auth");
});

test("rate limit switches to the first backup that is not the current model, or waits without one", () => {
  expect(prescribe("rate-limit", "a", ["a", "b"])).toEqual({ action: "switch-model", to: "b" });
  expect(prescribe("rate-limit", "a", [])).toEqual({ action: "wait" });
});

test("a dead model switches to a backup or escalates; context overflow shortens; auth escalates", () => {
  expect(prescribe("model-dead", "a", ["b"])).toEqual({ action: "switch-model", to: "b" });
  expect(prescribe("model-dead", "a", [])).toEqual({ action: "escalate" });
  expect(prescribe("context-overflow", "a", ["b"])).toEqual({ action: "shorten-prompt" });
  expect(prescribe("auth", "a", ["b"])).toEqual({ action: "escalate" });
});

const lane = (key: string, extra: Partial<Lane> = {}): Lane => ({
  key,
  title: key,
  thread: "-",
  brief: "b.md",
  done: "-",
  openedAt: "2026-11-22T00:00:00Z",
  ...extra,
});

test("the sweep reports each sick working lane once an hour and skips closed or unreadable lanes", async () => {
  const screens: Record<string, string | null> = {
    sick: "429 too many requests",
    fine: "• Working",
    gone: "429 too many requests",
    blind: null,
  };
  const lanes = [
    lane("sick", { model: "m1" }),
    lane("fine"),
    lane("gone", { closedAt: "2026-11-22T01:00:00Z" }),
    lane("blind"),
  ];
  const opts = { defaultModel: "m0", backupModels: ["m1", "m2"] };
  const seen = new Set<string>();
  const read = async (l: Lane) => screens[l.key] ?? null;
  expect(await erTick(lanes, read, opts, seen, "h1")).toEqual(["ER sick rate-limit model=m1 -> switch-model to=m2"]);
  expect(await erTick(lanes, read, opts, seen, "h1")).toEqual([]);
  expect(await erTick(lanes, read, opts, seen, "h2")).toHaveLength(1);
});

test("a lane without its own model is judged against the default model", async () => {
  const out = await erTick(
    [lane("x")],
    async () => "model foo does not exist",
    { defaultModel: "m0", backupModels: [] },
    new Set(),
    "h",
  );
  expect(out).toEqual(["ER x model-dead model=m0 -> escalate"]);
});

test("the harness's working and waiting lanes and its lead and duty agents are watched; finished lanes are not", async () => {
  const { harnessLanes } = await import("../src/er.ts");
  const lanes = harnessLanes(
    [
      { key: "chat", status: "working", sessionRef: { runtime: "hc", id: "t5r" } },
      { key: "wait", status: "waiting", sessionRef: { runtime: "hc", id: "t6" } },
      { key: "old", status: "done", sessionRef: { runtime: "hc", id: "t1" } },
      { key: "broken", status: "working" },
    ],
    { lead: "hc:t1t", duty: "hc:t1v", "hourly-loop": "hc:t1x" },
  );
  expect(lanes.map((l) => `${l.key}@${l.sessionRef?.id}`)).toEqual(["lead@t1t", "duty@t1v", "chat@t5r", "wait@t6"]);
  const out = await erTick(
    lanes,
    async (l) => (l.key === "lead" ? "429 Too Many Requests" : "ok"),
    { defaultModel: "m0", backupModels: ["m1"] },
    new Set(),
    "h",
  );
  expect(out).toEqual(["ER lead rate-limit model=m0 -> switch-model to=m1"]);
});
