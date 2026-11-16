import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Deps } from "../src/harness.ts";
import type { Exec } from "../src/runtime/exec.ts";
import { HcRuntime } from "../src/runtime/hc/index.ts";
import { HerdrRuntime } from "../src/runtime/herdr/index.ts";
import { Runtimes } from "../src/runtime/registry.ts";
import type { AgentStatus, RuntimeKind, SessionRef } from "../src/runtime/types.ts";
import { Store, type HostLoad } from "../src/store.ts";
import type { DutyCounts, TelemetryEvent, Usage } from "../src/telemetry.ts";
import { FakeHc } from "./fake-hc.ts";

/** A herdr pane ref, the form every herdr-world test addresses sessions by. */
export const href = (id: string): SessionRef => ({ runtime: "herdr", id });

/**
 * `screen` is what `pane read` returns; undefined makes the read fail. `agent` is the agent name `pane get` reports
 * (default "pi"), `pgid` the foreground process group `pane process-info` reports (default 101).
 */
type Pane = {
  status: AgentStatus;
  received: string[];
  ran: string[];
  screen?: string | undefined;
  foreground?: string | { name: string; argv: string[] }[] | undefined;
  agent?: string;
  pgid?: number;
};

export class World {
  panes = new Map<string, Pane>();
  /** The hc terminals, for deps({ runtime: "hc" }); its calls are recorded in `calls` too. */
  hc = new FakeHc();
  calls: { cmd: string; argv: readonly string[] }[] = [];
  clock = 1_000_000;
  host: HostLoad = { load1: 1, cores: 8, memFreePct: 50 };
  next = 1;
  /** pane id -> herdr error text returned by `agent prompt` (exit 1) */
  promptFails = new Map<string, string>();
  /** pane id -> called with the 1-based count of `pane get` calls for that pane, before it answers */
  getHook = new Map<string, (n: number) => void>();
  private gets = new Map<string, number>();
  /** `pane process-info` fails (exit 1) for every pane */
  processInfoFails = false;
  /** a command named `slow-hook` awaits this before answering (a hook that hangs) */
  hang: Promise<void> | undefined;
  /** called when a hanging `slow-hook` is killed; the killed hook then exits 143 */
  onHookKill: (() => void) | undefined;
  /** number of upcoming `pane send-keys` calls that fail (exit 1) */
  keyFails = 0;
  gh: (argv: readonly string[]) => { code: number; stdout: string } = () => ({ code: 1, stdout: "" });
  usage: TelemetryEvent[] = [];
  dutyCounts: DutyCounts[] = [];
  touches = 0;
  recorder: Usage = {
    touch: () => {
      this.touches++;
    },
    record: (e) => {
      this.usage.push(e);
    },
    duty: (c) => {
      this.dutyCounts.push(c);
    },
    flush: async () => {},
  };
  /** every command other than herdr, hc and gh: the reviewer, and lifecycle hooks */
  reviewer: (argv: readonly string[]) => { code: number; stdout: string; stderr?: string } = () => ({
    code: 0,
    stdout: "VERDICT: CLEAR",
  });

  addPane(id: string, status: AgentStatus = "idle"): Pane {
    const p = { status, received: [], ran: [] };
    this.panes.set(id, p);
    return p;
  }

  exec: Exec = async (cmd, argv, options) => {
    this.calls.push({ cmd, argv });
    if (cmd === "slow-hook" && this.hang) {
      let killed = false;
      const kill = new Promise<void>((resolve) =>
        options?.onSpawn?.({
          kill: () => {
            killed = true;
            this.onHookKill?.();
            resolve();
          },
        }),
      );
      await Promise.race([this.hang, kill]);
      if (killed) return { code: 143, stdout: "", stderr: "terminated" };
    }
    if (cmd === "gh") return { ...this.gh(argv), stderr: "" };
    if (cmd === "hc") return this.hc.exec(cmd, argv);
    if (cmd !== "herdr") return { stderr: "", ...this.reviewer(argv) };
    const ok = (result: unknown) => ({ code: 0, stdout: JSON.stringify({ result }), stderr: "" });
    const [group, verb, id] = argv;
    if (group === "pane" && verb === "process-info") {
      const target = this.panes.get(String(argv[3]));
      if (!target || this.processInfoFails) return { code: 1, stdout: "", stderr: "process-info failed" };
      const fg = target.foreground ?? (target.status === "shell" ? "-bash" : "omo");
      const procs = typeof fg === "string" ? [{ name: fg, argv: [fg] }] : fg;
      return ok({
        process_info: {
          pane_id: argv[3],
          shell_pid: 100,
          foreground_process_group_id: target.pgid ?? 101,
          foreground_processes: procs.map((x, i) => ({ ...x, pid: 101 + i })),
        },
      });
    }
    if ((group === "tab" || group === "workspace") && verb === "create") {
      const pane = `w1:p${++this.next}`;
      this.addPane(pane, "shell");
      return ok({ root_pane: { pane_id: pane, tab_id: `w1:t${this.next}`, workspace_id: "w1" } });
    }
    if (group === "pane" && verb === "split") {
      const pane = `w1:p${++this.next}`;
      this.addPane(pane, "shell");
      return ok({ pane: { pane_id: pane, tab_id: "w1:t1", workspace_id: "w1" } });
    }
    const pane = id ? this.panes.get(id) : undefined;
    if (!pane) return { code: 1, stdout: "", stderr: `pane_not_found ${id}` };
    if (group === "pane" && verb === "get") {
      const n = (this.gets.get(id!) ?? 0) + 1;
      this.gets.set(id!, n);
      this.getHook.get(id!)?.(n);
      return ok({
        pane: { pane_id: id, agent: pane.status === "shell" ? null : (pane.agent ?? "pi"), agent_status: pane.status },
      });
    }
    if (group === "pane" && verb === "read") {
      return pane.screen === undefined
        ? { code: 1, stdout: "", stderr: "read failed" }
        : { code: 0, stdout: pane.screen, stderr: "" };
    }
    if (group === "pane" && verb === "run") {
      pane.ran.push(String(argv[3]));
      return ok({});
    }
    if (group === "pane" && verb === "send-text") {
      pane.received.push(String(argv[3]));
      return ok({});
    }
    if (group === "pane" && verb === "send-keys") {
      if (this.keyFails > 0) {
        this.keyFails--;
        return { code: 1, stdout: "", stderr: "key press failed" };
      }
      return ok({});
    }
    if (group === "agent" && verb === "prompt") {
      const fail = this.promptFails.get(id!);
      if (fail) return { code: 1, stdout: "", stderr: fail };
      pane.received.push(String(argv[3]));
      return ok({});
    }
    if (group === "pane" && verb === "close") {
      this.panes.delete(id!);
      return ok({});
    }
    return { code: 1, stdout: "", stderr: `unhandled ${argv.join(" ")}` };
  };

  /** Deps over this world's recorders; `runtime` is the selected one (both are reachable by ref). */
  deps(opts: { runtime?: RuntimeKind } = {}): Deps {
    const kind = opts.runtime ?? "herdr";
    const quiet = { env: {}, sleep: async () => {} };
    return {
      store: new Store(mkdtempSync(join(tmpdir(), "dori-test-"))),
      runtimes: new Runtimes(kind, (k) =>
        k === "hc" ? new HcRuntime(this.exec, { ...quiet, log: () => {} }) : new HerdrRuntime(this.exec, "", quiet),
      ),
      choice: () => ({ kind, source: "config" }),
      exec: this.exec,
      now: () => this.clock,
      agentCmd: "omo",
      doriCmd: "dori",
      host: () => this.host,
      usage: this.recorder,
    };
  }
}
