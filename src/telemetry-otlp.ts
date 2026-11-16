import { randomUUID } from "node:crypto";
import { arch, platform, release } from "node:os";

import type { TelemetryEvent } from "./telemetry.ts";

export const VERSION = "0.1.0";

export const isOn = (v: string | undefined) => v !== undefined && ["1", "true", "yes"].includes(v.trim().toLowerCase());

export const OS_TYPE: Record<string, string> = { darwin: "darwin", linux: "linux", win32: "windows" };
const HOST_ARCH: Record<string, string> = { x64: "amd64", arm64: "arm64", ia32: "x86", arm: "arm32" };

// The collector answers 200 even when it refuses records; the refusal count is in partialSuccess.
export function rejectedRecords(text: string): number {
  try {
    const n = Number(
      (JSON.parse(text) as { partialSuccess?: { rejectedLogRecords?: unknown } }).partialSuccess?.rejectedLogRecords ??
        0,
    );
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

const osVersion = () => {
  const v = release().match(/^\d{1,6}(?:\.\d{1,6}){1,3}/)?.[0];
  return v === undefined ? [] : [attr("os.version", v)];
};

type AnyValue = { stringValue: string } | { intValue: string } | { boolValue: boolean };
const value = (v: string | number | boolean): AnyValue =>
  typeof v === "string"
    ? { stringValue: v }
    : typeof v === "boolean"
      ? { boolValue: v }
      : { intValue: String(Math.trunc(v)) };
const attr = (key: string, v: string | number | boolean) => ({ key, value: value(v) });

export function otlpLogs(
  installHash: string,
  events: readonly TelemetryEvent[],
  nowMs: number,
  env: NodeJS.ProcessEnv,
) {
  const timeUnixNano = (BigInt(nowMs) * 1_000_000n).toString();
  return {
    resourceLogs: [
      {
        resource: {
          attributes: [
            attr("service.name", "dori-superagent"),
            attr("service.version", VERSION),
            attr("dori.install.hash", installHash),
            attr("dori.ci", isOn(env["CI"])),
            attr("os.type", OS_TYPE[platform()] ?? "linux"),
            ...osVersion(),
            attr("host.arch", HOST_ARCH[arch()] ?? "other"),
          ],
        },
        scopeLogs: [
          {
            scope: { name: "dori-superagent", version: VERSION },
            logRecords: events.map(({ name, ...fields }) => ({
              timeUnixNano,
              eventName: name,
              attributes: [
                attr("log.record.uid", randomUUID()),
                ...Object.entries(fields).map(([k, v]) => attr(`dori.${k}`, v as string | number)),
              ],
            })),
          },
        ],
      },
    ],
  };
}
