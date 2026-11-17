import type { SessionRef } from "../../../../../src/runtime/types.ts";
import type { DoriConfig } from "../config.ts";
import { type ChosenRuntimes, run, runtimesOf } from "../run.ts";
import { newestSessionLog } from "./session-log.ts";

const leadRef = (config: Pick<DoriConfig, "leadPane" | "runtime">): SessionRef | undefined => {
  const raw = config.leadPane.trim();
  if (!raw) return undefined;
  const [kind, ...rest] = raw.split(":");
  const id = rest.join(":");
  if (kind === "hc" && id) return { runtime: "hc", id };
  if (kind === "herdr" && id) return { runtime: "herdr", id };
  // A bare name (`discord-chat`) is a lane found by name, in the configured runtime.
  return { runtime: config.runtime ?? "hc", id: raw };
};

export const resolveLeadRef = async (
  config: Pick<DoriConfig, "leadPane" | "runtime">,
  rts: ChosenRuntimes,
): Promise<SessionRef | undefined> => {
  const ref = leadRef(config);
  if (ref === undefined) return undefined;
  const name = ref.id.toLowerCase();
  const live = await rts.for(ref).list();
  const byAddress = live.find((s) => s.ref.id === ref.id);
  if (byAddress) return byAddress.ref;
  return live.find((s) => s.name?.toLowerCase() === name)?.ref;
};

export const sessionPathFor = (sessionsDir: string, cwd: string): Promise<string | undefined> =>
  newestSessionLog(run, sessionsDir, cwd);

export const sessionPathForPane = async (
  config: Pick<DoriConfig, "leadPane" | "sessionsDir" | "defaultCwd" | "runtime">,
  rts: ChosenRuntimes = runtimesOf({ run, clock: { now: () => Date.now(), sleep: (ms) => Bun.sleep(ms) }, config }),
): Promise<string | undefined> => {
  const ref = await resolveLeadRef(config, rts);
  const cwd = ref === undefined ? undefined : (await rts.for(ref).list()).find((s) => s.ref.id === ref.id)?.cwd;
  return sessionPathFor(config.sessionsDir, cwd ?? config.defaultCwd);
};
