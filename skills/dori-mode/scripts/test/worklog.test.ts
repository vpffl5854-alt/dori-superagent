import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../src/run.ts";
import { publishWorklog, Worklog, WorklogError } from "../src/worklog.ts";
import { WORKLOG_MARKER } from "../src/worklog-render.ts";
import { withState } from "./fakes.ts";

const cli = join(import.meta.dir, "../src/cli.ts");

const T0 = Date.parse("2026-11-04T00:00:00Z");

const cliIn = (dir: string) => {
  const config = join(dir, "config.json");
  writeFileSync(config, JSON.stringify({ stateDir: dir, defaultCwd: dir, hooks: {} }));
  return (...args: string[]) =>
    run(["env", `DORI_CONFIG=${config}`, `DORI_STATE_DIR=${dir}`, process.execPath, cli, ...args]);
};

test("add, next, note and close build one markdown heading per item with Source, Next, Notes and Result", () => {
  // Given a worklog with one item taken through its whole life and one still open.
  const state = withState();
  try {
    const log = new Worklog(state.dir);
    const done = log.add("Rotate the bot token", "slack:D1/100.1", T0);
    log.next(done.id, "ask the owner for the new token", T0 + 1);
    log.note(done.id, "owner: rotate before Friday", T0 + 2);
    const closed = log.close(done.id, "rotated; inbound reads back", T0 + 3);
    const open = log.add("Fix the flaky upload test", "slack:D1/100.2", T0 + 4);
    // Then the returned item, the reread record and the rendered file agree.
    expect(closed).toEqual({
      id: done.id,
      title: "Rotate the bot token",
      source: "slack:D1/100.1",
      openedAt: new Date(T0).toISOString(),
      next: "ask the owner for the new token",
      notes: [{ at: new Date(T0 + 2).toISOString(), text: "owner: rotate before Friday" }],
      closedAt: new Date(T0 + 3).toISOString(),
      result: "rotated; inbound reads back",
    });
    expect(log.open().map((item) => item.id)).toEqual([open.id]);
    expect(readFileSync(log.markdownPath, "utf8")).toBe(`${WORKLOG_MARKER}
# Worklog

## Open

### ${open.id} Fix the flaky upload test
- Source: slack:D1/100.2
- Opened: 2026-11-04T00:00:00.004Z
- Next: (none yet)

## Closed

### ${done.id} Rotate the bot token
- Source: slack:D1/100.1
- Opened: 2026-11-04T00:00:00.000Z
- Next: ask the owner for the new token
- Notes:
  - 2026-11-04T00:00:00.002Z owner: rotate before Friday
- Closed: 2026-11-04T00:00:00.003Z
- Result: rotated; inbound reads back
`);
  } finally {
    state.done();
  }
});

test("an unknown or closed item, or a multi-line text, is refused and writes nothing", () => {
  // Given one closed item.
  const state = withState();
  try {
    const log = new Worklog(state.dir);
    const item = log.add("Done already", "slack:D1/1.1", T0);
    log.close(item.id, "shipped", T0 + 1);
    const before = [readFileSync(log.path, "utf8"), readFileSync(log.markdownPath, "utf8")];
    // When changing it, an unknown id, or adding a two-line title; then each is refused and both files are unchanged.
    expect(() => log.next(item.id, "more", T0 + 2)).toThrow(`worklog item ${item.id} is closed: shipped`);
    expect(() => log.note("0000beef", "x", T0 + 2)).toThrow("worklog item not found: 0000beef");
    expect(() => log.add("two\nlines", "slack:D1/1.2", T0 + 2)).toThrow(WorklogError);
    expect([readFileSync(log.path, "utf8"), readFileSync(log.markdownPath, "utf8")]).toEqual(before);
  } finally {
    state.done();
  }
});

test("a worklog.md the command did not write is never replaced, and the record is not touched", () => {
  // Given hand-written notes at the path the command renders to.
  const state = withState();
  try {
    const log = new Worklog(state.dir);
    writeFileSync(log.markdownPath, "# My notes\n- keep me\n");
    // When adding an item; then it is refused, the notes are intact, and no record was appended.
    expect(() => log.add("New request", "slack:D1/2.1", T0)).toThrow("was not written by dori worklog; move it aside");
    expect(readFileSync(log.markdownPath, "utf8")).toBe("# My notes\n- keep me\n");
    expect(existsSync(log.path)).toBe(false);
  } finally {
    state.done();
  }
});

test("a hand-written worklog.md that appears between the ownership check and the rename is kept", () => {
  // Given a worklog.md we rendered, and someone who replaces it while our next publish is in flight.
  const state = withState();
  try {
    const log = new Worklog(state.dir);
    log.add("First", "slack:D1/2.2", T0);
    const files = () => readdirSync(state.dir).sort();
    const before = files();
    // When the publish runs; then it is skipped, the hand-written file is intact, and no temp file is left.
    expect(
      publishWorklog(log.markdownPath, `${WORKLOG_MARKER}\nnewer view\n`, () =>
        writeFileSync(log.markdownPath, "# My notes\n"),
      ),
    ).toBe(false);
    expect(readFileSync(log.markdownPath, "utf8")).toBe("# My notes\n");
    expect(files()).toEqual(before);
    // And with no one in the way, the same publish replaces our own file.
    writeFileSync(log.markdownPath, `${WORKLOG_MARKER}\nold view\n`);
    expect(publishWorklog(log.markdownPath, `${WORKLOG_MARKER}\nnewer view\n`)).toBe(true);
    expect(readFileSync(log.markdownPath, "utf8")).toBe(`${WORKLOG_MARKER}\nnewer view\n`);
  } finally {
    state.done();
  }
});

test("concurrent CLI adds from separate processes lose no item, in the record or in worklog.md", async () => {
  // Given an empty state dir and 12 processes adding at once.
  const state = withState();
  try {
    const invoke = cliIn(state.dir);
    const count = 12;
    const results = await Promise.all(
      Array.from({ length: count }, (_, i) => invoke("worklog", "add", `request ${i}`, "--source", `slack:D1/9.${i}`)),
    );
    // Then every process succeeded, every item is in the record once, and the last render holds all of them.
    expect(results.map((r) => [r.code, r.err])).toEqual(Array.from({ length: count }, () => [0, ""]));
    const ids = results.map((r) => (JSON.parse(r.out) as { id: string }).id);
    const log = new Worklog(state.dir);
    const read = log.read();
    expect(read.problems).toEqual([]);
    expect(read.items.map((item) => item.id).sort()).toEqual([...ids].sort());
    expect(new Set(ids).size).toBe(count);
    const markdown = readFileSync(log.markdownPath, "utf8");
    for (const id of ids) expect(markdown).toContain(`### ${id} request `);
  } finally {
    state.done();
  }
});
