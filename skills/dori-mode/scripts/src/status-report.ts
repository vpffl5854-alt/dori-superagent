/** The router's status destination: what every open lane is doing, read from the registry and its reports. */
import type { Lane } from "./registry.ts";
import { statusOf } from "./registry.ts";
import type { Progress } from "./reports.ts";

const MAX_REPORT_TEXT = 160;

export const statusReport = (lanes: readonly Lane[], progressOf: (key: string) => Progress | null): string => {
  const open = lanes.filter((l) => statusOf(l) !== "closed");
  if (open.length === 0) return "진행 중인 레인 없음";
  return open
    .map((l) => {
      const p = progressOf(l.key);
      const last = p?.lastReport ? ` | ${p.lastReport.kind}: ${p.lastReport.text.slice(0, MAX_REPORT_TEXT)}` : "";
      return `${l.key} | ${statusOf(l)} | ${p?.state ?? "no report"}${last}`;
    })
    .join("\n");
};
