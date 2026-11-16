import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { shq } from "../src/delivery.ts";
import { spawnExec } from "../src/runtime/exec.ts";

// Real herdr, isolated named session, fake agent instead of a model: proves the pane plumbing end to end.
const herdrBin = Bun.which("herdr");
const session = `dori-e2e-${process.pid}`;
const home = mkdtempSync(join(tmpdir(), "dori-e2e-"));
const cli = resolve(import.meta.dir, "../src/cli.ts");
// Pinned to herdr, and outside any session of the host's own runtimes, so the lane opens in the isolated session only.
const { HC_TERMINAL_ID: _hc, HERDR_PANE_ID: _pane, HERDR_WORKSPACE_ID: _ws, ...outer } = process.env;
const env = { ...outer, DORI_HOME: home, DORI_HERDR_SESSION: session, DORI_TELEMETRY: "0", DORI_RUNTIME: "herdr" };
let server: ReturnType<typeof Bun.spawn> | undefined;

const herdr = async (...argv: string[]) => {
  const r = await spawnExec("herdr", ["--session", session, ...argv]);
  if (r.code !== 0) throw new Error(r.stderr || r.stdout);
  return JSON.parse(r.stdout || "{}").result;
};
const dori = async (...argv: string[]) => {
  const p = Bun.spawn(["bun", cli, ...argv], { env, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`dori ${argv.join(" ")} -> ${code}: ${err}`);
  return out;
};
const until = async <T>(what: string, probe: () => Promise<T | undefined>, ms = 20_000): Promise<T> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = await probe().catch(() => undefined);
    if (v !== undefined) return v;
    await Bun.sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
};
// The lead here is `cat`, which herdr does not recognise as an agent: a bare shell pane. Messages for it must stay in its
// inbox and never be typed into it (#66).
const leadInbox = (lead: string) => Bun.file(join(home, "inbox", `${lead.replaceAll(":", "_")}.jsonl`)).text();
const leadScreen = async (lead: string) =>
  (await spawnExec("herdr", ["--session", session, "pane", "read", lead, "--lines", "80", "--source", "recent"]))
    .stdout;

beforeAll(async () => {
  if (!herdrBin) return;
  server = Bun.spawn([herdrBin, "--session", session, "server"], { stdout: "ignore", stderr: "ignore" });
  await until("herdr server", () => herdr("workspace", "list"));
});

afterAll(async () => {
  if (!herdrBin) return;
  await spawnExec("herdr", ["--session", session, "server", "stop"]);
  await server?.exited;
  await spawnExec("herdr", ["session", "delete", session]);
});

test.skipIf(!herdrBin)(
  "a lane started in real herdr reports and finishes; the lead pane has no agent, so both wait in its inbox",
  async () => {
    const ws = await herdr("workspace", "create", "--label", "e2e", "--cwd", home, "--no-focus");
    const lead = ws.root_pane.pane_id as string;
    await herdr("pane", "run", lead, "cat");
    await dori("role", "lead", lead);
    const brief = join(home, "brief.md");
    writeFileSync(brief, "E2E-BRIEF say hello\n");

    const fake = resolve(import.meta.dir, "fixtures/fake-agent.sh");
    const doriCmd = `DORI_HOME=${shq(home)} DORI_HERDR_SESSION=${session} DORI_TELEMETRY=0 bun ${shq(cli)}`;
    const started = Bun.spawn(
      ["bun", cli, "start", "e2e-lane", "--brief", brief, "--workspace", ws.workspace.workspace_id],
      {
        env: { ...env, DORI_AGENT_CMD: `DORI_E2E_CMD=${shq(doriCmd)} ${shq(fake)}`, DORI_CMD: doriCmd },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(await started.exited).toBe(0);

    const leadText = await until("READY in the lead inbox", async () => {
      const text = await leadInbox(lead);
      return text.includes("[READY e2e-lane]") ? text : undefined;
    });
    expect(await leadScreen(lead)).not.toContain("e2e-lane");
    expect(leadText).toContain("[START e2e-lane]");
    expect(leadText).toContain("[REPORT e2e-lane] read brief: E2E-BRIEF say hello");
    expect(leadText).toContain("[READY e2e-lane] e2e lane finished");
    expect(await dori("status")).toMatch(/e2e-lane\s+ready/);
    expect(await dori("done", "e2e-lane")).toContain("DONE e2e-lane");
  },
  60_000,
);

test.skipIf(!herdrBin)(
  "the hourly loop starts a backlog item as a lane in real herdr and reports the run to the lead",
  async () => {
    const ws = await herdr("workspace", "create", "--label", "e2e-loop", "--cwd", home, "--no-focus");
    const lead = ws.root_pane.pane_id as string;
    await herdr("pane", "run", lead, "cat");
    await dori("role", "lead", lead);
    const brief = join(home, "loop-brief.md");
    writeFileSync(brief, "E2E-LOOP-BRIEF\n");
    expect(await dori("backlog", "add", "loop-item", "--brief", brief, "--cwd", home, "--priority", "2")).toContain(
      "ADDED loop-item p2",
    );

    const fake = resolve(import.meta.dir, "fixtures/fake-agent.sh");
    const doriCmd = `DORI_HOME=${shq(home)} DORI_HERDR_SESSION=${session} DORI_TELEMETRY=0 bun ${shq(cli)}`;
    const loop = Bun.spawn(["bun", cli, "loop", "--once", "--max-lanes", "5", "--max-load", "100000"], {
      env: {
        ...env,
        HERDR_WORKSPACE_ID: ws.workspace.workspace_id,
        DORI_AGENT_CMD: `DORI_E2E_CMD=${shq(doriCmd)} ${shq(fake)}`,
        DORI_CMD: doriCmd,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await loop.exited).toBe(0);
    expect(await new Response(loop.stdout).text()).toContain("LOOP started=1");

    const leadText = await until("READY from the loop-started lane in the lead inbox", async () => {
      const text = await leadInbox(lead);
      return text.includes("[READY loop-item]") ? text : undefined;
    });
    expect(await leadScreen(lead)).not.toContain("loop-item");
    expect(leadText).toContain("[START loop-item]");
    expect(leadText).toContain("[LOOP ");
    expect(leadText).toContain("started: loop-item (p2)");
    expect(await dori("backlog", "list")).toMatch(/loop-item\s+running/);
    expect(await dori("loop", "status")).toContain("started: loop-item (p2)");
    expect(await dori("loop", "stop", "--text", "e2e pause")).toContain("LOOP STOPPED");
    expect(await dori("loop", "--once")).toContain("LOOP skipped: stopped: e2e pause");
    expect(await dori("done", "loop-item")).toContain("DONE loop-item");
  },
  60_000,
);
