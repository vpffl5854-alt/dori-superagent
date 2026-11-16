import { expect } from "bun:test";
import { send } from "../src/inbox.ts";
import { World, href } from "./fake.ts";

export const NOT_READY = '{"error":{"code":"agent_not_ready"}}';

export function setup() {
  const w = new World();
  const d = w.deps();
  const lead = w.addPane("w1:p1", "idle");
  d.store.setRole("lead", href("w1:p1"));
  const pane = w.addPane("w1:p2", "idle");
  const count = (id: string, group: string, verb: string) =>
    w.calls.filter((c) => c.argv[0] === group && c.argv[1] === verb && c.argv[2] === id).length;
  const notices = () => lead.received.filter((m) => m.startsWith("[DELIVERY-AMBIGUOUS w1:p2]"));
  return { w, d, lead, pane, count, notices };
}

/** Types SECRET into w1:p2 through the fallback, with every Enter failing: one typed entry is left. */
export async function typedEntry(s: ReturnType<typeof setup>): Promise<void> {
  s.w.promptFails.set("w1:p2", NOT_READY);
  s.w.keyFails = 3;
  expect(await send(s.d, "w1:p2", "SECRET instruction", "cli")).toBe("QUEUED");
  expect(s.d.store.queued(href("w1:p2")).map((m) => m.attempt?.state)).toEqual(["typed"]);
}

export async function captureIo(run: () => Promise<number>): Promise<{ code: number; out: string }> {
  const out: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => {
    out.push(a.join(" "));
  };
  try {
    return { code: await run(), out: out.join("\n") };
  } finally {
    console.log = log;
  }
}
