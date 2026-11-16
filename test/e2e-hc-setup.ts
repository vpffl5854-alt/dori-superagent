import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { shq } from "../src/delivery.ts";
import { socketRootBase } from "./socket-budget.ts";

// One isolated hc core for the whole file: its own HC_SESSION and XDG dirs, so the host's own cores are never reached.
export const hcBin = Bun.which("hc");
export const session = `e2e-${process.pid}`;
// The core's sockets land under <root>/r/herdr-core/, so the root stays short: os.tmpdir() is used only while every
// socket hc creates fits; a long TMPDIR (some CI runners) falls back to /tmp.
const root = mkdtempSync(join(socketRootBase(tmpdir(), session), "dhc-"));
const [state, run, config] = [join(root, "s"), join(root, "r"), join(root, "c")];
const cli = resolve(import.meta.dir, "../src/cli.ts");
export const fixture = resolve(import.meta.dir, "fixtures/fake-agent-7501.sh");

// The caller's own runtime identity is dropped: inside a terminal of another core, dori would reach that core instead.
const {
  HC_TERMINAL_ID: _id,
  HC_TERMINAL_SOCKET: _sock,
  HC_SOCKET: _hcSock,
  HERDR_PANE_ID: _pane,
  HERDR_WORKSPACE_ID: _ws,
  DORI_CMD: _cmd,
  DORI_LANE: _lane,
  DORI_PROMPTS_DIR: _prompts,
  ...outer
} = process.env;
const hcEnv = { ...outer, HC_SESSION: session, XDG_STATE_HOME: state, XDG_RUNTIME_DIR: run, XDG_CONFIG_HOME: config };

/**
 * The env of every `dori` (and of the core, so its terminals inherit it). `sh -c '. "$0"' FILE` runs the fixture
 * without a script-runner shell in front: Dori holds deliveries to `sh FILE` as an interactive shell (#66).
 */
export const doriEnv = (home: string) => ({
  ...hcEnv,
  DORI_HOME: home,
  DORI_RUNTIME: "hc",
  DORI_TELEMETRY: "0",
  DORI_AGENT_CMD: `sh -c '. "$0"' ${shq(fixture)}`,
});

export const newHome = (name: string): string => {
  const home = join(root, name);
  mkdirSync(home, { recursive: true });
  return home;
};

const run2 = async (argv: string[], env: Record<string, string | undefined>) => {
  const p = Bun.spawn(argv, { env, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, code };
};

export async function hc(...argv: string[]): Promise<Record<string, unknown>> {
  const r = await run2(["hc", "--json", ...argv], hcEnv);
  if (r.code !== 0) throw new Error(`hc ${argv.join(" ")} -> ${r.code}: ${r.err || r.out}`);
  return JSON.parse(r.out || "{}");
}

export async function dori(home: string, ...argv: string[]): Promise<string> {
  const r = await run2(["bun", cli, ...argv], doriEnv(home));
  if (r.code !== 0) throw new Error(`dori ${argv.join(" ")} -> ${r.code}: ${r.err}${r.out}`);
  return r.out;
}

export async function until<T>(what: string, probe: () => Promise<T | undefined>, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const v = await probe();
      if (v !== undefined) return v;
    } catch (e) {
      last = e;
    }
    await Bun.sleep(200);
  }
  throw new Error(`timed out waiting for ${what}${last instanceof Error ? ` (last error: ${last.message})` : ""}`);
}

export const terminal = (address: string) => hc("get", address);
export const statusOf = (t: Record<string, unknown>): string | undefined =>
  (t["status"] as { state?: string } | null)?.state;
export const screen = async (address: string): Promise<string> => String((await hc("read", address))["text"] ?? "");
export const waitStatus = (address: string, word: string) =>
  until(`${address} ${word}`, async () => (statusOf(await terminal(address)) === word ? true : undefined));

let corePid: number | undefined;

export async function startCore(): Promise<void> {
  for (const dir of [state, run, join(config, "herdr-core")]) mkdirSync(dir, { recursive: true });
  chmodSync(run, 0o700);
  writeFileSync(join(config, "herdr-core", "config.toml"), "notes = false\n");
  // Started with the dori env so terminals opened by `dori` (loops included) inherit DORI_RUNTIME and the isolation.
  const r = await run2(["hc", "--json", "server", "start"], doriEnv(newHome("core")));
  if (r.code !== 0) throw new Error(`hc server start -> ${r.code}: ${r.err}`);
  corePid = Number((await hc("server", "status"))["pid"]);
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * Stops the core and proves it is gone: its pid exited and its socket was removed. `hc server status` cannot prove
 * that, since it starts a core when none answers.
 */
export async function stopCore(): Promise<{ pid: number | undefined; alive: boolean; socket: boolean }> {
  await run2(["hc", "--json", "server", "stop"], hcEnv);
  const pid = corePid;
  const sock = join(run, "herdr-core", `${session}.sock`);
  if (pid !== undefined) await until("the core to exit", async () => (alive(pid) ? undefined : true), 10_000);
  const result = { pid, alive: pid !== undefined && alive(pid), socket: existsSync(sock) };
  rmSync(root, { recursive: true, force: true });
  return result;
}
