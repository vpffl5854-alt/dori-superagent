import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { up } from "../src/cli-up.ts";
import { groupId } from "../src/runtime/group.ts";
import { World } from "./fake.ts";
import { captureIo } from "./inbox-setup.ts";

describe("dori up", () => {
  test("herdr: the same 8 calls as before runtimes existed, and all four roles registered", async () => {
    const w = new World();
    const d = w.deps();
    const root = d.store.root;
    const { out } = await captureIo(async () => {
      await up(d, "/w");
      return 0;
    });
    const prompt = (name: string) => `omo --append-system-prompt '${join(root, "prompts", name)}'`;
    const split = (near: string, ...env: string[]) => [
      "pane",
      "split",
      near,
      "--direction",
      "down",
      "--ratio",
      "0.3",
      "--cwd",
      "/w",
      "--no-focus",
      ...env.flatMap((e) => ["--env", e]),
    ];
    expect(w.calls.map((c) => [c.cmd, ...c.argv])).toEqual(
      [
        ["workspace", "create", "--label", "dori", "--cwd", "/w", "--no-focus"],
        ["pane", "run", "w1:p2", prompt("lead.md")],
        [
          "tab",
          "create",
          "--label",
          "duty",
          "--cwd",
          "/w",
          "--no-focus",
          "--workspace",
          "w1",
          "--env",
          `DORI_HOME=${root}`,
        ],
        ["pane", "run", "w1:p3", prompt("duty.md")],
        split("w1:p3", `DORI_HOME=${root}`),
        ["pane", "run", "w1:p4", "dori duty --interval 60"],
        split("w1:p4", `DORI_HOME=${root}`, "HERDR_WORKSPACE_ID=w1"),
        ["pane", "run", "w1:p5", "dori loop"],
      ].map((argv) => ["herdr", ...argv]),
    );
    expect(JSON.parse(readFileSync(join(root, "roles.json"), "utf8"))).toEqual({
      lead: "w1:p2",
      duty: "w1:p3",
      "duty-loop": "w1:p4",
      "hourly-loop": "w1:p5",
    });
    expect(out).toBe(`UP runtime=herdr lead=w1:p2 duty=w1:p3 loop=w1:p4 hourly=w1:p5 home=${root}`);
  });

  test("hc: four terminals in this home's group, prefixed roles, no herdr workspace variable", async () => {
    const w = new World();
    const d = w.deps({ runtime: "hc" });
    const { out } = await captureIo(async () => {
      await up(d, "/w");
      return 0;
    });
    const runs = w.calls.filter((c) => c.cmd === "hc" && c.argv[1] === "run").map((c) => c.argv);
    expect(runs).toHaveLength(4);
    for (const argv of runs) expect(argv).toContain(`dori.group=${groupId(d.store.root)}`);
    expect(runs.map((a) => a.find((x) => x.startsWith("dori.role=")))).toEqual([
      "dori.role=lead",
      "dori.role=duty",
      "dori.role=duty-loop",
      "dori.role=hourly-loop",
    ]);
    expect(runs.some((a) => a.some((x) => x.startsWith("HERDR_WORKSPACE_ID=")))).toBe(false);
    expect(w.calls.some((c) => c.cmd === "herdr")).toBe(false);
    expect(w.hc.calls.filter((c) => c[0] === "send").map((c) => c.at(-1))).toEqual([
      expect.stringContaining("lead.md"),
      expect.stringContaining("duty.md"),
      "dori duty --interval 60",
      "dori loop",
    ]);
    expect(JSON.parse(readFileSync(join(d.store.root, "roles.json"), "utf8"))).toEqual({
      lead: "hc:t1",
      duty: "hc:t2",
      "duty-loop": "hc:t3",
      "hourly-loop": "hc:t4",
    });
    expect(out).toStartWith("UP runtime=hc lead=hc:t1 duty=hc:t2 loop=hc:t3 hourly=hc:t4 ");
  });
});
