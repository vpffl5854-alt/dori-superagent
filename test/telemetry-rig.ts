import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Telemetry } from "../src/telemetry.ts";

export type Sent = { url: string; body: string; headers: Record<string, string> };

export type Rig = {
  home: string;
  t: Telemetry;
  sent: Sent[];
  logs: () => Sent[];
  registers: () => Sent[];
  notices: string[];
  names: () => string[];
  now: () => number;
  advance: (ms: number) => void;
};

/** A Telemetry writing into a fresh temp home, with the clock, the collector and the key mint all under the test. */
export function rig(
  env: Record<string, string> = {},
  logsStatus: () => number = () => 200,
  registerStatus: () => number = () => 200,
  logsText: () => string = () => "",
): Rig {
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
    now: () => clock,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

/** The `dori.duty_summary` attributes of one sent log record, so a test can read single counters by name. */
export const summaryAttrs = (body: string): Record<string, string> => {
  const attrs = JSON.parse(body).resourceLogs[0].scopeLogs[0].logRecords[0].attributes as {
    key: string;
    value: { intValue?: string };
  }[];
  return Object.fromEntries(attrs.map((a) => [a.key, a.value.intValue ?? ""]));
};
