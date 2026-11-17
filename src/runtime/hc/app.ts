import type { Exec } from "../exec.ts";

const APP = "herdr-app";

type Tab = { id: string; terminals: readonly string[] };

function tabs(stdout: string): Tab[] {
  const parsed = JSON.parse(stdout) as { spaces?: { tabs?: unknown }[] };
  const out: Tab[] = [];
  for (const space of Array.isArray(parsed.spaces) ? parsed.spaces : []) {
    for (const raw of Array.isArray(space.tabs) ? space.tabs : []) {
      const tab = raw as { id?: unknown; terminals?: unknown };
      if (typeof tab.id !== "string" || !Array.isArray(tab.terminals)) continue;
      const terminals = tab.terminals.flatMap((t: unknown) => {
        const address = (t as { terminal?: unknown }).terminal;
        return typeof address === "string" ? [address] : [];
      });
      out.push({ id: tab.id, terminals });
    }
  }
  return out;
}

async function list(exec: Exec): Promise<Tab[]> {
  const res = await exec(APP, ["ls"]);
  if (res.code !== 0) throw new Error(`herdr-app ls exited ${res.code}`);
  return tabs(res.stdout);
}

/** The tab a terminal is shown in; a missing app or a failed ls is no tab, never the caller's failure. */
async function tabOf(exec: Exec, terminal: string, log: (line: string) => void): Promise<Tab | undefined> {
  try {
    return (await list(exec)).find((t) => t.terminals.includes(terminal));
  } catch (e) {
    log(`dori: herdr-app could not list tabs for terminal ${terminal} (${e instanceof Error ? e.message : String(e)})`);
    return undefined;
  }
}

/** Best effort: a missing app, no open window or a refused command is one stderr line, never the caller's failure. */
export async function keepAsTab(
  exec: Exec,
  terminal: string,
  log: (line: string) => void,
  anchor?: string,
): Promise<void> {
  try {
    if (anchor !== undefined) {
      const space = await spaceOf(exec, anchor);
      // herdr shows a kept terminal in the space on screen, so the anchor's space is selected first: without it a lane
      // opened from this home lands in whatever space the person happens to be looking at (omomeow, 2026-11-18).
      if (space !== undefined) await exec(APP, ["do", "space.select", "--id", space]);
    }
    const res = await exec(APP, ["do", "terminal.keep", "--terminal", terminal]);
    if (res.code !== 0) throw new Error(`${(res.stderr || res.stdout).trim() || `exit ${res.code}`}`);
  } catch (e) {
    log(`dori: herdr-app could not show terminal ${terminal} as a tab (${e instanceof Error ? e.message : String(e)})`);
  }
}

/** The space a terminal is shown in, or undefined when no window shows it. */
async function spaceOf(exec: Exec, terminal: string): Promise<string | undefined> {
  const res = await exec(APP, ["ls"]);
  if (res.code !== 0) return undefined;
  try {
    const parsed = JSON.parse(res.stdout) as { spaces?: unknown };
    for (const raw of Array.isArray(parsed.spaces) ? parsed.spaces : []) {
      const space = raw as { id?: unknown };
      if (typeof space.id !== "string") continue;
      if (tabs(JSON.stringify({ spaces: [space] })).some((t) => t.terminals.includes(terminal))) return space.id;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** Best effort, like keepAsTab: no app tab for this terminal closes nothing and fails nothing. */
export async function closeTab(exec: Exec, terminal: string, log: (line: string) => void): Promise<void> {
  try {
    const tab = await tabOf(exec, terminal, log);
    if (tab === undefined) return;
    const res = await exec(APP, ["do", "tab.close", "--id", tab.id]);
    if (res.code !== 0) throw new Error(`${(res.stderr || res.stdout).trim() || `exit ${res.code}`}`);
  } catch (e) {
    log(
      `dori: herdr-app could not close the tab of terminal ${terminal} (${e instanceof Error ? e.message : String(e)})`,
    );
  }
}
