import { describe, expect, test } from "bun:test";
import type { Exec, ExecResult } from "../src/runtime/exec.ts";
import { closeTab, keepAsTab } from "../src/runtime/hc/app.ts";

const ok = (stdout: unknown): ExecResult => ({ code: 0, stdout: JSON.stringify(stdout), stderr: "" });
const appLs = (...tabs: { id: string; terminals: string[] }[]) =>
  ok({
    spaces: [
      { id: "sp1", tabs: tabs.map((t) => ({ id: t.id, terminals: t.terminals.map((terminal) => ({ terminal })) })) },
    ],
  });

function app(answers: (argv: readonly string[]) => ExecResult) {
  const calls: string[][] = [];
  const exec: Exec = async (cmd, argv) => {
    calls.push([cmd, ...argv]);
    return answers(argv);
  };
  return { calls, exec };
}

const lines: string[] = [];
const log = (line: string) => void lines.push(line);

describe("herdr app tabs for hc terminals", () => {
  test("keepAsTab runs terminal.keep for the terminal", async () => {
    const { calls, exec } = app(() => ok({}));
    await keepAsTab(exec, "t7", log);
    expect(calls).toEqual([["herdr-app", "do", "terminal.keep", "--terminal", "t7"]]);
  });

  test("keepAsTab selects the anchor's space first, so the tab does not land in the space on screen", async () => {
    const { calls, exec } = app((argv) =>
      argv[0] === "ls" && argv[1] === undefined
        ? ok({
            spaces: [
              { id: "spLead", tabs: [{ id: "tb1", terminals: [{ terminal: "t1t" }] }] },
              { id: "spOther", tabs: [{ id: "tb2", terminals: [{ terminal: "t20" }] }] },
            ],
          })
        : ok({}),
    );
    await keepAsTab(exec, "t9", log, "t1t");
    expect(calls).toEqual([
      ["herdr-app", "ls"],
      ["herdr-app", "do", "space.select", "--id", "spLead"],
      ["herdr-app", "do", "terminal.keep", "--terminal", "t9"],
    ]);
  });

  test("keepAsTab keeps the tab as before when the anchor is in no space", async () => {
    const { calls, exec } = app(() => appLs({ id: "tb1", terminals: ["t1"] }));
    await keepAsTab(exec, "t7", log, "t99");
    expect(calls).toEqual([
      ["herdr-app", "ls"],
      ["herdr-app", "do", "terminal.keep", "--terminal", "t7"],
    ]);
  });

  test("keepAsTab logs a refused command and does not throw", async () => {
    const { exec } = app(() => ({ code: 1, stdout: "", stderr: "no window is open" }));
    await keepAsTab(exec, "t7", log);
    expect(lines.at(-1)).toContain("t7");
    expect(lines.at(-1)).toContain("no window is open");
  });

  test("keepAsTab logs a missing app and does not throw", async () => {
    const exec: Exec = async () => {
      throw new Error("spawn herdr-app ENOENT");
    };
    await keepAsTab(exec, "t7", log);
    expect(lines.at(-1)).toContain("ENOENT");
  });

  test("closeTab closes the tab holding the terminal, and only that tab", async () => {
    const { calls, exec } = app((argv) =>
      argv[0] === "ls" && argv[1] !== "tab.close"
        ? appLs({ id: "tb1", terminals: ["t1"] }, { id: "tb7", terminals: ["t6", "t7"] })
        : ok({ closed: "tb7" }),
    );
    await closeTab(exec, "t7", log);
    expect(calls).toEqual([
      ["herdr-app", "ls"],
      ["herdr-app", "do", "tab.close", "--id", "tb7"],
    ]);
  });

  test("closeTab closes nothing when no tab holds the terminal", async () => {
    const { calls, exec } = app(() => appLs({ id: "tb1", terminals: ["t1"] }));
    await closeTab(exec, "t7", log);
    expect(calls).toEqual([["herdr-app", "ls"]]);
  });

  test("closeTab passes over a missing app or a failed ls", async () => {
    const missing: Exec = async () => {
      throw new Error("spawn herdr-app ENOENT");
    };
    const before = lines.length;
    await closeTab(missing, "t7", log);
    const { exec } = app(() => ({ code: 2, stdout: "", stderr: "usage" }));
    await closeTab(exec, "t7", log);
    expect(lines.slice(before).filter((l) => l.includes("t7"))).toHaveLength(2);
  });
});
