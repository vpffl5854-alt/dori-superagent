import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { Refusal } from "../src/refusal.ts";
import { done, ready, startLane } from "../src/lanes.ts";
import { href } from "./fake.ts";
import { setup } from "./harness-setup.ts";

describe("lanes", () => {
  test("start opens a tab, launches omo with the brief, and tells the lead", async () => {
    const { w, d, lead, brief } = setup();
    const lane = await startLane(d, "fix-login", brief, { group: "w1" });
    const pane = w.panes.get(lane.paneId)!;
    expect(pane.ran[0]).toStartWith("omo 'Read your brief at ");
    expect(await Bun.file(lane.brief).text()).toContain("dori ready fix-login --text");
    expect(lead.received).toEqual([`[START fix-login] lane opened in ${lane.paneId}`]);
    await expect(startLane(d, "fix-login", brief, { group: "w1" })).rejects.toThrow(Refusal);
  });

  test("start refuses the role names lead and duty as lane keys before it writes or opens anything", async () => {
    const { w, d, lead, brief } = setup();
    for (const key of ["lead", "duty"]) {
      await expect(startLane(d, key, brief, { group: "w1" })).rejects.toThrow(
        `lane key "${key}" is reserved for the ${key} role`,
      );
      expect(d.store.lane(key)).toBeUndefined();
      expect(existsSync(d.store.briefPath(key))).toBe(false);
    }
    expect(w.calls).toEqual([]);
    expect(lead.received).toEqual([]);
    expect(d.store.roles().lead).toEqual(href("w1:p1"));
  });

  test("ready requires evidence, then reaches the lead; done closes only a ready lane", async () => {
    const { w, d, lead, brief } = setup();
    const lane = await startLane(d, "fix-login", brief, { group: "w1" });
    await expect(done(d, "fix-login")).rejects.toThrow("not ready");
    await expect(ready(d, "fix-login", "fixed", [])).rejects.toThrow("evidence");
    await ready(d, "fix-login", "fixed", ["https://github.com/o/r/pull/1"]);
    expect(lead.received.at(-1)).toBe("[READY fix-login] fixed\nevidence: https://github.com/o/r/pull/1");
    expect(w.usage.map((e) => e.name)).toEqual(["dori.lane_started", "dori.lane_ready"]);
    expect(JSON.stringify(w.usage)).not.toContain("fix-login");
    await done(d, "fix-login");
    expect(w.panes.has(lane.paneId)).toBe(false);
    expect(d.store.lane("fix-login")!.status).toBe("done");
  });
});

describe("startLane group fallback", () => {
  const withEnv = async (vars: Record<string, string | undefined>, run: () => Promise<void>) => {
    const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
    for (const [k, v] of Object.entries(vars))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    try {
      await run();
    } finally {
      for (const [k, v] of Object.entries(saved))
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
  };
  const clear = { HERDR_PANE_ID: undefined, HERDR_WORKSPACE_ID: undefined, HC_TERMINAL_ID: undefined };

  test("herdr with no group and no caller session: workspace create, tab create in it, pane run", async () => {
    const { w, d, brief } = setup();
    await withEnv(clear, async () => {
      await startLane(d, "no-group", brief);
    });
    const opening = ["workspace create", "tab create", "pane run"];
    const verbs = w.calls.filter((c) => c.cmd === "herdr").map((c) => c.argv.slice(0, 2).join(" "));
    expect(verbs.filter((v) => opening.includes(v))).toEqual(opening);
    const tab = w.calls.find((c) => c.cmd === "herdr" && c.argv[0] === "tab")!;
    expect(tab.argv).toContain("--workspace");
  });

  test("an hc lane gets this home's group label, never the caller's herdr workspace id", async () => {
    const { w, d, brief } = setup({ runtime: "hc" });
    await withEnv({ ...clear, HERDR_PANE_ID: "w9:p9", HERDR_WORKSPACE_ID: "w9" }, async () => {
      await startLane(d, "hc-lane", brief);
    });
    const run = w.hc.calls.find((args) => args[0] === "run")!;
    expect(run).toBeDefined();
    const group = run.find((a) => a.startsWith("dori.group="))!;
    expect(group).toMatch(/^dori\.group=[0-9a-f]{8}$/);
    expect(run.join(" ")).not.toContain("w9");
  });
});
