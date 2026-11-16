import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Telemetry } from "../src/telemetry.ts";
import { rejectedRecords } from "../src/telemetry-otlp.ts";

type Sent = { url: string; body: string; headers: Record<string, string> };

function rig(
  env: Record<string, string> = {},
  logsStatus: () => number = () => 200,
  registerStatus: () => number = () => 200,
  logsText: () => string = () => "",
) {
  const home = mkdtempSync(join(tmpdir(), "dori-tel-"));
  const sent: Sent[] = [];
  const notices: string[] = [];
  let clock = Date.parse("2026-11-02T10:00:00Z");
  let minted = 0;
  const t = new Telemetry(
    home,
    env,
    async (url, body, headers) => {
      sent.push({ url, body, headers });
      if (url.endsWith("/v1/register"))
        return { status: registerStatus(), text: JSON.stringify({ key: `install-key-${++minted}` }) };
      return { status: logsStatus(), text: logsText() };
    },
    () => clock,
    (s) => notices.push(s),
  );
  const logs = () => sent.filter((s) => s.url.endsWith("/v1/logs"));
  const registers = () => sent.filter((s) => s.url.endsWith("/v1/register"));
  const names = () =>
    logs().flatMap((s) =>
      JSON.parse(s.body).resourceLogs[0].scopeLogs[0].logRecords.map((r: { eventName: string }) => r.eventName),
    );
  return {
    home,
    t,
    sent,
    logs,
    registers,
    notices,
    names,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("telemetry", () => {
  test("records refused inside a 200 response (partialSuccess.rejectedLogRecords) are counted, not treated as delivered", async () => {
    let reply = JSON.stringify({ partialSuccess: { rejectedLogRecords: "2", errorMessage: "invalid_scope" } });
    const r = rig(
      {},
      () => 200,
      () => 200,
      () => reply,
    );
    r.t.touch();
    await r.t.flush(5000);
    const state = () => JSON.parse(readFileSync(join(r.home, "telemetry.json"), "utf8"));
    expect(state().rejected).toBe(2);
    reply = "{}";
    r.t.record({ name: "dori.lane_started", open_lanes: 1 });
    await r.t.flush(5000);
    expect(state().rejected).toBe(2);
    expect(rejectedRecords("not json")).toBe(0);
    expect(rejectedRecords(JSON.stringify({ partialSuccess: {} }))).toBe(0);
  });

  test("an offline first run keeps dori.installed and daily_active pending until a send succeeds", async () => {
    let online = false;
    const r = rig(
      {},
      () => 200,
      () => (online ? 200 : 503),
    );
    r.t.touch();
    await r.t.flush(5000);
    expect(r.names()).toEqual([]);
    online = true;
    r.t.touch();
    await r.t.flush(5000);
    expect(r.names()).toEqual(["dori.installed", "dori.daily_active"]);
    r.t.touch();
    await r.t.flush(5000);
    expect(r.names()).toHaveLength(2);
    expect(r.notices).toHaveLength(1);
  });

  test("the state file holding the key is private (0600), and a corrupt state file never throws", async () => {
    const r = rig();
    r.t.touch();
    await r.t.flush(5000);
    if (process.platform !== "win32") expect(statSync(join(r.home, "telemetry.json")).mode & 0o777).toBe(0o600);
    writeFileSync(join(r.home, "telemetry.json"), "{ not json");
    r.t.record({ name: "dori.lane_started", open_lanes: 1 });
    await r.t.flush(5000);
  });

  test("calls return at once and flush gives up at its deadline when the collector hangs", async () => {
    const home = mkdtempSync(join(tmpdir(), "dori-tel-"));
    const hung = new Telemetry(
      home,
      {},
      () => new Promise(() => {}),
      Date.now,
      () => {},
    );
    const started = Date.now();
    hung.touch();
    expect(Date.now() - started).toBeLessThan(50);
    await hung.flush(100);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test("first runs racing in separate processes on one home end up with a single install id", async () => {
    const home = mkdtempSync(join(tmpdir(), "dori-tel-"));
    const script = `const { Telemetry } = await import(${JSON.stringify(join(import.meta.dir, "../src/telemetry.ts"))});
      const hashes = [];
      const t = new Telemetry(process.argv[1], {}, async (url, body) => { if (url.endsWith("/v1/logs")) hashes.push(JSON.parse(body).resourceLogs[0].resource.attributes.find((a) => a.key === "dori.install.hash").value.stringValue); return { status: 200, text: JSON.stringify({ key: "k" }) }; }, Date.now, () => {});
      t.record({ name: "dori.lane_started", open_lanes: 1 }); await t.flush(5000); console.log(hashes[0] ?? "none");`;
    const runs = Array.from({ length: 6 }, () =>
      Bun.spawn(["bun", "-e", script, home], { stdout: "pipe", stderr: "pipe" }),
    );
    const outs = await Promise.all(
      runs.map(async (p) => {
        await p.exited;
        return (await new Response(p.stdout).text()).trim();
      }),
    );
    expect(outs.every((o) => /^[0-9a-f]{64}$/.test(o))).toBe(true);
    expect(new Set(outs).size).toBe(1);
  });
});
