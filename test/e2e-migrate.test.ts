import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { shq } from "../src/delivery.ts";

// Real herdr (isolated named session) and real hc (isolated core, own HC_SESSION and XDG dirs), stand-in agents instead
// of a model: a lane opened on herdr is migrated to hc and ends with one labelled hc terminal.
const both = Bun.which("herdr") !== null && Bun.which("hc") !== null;
// Short names: herdr keeps its socket under XDG_CONFIG_HOME, and a long temp dir overflows sun_path (108 bytes).
const session = `dm-${process.pid}`;
const root = mkdtempSync(join(tmpdir(), "dm-"));
const home = join(root, "home");
const [state, run, config] = [join(root, "s"), join(root, "r"), join(root, "c")];
const cli = resolve(import.meta.dir, "../src/cli.ts");
const {
  HC_TERMINAL_ID: _id,
  HC_TERMINAL_SOCKET: _sock,
  HC_SOCKET: _hcSock,
  HERDR_PANE_ID: _pane,
  HERDR_WORKSPACE_ID: _ws,
  DORI_CMD: _cmd,
  ...outer
} = process.env;
const env = {
  ...outer,
  HC_SESSION: session,
  XDG_STATE_HOME: state,
  XDG_RUNTIME_DIR: run,
  XDG_CONFIG_HOME: config,
  DORI_HOME: home,
  DORI_HERDR_SESSION: session,
  DORI_TELEMETRY: "0",
};
// The hc stand-in reports its status the way hc reads it (OSC 7501), idle at start, and echoes what it reads.
const agent7501 = join(root, "agent-7501.sh");
let herdrServer: ReturnType<typeof Bun.spawn> | undefined;
let corePid: number | undefined;

const exec = async (argv: string[], extra: Record<string, string> = {}) => {
  const p = Bun.spawn(argv, { env: { ...env, ...extra }, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, code };
};
const json = async (argv: string[]) => {
  const r = await exec(argv);
  if (r.code !== 0) throw new Error(`${argv.join(" ")} -> ${r.code}: ${r.err || r.out}`);
  return JSON.parse(r.out || "{}") as Record<string, unknown>;
};
const herdr = async (...argv: string[]) => (await json(["herdr", "--session", session, ...argv]))["result"] as never;
const hc = (...argv: string[]) => json(["hc", "--json", ...argv]);
const dori = async (extra: Record<string, string>, ...argv: string[]) => {
  const r = await exec(["bun", cli, ...argv], extra);
  if (r.code !== 0) throw new Error(`dori ${argv.join(" ")} -> ${r.code}: ${r.err}${r.out}`);
  return r.out;
};
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function until<T>(what: string, probe: () => Promise<T | undefined>, ms = 30_000): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = await probe().catch(() => undefined);
    if (v !== undefined) return v;
    await Bun.sleep(200);
  }
  throw new Error(`timed out waiting for ${what}`);
}

beforeAll(async () => {
  if (!both) return;
  for (const dir of [home, state, run, join(config, "herdr-core")]) mkdirSync(dir, { recursive: true });
  chmodSync(run, 0o700);
  writeFileSync(join(config, "herdr-core", "config.toml"), "notes = false\n");
  writeFileSync(
    agent7501,
    `report() { printf '\\033]7501;state=%s:app=fake\\033\\\\' "$1"; }\nreport idle\nwhile IFS= read -r line; do printf 'echo: %s\\n' "$line"; done\n`,
  );
  herdrServer = Bun.spawn(["herdr", "--session", session, "server"], { env, stdout: "ignore", stderr: "ignore" });
  await until("herdr server", () => herdr("workspace", "list"));
  const started = await exec(["hc", "--json", "server", "start"]);
  if (started.code !== 0) throw new Error(`hc server start -> ${started.code}: ${started.err}`);
  corePid = Number((await hc("server", "status"))["pid"]);
}, 60_000);

afterAll(async () => {
  if (!both) return;
  await exec(["herdr", "--session", session, "server", "stop"]);
  await herdrServer?.exited;
  await exec(["herdr", "session", "delete", session]);
  await exec(["hc", "--json", "server", "stop"]);
  const pid = corePid;
  if (pid !== undefined) await until("the hc core to exit", async () => (alive(pid) ? undefined : true), 10_000);
  expect(pid !== undefined && alive(pid)).toBe(false);
  expect(existsSync(join(run, "herdr-core", `${session}.sock`))).toBe(false);
  rmSync(root, { recursive: true, force: true });
}, 60_000);

test.skipIf(!both)(
  "a herdr lane migrated with --to hc ends MIGRATED with one hc terminal labelled dori.lane=mk",
  async () => {
    const ws = (await herdr("workspace", "create", "--label", "e2e", "--cwd", home, "--no-focus")) as {
      root_pane: { pane_id: string };
      workspace: { workspace_id: string };
    };
    const lead = ws.root_pane.pane_id;
    await herdr("pane", "run", lead, "cat");
    await dori({}, "role", "lead", lead);
    const brief = join(root, "brief.md");
    writeFileSync(brief, "E2E-MIGRATE-BRIEF\n");
    const onHerdr = { DORI_RUNTIME: "herdr", DORI_AGENT_CMD: "sh -c 'exec cat' lane" };
    const started = await dori(
      onHerdr,
      "start",
      "mk",
      "--brief",
      brief,
      "--cwd",
      home,
      "--workspace",
      ws.workspace.workspace_id,
    );
    const oldPane = /STARTED mk pane=(\S+)/.exec(started)?.[1] ?? "";
    expect(oldPane).not.toBe("");

    const onHc = { DORI_RUNTIME: "hc", DORI_AGENT_CMD: `sh -c '. "$0"' ${shq(agent7501)}` };
    const out = await dori(onHc, "migrate", "--to", "hc", "--lane", "mk", "--wait-minutes", "0");
    const moved = new RegExp(`^MIGRATED mk ${oldPane} -> hc:(t\\d+)$`, "m").exec(out);
    expect(moved).not.toBeNull();
    const rows = ((await hc("ls", "--label", "dori.lane=mk"))["terminals"] ?? []) as { address: string }[];
    expect(rows.map((r) => r.address)).toEqual([moved?.[1] ?? ""]);
    expect(await dori({}, "status")).toMatch(new RegExp(`mk\\s+working\\s+hc\\s+hc:${moved?.[1]}`));
    await until("the old herdr pane to close", async () => {
      const r = await exec(["herdr", "--session", session, "pane", "get", oldPane]);
      return r.code !== 0 ? true : undefined;
    });
    expect(existsSync(join(home, "migrate", "mk.json"))).toBe(false);
  },
  120_000,
);
