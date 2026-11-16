import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Telemetry, telemetryEnabled } from "../src/telemetry.ts";
import { VERSION } from "../src/telemetry-otlp.ts";

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
  test("DORI_TELEMETRY=0 and DO_NOT_TRACK=1 turn it off completely: nothing sent, nothing written", async () => {
    expect(telemetryEnabled({ DORI_TELEMETRY: "0" })).toBe(false);
    expect(telemetryEnabled({ DO_NOT_TRACK: "1" })).toBe(false);
    expect(telemetryEnabled({})).toBe(true);
    const r = rig({ DORI_TELEMETRY: "0" });
    r.t.touch();
    await r.t.flush(5000);
    r.t.record({ name: "dori.lane_started", open_lanes: 1 });
    await r.t.flush(5000);
    expect(r.sent).toEqual([]);
    expect(r.notices).toEqual([]);
    expect(existsSync(join(r.home, "telemetry.json"))).toBe(false);
  });

  test("first run: one notice, installed + daily_active; later runs the same day send nothing; the next day sends daily_active again", async () => {
    const r = rig();
    r.t.touch();
    await r.t.flush(5000);
    expect(r.notices).toHaveLength(1);
    expect(r.names()).toEqual(["dori.installed", "dori.daily_active"]);
    r.t.touch();
    await r.t.flush(5000);
    expect(r.names()).toHaveLength(2);
    r.advance(24 * 3_600_000);
    r.t.touch();
    await r.t.flush(5000);
    expect(r.names()).toEqual(["dori.installed", "dori.daily_active", "dori.daily_active"]);
    expect(r.notices).toHaveLength(1);
    expect(r.logs()[0]!.url).toBe("https://t.omo.dev/v1/logs");
  });

  test("the key is minted once per install from the hash, cached, and re-minted after a 401", async () => {
    let status = 200;
    const r = rig({}, () => status);
    r.t.touch();
    await r.t.flush(5000);
    r.t.record({ name: "dori.lane_started", open_lanes: 1 });
    await r.t.flush(5000);
    expect(r.registers()).toHaveLength(1);
    const reg = JSON.parse(r.registers()[0]!.body);
    expect(Object.keys(reg).sort()).toEqual(["install_hash", "product"]);
    expect(reg.product).toBe("dori-superagent");
    expect(reg.install_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.logs().map((s) => s.headers["x-omo-ingest-key"])).toEqual(["install-key-1", "install-key-1"]);
    expect(readFileSync(join(r.home, "telemetry.json"), "utf8")).not.toContain(reg.install_hash);
    status = 401;
    r.t.record({ name: "dori.lane_started", open_lanes: 2 });
    await r.t.flush(5000);
    status = 200;
    r.t.record({ name: "dori.lane_started", open_lanes: 3 });
    await r.t.flush(5000);
    expect(r.registers()).toHaveLength(2);
    expect(r.logs().at(-1)!.headers["x-omo-ingest-key"]).toBe("install-key-2");
  });

  test("the payload matches the registered artifact: OTLP JSON, allowed resource keys, counts only", async () => {
    const r = rig();
    r.t.record({ name: "dori.lane_ready", evidence_count: 2, lane_minutes: 37 });
    await r.t.flush(5000);
    const body = JSON.parse(r.logs()[0]!.body);
    const resource = Object.fromEntries(
      body.resourceLogs[0].resource.attributes.map((a: { key: string; value: unknown }) => [a.key, a.value]),
    );
    const allowed = [
      "service.name",
      "service.version",
      "dori.install.hash",
      "dori.ci",
      "os.type",
      "os.version",
      "host.arch",
    ];
    expect(Object.keys(resource).every((k) => allowed.includes(k))).toBe(true);
    expect(resource["service.name"]).toEqual({ stringValue: "dori-superagent" });
    expect(resource["dori.install.hash"].stringValue).toBe(JSON.parse(r.registers()[0]!.body).install_hash);
    expect(["darwin", "linux", "windows"]).toContain(resource["os.type"].stringValue);
    expect(body.resourceLogs[0].scopeLogs[0].scope).toEqual({ name: "dori-superagent", version: VERSION });
    expect(VERSION).toMatch(/^[0-9]+\.[0-9]+\.[0-9]+$/);
    const rec = body.resourceLogs[0].scopeLogs[0].logRecords[0];
    expect(rec.eventName).toBe("dori.lane_ready");
    expect(rec.body).toBeUndefined();
    expect(rec.timeUnixNano).toMatch(/^[0-9]+$/);
    const attrs = Object.fromEntries(rec.attributes.map((a: { key: string; value: unknown }) => [a.key, a.value]));
    expect(attrs["dori.evidence_count"]).toEqual({ intValue: "2" });
    expect(attrs["dori.lane_minutes"]).toEqual({ intValue: "37" });
    expect(r.logs()[0]!.body).not.toContain(r.home);
  });

  test("duty ticks are summed and sent at most once an hour", async () => {
    const r = rig();
    const tick = { ticks: 1, flushed: 1, nudges: 0, escalations: 0, lost: 0 };
    for (let i = 0; i < 60; i++) {
      r.t.duty(tick);
      await r.t.flush(5000);
      r.advance(60_000);
    }
    expect(r.logs()).toEqual([]);
    r.t.duty({ ...tick, nudges: 1 });
    await r.t.flush(5000);
    expect(r.names()).toEqual(["dori.duty_summary"]);
    const attrs = JSON.parse(r.logs()[0]!.body).resourceLogs[0].scopeLogs[0].logRecords[0].attributes;
    const get = (k: string) => attrs.find((a: { key: string }) => a.key === k).value.intValue;
    expect([get("dori.ticks"), get("dori.flushed"), get("dori.nudges")]).toEqual(["61", "61", "1"]);
    r.t.duty(tick);
    await r.t.flush(5000);
    expect(r.logs()).toHaveLength(1);
  });

  test("an unreachable collector or a refused registration never throws and sends no logs", async () => {
    const home = mkdtempSync(join(tmpdir(), "dori-tel-"));
    const offline = new Telemetry(
      home,
      {},
      async () => {
        throw new Error("offline");
      },
      Date.now,
      () => {},
    );
    offline.touch();
    await offline.flush(5000);
    const r = rig(
      {},
      () => 200,
      () => 503,
    );
    r.t.touch();
    await r.t.flush(5000);
    expect(r.registers()).toHaveLength(1);
    expect(r.logs()).toEqual([]);
  });
});
