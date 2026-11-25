/**
 * The hand: OmO's desktop engine (senpi-desktop-engine, JSON-RPC 2.0 over NDJSON on stdio), started per task. The
 * session opens with action reports on and the engine's own pause while the user types in the target app; input
 * is refused until the stop chord (ctrl+alt+shift+escape) is armed, so every task arms it first.
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

export type RpcError = { readonly code: number; readonly message: string; readonly data?: { code?: string } };
export type Reply = { readonly result?: unknown; readonly error?: RpcError };
export type Engine = {
  readonly call: (method: string, params?: Record<string, unknown>) => Promise<Reply>;
  readonly close: () => Promise<void>;
};
export type Caps = {
  readonly capture: boolean;
  readonly input: boolean;
  readonly ax: boolean;
  readonly screenLocked: boolean;
  readonly displayAsleep: boolean;
};

export const STOP_CHORD = "ctrl+alt+shift+escape";
const CALL_MS = 30_000;

/** The newest engine OmO installed (~/.omo/binary-runtime/<version>/…), unless config names one. */
export const enginePath = (configured: string | undefined, home = process.env["HOME"] ?? ""): string | undefined => {
  if (configured) return existsSync(configured) ? configured : undefined;
  const root = join(home, ".omo", "binary-runtime");
  if (!existsSync(root)) return undefined;
  const num = (v: string): number[] => v.split(".").map((x) => Number(x) || 0);
  const newer = (a: string, b: string): number => {
    const [x, y] = [num(a), num(b)];
    for (let i = 0; i < Math.max(x.length, y.length); i++)
      if ((x[i] ?? 0) !== (y[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0);
    return 0;
  };
  for (const v of readdirSync(root).sort(newer)) {
    const p = join(root, v, "native", "prebuilds", "darwin-arm64", "senpi-desktop-engine");
    if (existsSync(p)) return p;
  }
  return undefined;
};

/** Starts the engine and opens a session with the stop chord armed; throws when the engine cannot take input. */
export const openEngine = async (path: string): Promise<{ engine: Engine; caps: Caps }> => {
  const p = spawn(path, ["--stdio"], { stdio: ["pipe", "pipe", "ignore"] });
  const waiting = new Map<number, (r: Reply) => void>();
  createInterface({ input: p.stdout }).on("line", (line) => {
    try {
      const m = JSON.parse(line) as Reply & { id?: number };
      if (typeof m.id === "number") waiting.get(m.id)?.(m);
      if (typeof m.id === "number") waiting.delete(m.id);
    } catch {}
  });
  p.on("exit", () => {
    for (const r of waiting.values()) r({ error: { code: -1, message: "engine exited" } });
    waiting.clear();
  });
  let next = 0;
  const call = (method: string, params: Record<string, unknown> = {}): Promise<Reply> =>
    new Promise((resolve) => {
      const id = ++next;
      const timer = setTimeout(() => {
        waiting.delete(id);
        resolve({ error: { code: -2, message: `${method} timed out` } });
      }, CALL_MS);
      waiting.set(id, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      p.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  const close = async (): Promise<void> => {
    await call("session.close").catch(() => undefined);
    p.stdin.end();
    p.kill();
  };
  const hello = await call("engine.hello");
  const open = await call("session.open", { reportMode: "object", intervention: "pause" });
  const caps = (open.result as { capabilities?: Caps } | undefined)?.capabilities;
  if (hello.error || !caps) {
    await close();
    throw new Error(`engine did not open: ${(hello.error ?? open.error)?.message ?? "no capabilities"}`);
  }
  const stop = await call("stopPath.start", { chord: STOP_CHORD });
  if (stop.error) {
    await close();
    throw new Error(`stop chord not armed: ${stop.error.message}`);
  }
  return { engine: { call, close }, caps };
};
