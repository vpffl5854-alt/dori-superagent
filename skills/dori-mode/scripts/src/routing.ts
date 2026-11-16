import type { GuardThresholds } from "./config.ts";
import type { HostSample } from "./host-guard.ts";
import { type Lane, statusOf } from "./registry.ts";

export type LaunchVerdict = { readonly ok: boolean; readonly reasons: readonly string[] };

export const canLaunch = (s: HostSample, t: GuardThresholds): LaunchVerdict => {
  const reasons: string[] = [];
  if (s.memFreePct < t.memFreeMinPct) reasons.push(`memory free ${s.memFreePct}% < ${t.memFreeMinPct}%`);
  if (s.diskFreeGb < t.diskFreeMinGb) reasons.push(`disk free ${s.diskFreeGb.toFixed(0)} GB < ${t.diskFreeMinGb} GB`);
  if (t.panesMax > 0 && s.panes < 0) reasons.push("session count unknown");
  if (t.panesMax > 0 && s.panes >= t.panesMax) reasons.push(`panes ${s.panes} >= ${t.panesMax}`);
  return { ok: reasons.length === 0, reasons };
};

export const idleLaneFor = (lanes: readonly Lane[], cwd: string, idlePanes: ReadonlySet<string>): Lane | null =>
  lanes.find((l) => statusOf(l) === "working" && l.cwd === cwd && l.pane !== undefined && idlePanes.has(l.pane)) ??
  null;
