import { afterEach, beforeEach, expect, test } from "bun:test";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootCheck } from "../src/boot.ts";
import { Reports } from "../src/reports.ts";
import { Worklog } from "../src/worklog.ts";
import { depsFor, fakeClock, newWorld, withState, type World } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00Z");

let state: ReturnType<typeof withState>;

beforeEach(() => {
  state = withState();
});

afterEach(() => state.done());

// Every directory and file under the state dir, with file bytes, so a created directory counts as a write too.
const snapshot = (dir: string) =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .map((e) => [
      join(e.parentPath, e.name),
      e.isFile() ? readFileSync(join(e.parentPath, e.name), "utf8") : e.isDirectory() ? "<dir>" : "<other>",
    ])
    .sort((a, b) => (a[0] ?? "").localeCompare(b[0] ?? ""));

const bootDeps = (world: World, slack: () => Promise<{ userId: string; teamId: string } | null> = async () => null) => {
  const sessionsDir = join(state.dir, "sessions");
  const deps = depsFor(world, fakeClock(T0), state.dir, { sessionsDir, leadPane: "w2:p1" });
  return { ...deps, reports: new Reports(state.dir), worklog: new Worklog(state.dir), slack, sessionsDir };
};

test("boot prints each open worklog item with its Next line, skips closed ones, and writes nothing", async () => {
  // Given one item with a next step, one without, and one closed.
  const world = newWorld();
  const deps = bootDeps(world);
  const release = deps.worklog.add("Ship the release notes", "slack:D1/100.1", T0);
  deps.worklog.next(release.id, "wait for CI on #12, then merge", T0 + 1);
  const fresh = deps.worklog.add("Look at the flaky upload test", "slack:D1/100.2", T0 + 2);
  const old = deps.worklog.add("Rename the bot", "slack:D1/100.3", T0 + 3);
  deps.worklog.close(old.id, "renamed; owner confirmed", T0 + 4);
  const before = snapshot(state.dir);
  // When boot runs.
  const result = await bootCheck(deps);
  // Then the open items are listed oldest first with their Next line, the closed one is absent, and no file changed.
  expect(result.exitCode).toBe(0);
  const at = result.lines.indexOf("WORKLOG open=2");
  expect(result.lines.slice(at, at + 3)).toEqual([
    "WORKLOG open=2",
    `OPEN ${release.id} "Ship the release notes" source="slack:D1/100.1" next="wait for CI on #12, then merge"`,
    `OPEN ${fresh.id} "Look at the flaky upload test" source="slack:D1/100.2" next=""`,
  ]);
  expect(result.lines.some((l) => l.includes(old.id))).toBe(false);
  expect(snapshot(state.dir)).toEqual(before);
});

test("a damaged worklog line is named and makes boot incomplete; the other items still print", async () => {
  // Given one item and a line after it that is not a record at all.
  const deps = bootDeps(newWorld());
  const item = deps.worklog.add("Keep this", "slack:D1/100.1", T0);
  writeFileSync(deps.worklog.path, `${readFileSync(deps.worklog.path, "utf8")}garbage\n`);
  // When boot runs; then the item prints, the bad line is named, and the exit is 1.
  const result = await bootCheck(deps);
  expect(result.lines).toContain(`OPEN ${item.id} "Keep this" source="slack:D1/100.1" next=""`);
  expect(
    result.lines.filter((line) => line.startsWith(`WORKLOG damaged ${deps.worklog.path}:2: JSON Parse error`)),
  ).toHaveLength(1);
  expect(result.exitCode).toBe(1);
});

test("torn writes and a duplicate close from racing writers keep boot clean and the item list right", async () => {
  // Given a closed item with a second close after it, a torn line followed by a valid add, and a torn final line.
  const deps = bootDeps(newWorld());
  const log = deps.worklog;
  const done = log.add("Answered", "slack:D1/100.1", T0);
  log.close(done.id, "first answer", T0 + 1);
  const close = JSON.stringify({
    op: "close",
    id: done.id,
    at: new Date(T0 + 2).toISOString(),
    result: "second answer",
  });
  writeFileSync(log.path, `${readFileSync(log.path, "utf8")}${close}\n{"op":"note","id":"${done.id}","at`);
  const open = log.add("Still open", "slack:D1/100.2", T0 + 3);
  writeFileSync(log.path, `${readFileSync(log.path, "utf8")}{"op":"add","id":"0000be`);
  // When boot runs.
  const result = await bootCheck(deps);
  // Then nothing is damaged, the exit is 0, the open item prints, and the first close stands.
  expect(result.lines.filter((line) => line.startsWith("WORKLOG "))).toEqual(["WORKLOG open=1"]);
  expect(result.lines).toContain(`OPEN ${open.id} "Still open" source="slack:D1/100.2" next=""`);
  expect(result.exitCode).toBe(0);
  expect(log.read()).toEqual({
    items: [
      {
        id: done.id,
        title: "Answered",
        source: "slack:D1/100.1",
        openedAt: new Date(T0).toISOString(),
        notes: [],
        closedAt: new Date(T0 + 1).toISOString(),
        result: "first answer",
      },
      {
        id: open.id,
        title: "Still open",
        source: "slack:D1/100.2",
        openedAt: new Date(T0 + 3).toISOString(),
        notes: [],
      },
    ],
    problems: [],
    warnings: [],
  });
});

test("a next and a note that raced a close print as warnings and keep boot clean; the close stands", async () => {
  // Given a closed item with a next and a note appended after the close by writers that saw it open.
  const deps = bootDeps(newWorld());
  const log = deps.worklog;
  const done = log.add("Answered", "slack:D1/100.1", T0);
  log.close(done.id, "answered", T0 + 1);
  const late = (op: string, at: number) =>
    JSON.stringify({ op, id: done.id, at: new Date(at).toISOString(), text: `late ${op}` });
  writeFileSync(log.path, `${readFileSync(log.path, "utf8")}${late("next", T0 + 2)}\n${late("note", T0 + 3)}\n`);
  // When boot runs.
  const result = await bootCheck(deps);
  // Then both are named as warnings, nothing is damaged, the item stays closed, and the exit is 0.
  expect(result.lines.filter((line) => line.startsWith("WORKLOG "))).toEqual([
    "WORKLOG open=0",
    `WORKLOG warning ${log.path}:3: worklog item ${done.id} was already closed; next ignored`,
    `WORKLOG warning ${log.path}:4: worklog item ${done.id} was already closed; note ignored`,
  ]);
  expect(result.lines.at(-1)).toBe("BOOT checked read-only; nothing restarted, written or stopped");
  expect(result.exitCode).toBe(0);
});

test("a worklog source that spells out fields of its own stays one quoted value on its OPEN line", async () => {
  // Given an item whose source tries to add a next field and a second OPEN item.
  const deps = bootDeps(newWorld());
  const item = deps.worklog.add("Real request", 'x next="done" OPEN deadbeef', T0);
  // When boot runs; then the source is printed quoted, so the line still has exactly one source and one next.
  const result = await bootCheck(deps);
  expect(result.lines).toContain(`OPEN ${item.id} "Real request" source="x next=\\"done\\" OPEN deadbeef" next=""`);
  expect(result.lines.filter((line) => line.startsWith("OPEN "))).toHaveLength(1);
});
