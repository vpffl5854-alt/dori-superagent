import { expect } from "bun:test";
import type { Exec, ExecResult } from "../src/runtime/exec.ts";
import { HerdrRuntime } from "../src/runtime/herdr/index.ts";
import type { SessionRef } from "../src/runtime/types.ts";
import { World } from "./fake.ts";

// A recorder in place of the herdr binary: every argv is kept, and each reply is chosen per call.
export function recorder(reply: (argv: readonly string[]) => ExecResult = () => ok({})) {
  const calls: (readonly string[])[] = [];
  const exec: Exec = async (cmd, argv) => {
    expect(cmd).toBe("herdr");
    calls.push(argv);
    return reply(argv);
  };
  return { calls, exec };
}
export const ok = (result: unknown): ExecResult => ({ code: 0, stdout: JSON.stringify({ result }), stderr: "" });
export const fail = (stderr: string, stdout = ""): ExecResult => ({ code: 1, stdout, stderr });
export const ref = (id: string, group?: string, container?: string): SessionRef => ({
  runtime: "herdr",
  id,
  ...(group !== undefined ? { group } : {}),
  ...(container !== undefined ? { container } : {}),
});
export const omoFront = { process_info: { foreground_processes: [{ name: "omo", argv: ["omo"] }] } };
// The World recorder from test/fake.ts, with the paste settle recorded instead of slept.
export function world() {
  const w = new World();
  const sleeps: number[] = [];
  const rt = new HerdrRuntime(w.exec, "", { env: {}, sleep: async (ms) => void sleeps.push(ms) });
  return { w, rt, sleeps, herdr: () => w.calls.filter((c) => c.cmd === "herdr").map((c) => c.argv) };
}
