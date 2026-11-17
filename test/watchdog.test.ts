import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/cli.ts";
import { dutyTick } from "../src/duty.ts";
import { report, startLane } from "../src/lanes.ts";
import { setup } from "./harness-setup.ts";

const MIN = 60_000;

describe("duty watchdog", () => {
  test("closes a lane past 1.5x its budget, backs it up, and tells the lead once", async () => {
    const { w, d, lead, brief } = setup();
    const lane = await startLane(d, "slow-lane", brief, { group: "w1", budgetMin: 10 });
    expect(d.store.lane("slow-lane")?.budgetMin).toBe(10);
    w.panes.get(lane.paneId)!.status = "working";
    w.clock = lane.createdAt + 14 * MIN;
    expect((await dutyTick(d)).filter((e) => e.lane === "slow-lane")).toEqual([]);
    w.clock = lane.createdAt + 16 * MIN;
    const events = await dutyTick(d);
    expect(events).toContainEqual({
      lane: "slow-lane",
      action: "watchdog-budget",
      detail: expect.stringContaining("[WATCHDOG] slow-lane"),
    });
    expect(w.panes.has(lane.paneId)).toBe(false);
    expect(lead.received.at(-1)).toContain("[WATCHDOG] slow-lane 시간 초과로 자동 종료(예산 10분 x1.5, 경과 16분)");
    const closed = d.store.lane("slow-lane");
    expect(closed?.status).toBe("lost");
    expect(closed?.watchdog?.rule).toBe("budget");
    const backup = closed?.watchdog && lead.received.at(-1)?.match(/백업 (\S+)/)?.[1];
    expect(backup).toContain(join(d.store.root, "backups", "watchdog-slow-lane-"));
    expect(await Bun.file(join(backup!, "slow-lane.md")).exists()).toBe(true);
    expect(await Bun.file(join(backup!, "lane.json")).exists()).toBe(true);
    w.clock += 60 * MIN;
    expect((await dutyTick(d)).filter((e) => e.lane === "slow-lane")).toEqual([]);
  });

  test("a READY lane is never closed for time", async () => {
    const { w, d, lead, brief } = setup();
    const lane = await startLane(d, "done-lane", brief, { group: "w1", budgetMin: 5 });
    await report(d, "done-lane", "finished", "waiting");
    w.panes.get(lane.paneId)!.status = "idle";
    w.panes.get(lane.paneId)!.screen = "";
    const waiting = d.store.lane("done-lane")!;
    w.clock = waiting.createdAt + 600 * MIN;
    const [stored] = d.store.lanes();
    expect([stored?.status, stored?.createdAt, w.clock]).toEqual(["waiting", 1_000_000, 1_000_000 + 600 * MIN]);
    expect((await dutyTick(d)).filter((e) => e.lane === "done-lane")).toEqual([]);
    expect(w.panes.has(lane.paneId)).toBe(true);
    expect(lead.received.some((m) => m.includes("[WATCHDOG]"))).toBe(false);
  });

  test("closes a lane looping on one scratch file and copies the files it touched", async () => {
    const { w, d, lead, brief } = setup();
    const cwd = mkdtempSync(join(tmpdir(), "dori-watch-lane-"));
    const lane = await startLane(d, "loop-lane", brief, { group: "w1", cwd });
    writeFileSync(join(cwd, "notes.txt"), "lane work\n");
    w.panes.get(lane.paneId)!.status = "working";
    w.panes.get(lane.paneId)!.screen = [
      "$ cat > /tmp/proxy-dbg.mjs <<'EOF'",
      "$ rm /tmp/proxy-dbg.mjs",
      "$ cat > /tmp/proxy-dbg.mjs <<'EOF'",
      "$ rm /tmp/proxy-dbg.mjs",
      "$ cat > /tmp/proxy-dbg.mjs <<'EOF'",
    ].join("\n");
    const events = await dutyTick(d);
    expect(events).toContainEqual({
      lane: "loop-lane",
      action: "watchdog-repeat",
      detail: expect.stringContaining("반복 작업 감지"),
    });
    expect(w.panes.has(lane.paneId)).toBe(false);
    const backup = lead.received.at(-1)?.match(/백업 (\S+)/)?.[1] ?? "";
    expect(await Bun.file(join(backup, "loop-lane.md")).exists()).toBe(true);
    expect(await Bun.file(join(backup, "lane.json")).exists()).toBe(true);
    expect(d.store.lane("loop-lane")?.watchdog?.rule).toBe("repeat");
  });

  test("closes a lane the repeat-guard keeps blocking, and leaves a lane with no blocks alone", async () => {
    const { w, d, lead, brief } = setup();
    const stuckCwd = mkdtempSync(join(tmpdir(), "dori-stuck-lane-"));
    const calmCwd = mkdtempSync(join(tmpdir(), "dori-calm-lane-"));
    const stuck = await startLane(d, "stuck-lane", brief, { group: "w1", cwd: stuckCwd });
    const calm = await startLane(d, "calm-lane", brief, { group: "w1", cwd: calmCwd });
    w.panes.get(stuck.paneId)!.status = "working";
    w.panes.get(calm.paneId)!.status = "working";
    mkdirSync(join(d.store.root, "logs"), { recursive: true });
    const line = (minAgo: number, target: string) =>
      JSON.stringify({ ts: new Date(w.clock - minAgo * MIN).toISOString(), verdict: "blocked", tool: "bash", target });
    const lines = [
      "{broken",
      line(1, `${stuckCwd}/mkdbg10.ts`),
      line(2, `${stuckCwd}/mkdbg11.ts`),
      line(3, `${calmCwd}/mkdbg12.ts`),
      line(4, "grep /tmp/x.log foo"),
      line(5, `${stuckCwd}/mkdbg13.ts`),
      line(6, `${stuckCwd}/mkdbg14.ts`),
    ];
    const log = join(d.store.root, "logs", "repeat-guard.log");
    writeFileSync(log, `${lines.join("\n")}\n`);
    expect((await dutyTick(d)).filter((e) => e.lane === "stuck-lane")).toEqual([]);
    writeFileSync(log, `${[...lines, line(7, `${stuckCwd}/mkdbg15.ts`)].join("\n")}\n`);
    const events = await dutyTick(d);
    expect(events).toContainEqual({
      lane: "stuck-lane",
      action: "watchdog-blocked",
      detail: expect.stringContaining("[WATCHDOG] stuck-lane repeat-guard 차단 반복으로 자동 종료(15분 안에 5건)"),
    });
    expect(events.filter((e) => e.lane === "calm-lane")).toEqual([]);
    expect(w.panes.has(stuck.paneId)).toBe(false);
    expect(w.panes.has(calm.paneId)).toBe(true);
    expect(lead.received.at(-1)).toContain("[WATCHDOG] stuck-lane");
    const closed = d.store.lane("stuck-lane");
    expect(closed?.status).toBe("lost");
    expect(closed?.watchdog?.rule).toBe("blocked");
    const backup = lead.received.at(-1)?.match(/백업 (\S+)/)?.[1] ?? "";
    expect(await Bun.file(join(backup, "stuck-lane.md")).exists()).toBe(true);
  });

  test("start refuses a budget that is not a positive number of minutes", async () => {
    const { w, d, brief } = setup();
    for (const budgetMin of [0, -5, Number.NaN])
      await expect(startLane(d, "bad-budget", brief, { group: "w1", budgetMin })).rejects.toThrow("--budget-min");
    expect(w.calls).toEqual([]);
    await expect(main(["start", "cli-budget", "--brief", brief, "--budget-min", "abc"], d)).rejects.toThrow(
      "--budget-min",
    );
  });
});
