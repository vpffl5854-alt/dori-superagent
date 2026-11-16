import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { backlogAdd, backlogDecide, backlogDrop, backlogImport, importId } from "../src/backlog.ts";
import { Refusal } from "../src/refusal.ts";
import { HOUR, loopTick } from "../src/loop.ts";
import { setup } from "./loop-setup.ts";

describe("backlog", () => {
  test("add validates, copies the brief, and decide/drop change what the loop may start", async () => {
    const { d, brief, add } = setup();
    expect(() => backlogAdd(d, "Bad Id", brief)).toThrow(Refusal);
    for (const id of ["lead", "duty"]) {
      expect(() => backlogAdd(d, id, brief)).toThrow(`lane key "${id}" is reserved for the ${id} role`);
      expect(d.store.item(id)).toBeUndefined();
      expect(existsSync(d.store.itemBrief(id))).toBe(false);
    }
    expect(() => backlogAdd(d, "ok-id", brief, { priority: 0 })).toThrow("--priority");
    expect(() => backlogAdd(d, "ok-id", brief, { priority: 10 })).toThrow("--priority");
    expect(() => backlogAdd(d, "ok-id", join(d.store.root, "missing.md"))).toThrow("no brief");
    const item = add("ok-id");
    expect(item).toMatchObject({ status: "open", priority: 5, attempts: 0 });
    expect(readFileSync(item.brief, "utf8")).toBe("Do the thing.");
    expect(() => add("ok-id")).toThrow("already open");

    add("needs-q", { decision: "ship to all users?" });
    backlogDecide(d, "needs-q", "yes, behind a flag");
    const decided = d.store.item("needs-q")!;
    expect(decided.decision).toBeUndefined();
    expect(readFileSync(decided.brief, "utf8")).toContain("yes, behind a flag");

    backlogDrop(d, "ok-id", "not needed");
    expect(d.store.item("ok-id")!.status).toBe("dropped");
    const run = await loopTick(d);
    expect(run.started).toEqual(["needs-q (p5)"]);
  });

  test("import turns labelled issues into items once, with priority and decision labels", async () => {
    const { w, d } = setup();
    w.gh = (argv) =>
      argv[1] === "list"
        ? {
            code: 0,
            stdout: JSON.stringify([
              { number: 12, title: "Fix login", body: "steps", labels: [{ name: "dori" }, { name: "p1" }] },
              { number: 13, title: "New billing", body: "", labels: [{ name: "dori" }, { name: "needs-decision" }] },
            ]),
          }
        : { code: 0, stdout: JSON.stringify({ state: argv[2] === "12" ? "CLOSED" : "OPEN" }) };
    expect(await backlogImport(d, "acme/web-app", "dori", d.store.root)).toEqual({
      added: ["web-app-12", "web-app-13"],
      capped: false,
    });
    expect(d.store.item("web-app-12")).toMatchObject({ priority: 1, source: "acme/web-app#12" });
    expect(readFileSync(d.store.item("web-app-12")!.brief, "utf8")).toContain("issues/12");
    expect(d.store.item("web-app-13")!.decision).toContain("needs-decision");
    expect(await backlogImport(d, "acme/web-app", "dori", d.store.root)).toEqual({ added: [], capped: false });
    await expect(backlogImport(d, "other/web-app", "dori", d.store.root)).rejects.toThrow(
      "already used by acme/web-app#12",
    );
    const run = await loopTick(d);
    expect(run.synced).toEqual(["web-app-12 dropped (acme/web-app#12 closed)"]);
    expect(run.started).toEqual([]);
    expect(run.asked[0]).toStartWith("[DECIDE web-app-13]");
  });
});

describe("hardening", () => {
  test("ids from the CLI cannot leave the backlog directory, and long imported ids stay valid and distinct", async () => {
    const { d } = setup();
    expect(() => backlogDecide(d, "../lanes/x", "yes")).toThrow(Refusal);
    expect(() => backlogDrop(d, "../../etc", "x")).toThrow(Refusal);
    const a = importId("acme/a-very-long-repository-name-that-keeps-going", 12345);
    const b = importId("other/a-very-long-repository-name-that-keeps-going", 12345);
    expect(a).toMatch(/^[a-z][a-z0-9-]{1,40}$/);
    expect(a).not.toBe(b);
    expect(importId("acme/web-app", 7)).toBe("web-app-7");
  });

  test("a running item whose lane record vanished is reopened, not marked done", async () => {
    const { d, add, tick } = setup();
    add("ghost");
    await tick();
    rmSync(join(d.store.root, "lanes", "ghost.json"));
    const run = await tick();
    expect(run.synced[0]).toBe("ghost reopened (lane record missing, attempt 1)");
    expect(d.store.item("ghost")!.status).not.toBe("done");
  });

  test("lost lanes and failed starts are counted apart, so a question never states a mixed count", async () => {
    const { w, d, add } = setup();
    add("mixed");
    await loopTick(d, { force: true });
    const lane = d.store.lane("mixed")!;
    lane.status = "lost";
    d.store.saveLane(lane);
    rmSync(d.store.item("mixed")!.brief);
    w.clock += HOUR;
    const run = await loopTick(d);
    expect(run.synced[0]).toBe("mixed reopened (lane lost, attempt 1)");
    expect(run.findings[0]).toStartWith("start mixed failed");
    expect(d.store.item("mixed")).toMatchObject({ attempts: 1, startFailures: 1 });
    expect(d.store.item("mixed")!.decision).toBeUndefined();
  });
});
