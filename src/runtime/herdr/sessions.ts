import type { CloseScope, CreateSpec, SessionInfo, SessionRef } from "../types.ts";
import type { HerdrCli } from "./exec.ts";
import { paneStatus } from "./probe.ts";

export type Env = Readonly<Record<string, string | undefined>>;

const envFlags = (env: Readonly<Record<string, string>>): string[] =>
  Object.entries(env).flatMap(([k, v]) => ["--env", `${k}=${v}`]);
const str = (value: unknown): string => String(value ?? "");

const toRef = (paneId: string, workspaceId: string, tabId: string): SessionRef => ({
  runtime: "herdr",
  id: paneId,
  ...(workspaceId ? { group: workspaceId } : {}),
  ...(tabId ? { container: tabId } : {}),
});

function created(value: unknown, fallbackTab = ""): SessionRef {
  const o = (value ?? {}) as Record<string, unknown>;
  const paneId = str(o["pane_id"]);
  if (!paneId) throw new Error("herdr did not return a pane id");
  return toRef(paneId, str(o["workspace_id"]), str(o["tab_id"]) || fallbackTab);
}

/** `workspace create` for a group of sessions; its root pane is left as is. Returns the workspace id. */
export async function createGroup(cli: HerdrCli, label: string, cwd: string): Promise<string> {
  const r = await cli.call(["workspace", "create", "--label", label, "--cwd", cwd, "--no-focus"]);
  const id = str(((r["root_pane"] ?? {}) as Record<string, unknown>)["workspace_id"]);
  if (!id) throw new Error("herdr did not return a workspace id");
  return id;
}

/**
 * A pane with the user's shell in it, created without taking focus: the root pane of a new workspace, a tab in
 * `group` (no --workspace when absent or empty), or a split below `near`. The workspace form passes `--env` only when there is any.
 */
export async function create(cli: HerdrCli, spec: CreateSpec): Promise<SessionRef> {
  const { name, cwd } = spec;
  const env = envFlags(spec.env);
  switch (spec.container) {
    case "workspace-root":
      return created(
        (await cli.call(["workspace", "create", "--label", name, "--cwd", cwd, ...env, "--no-focus"]))["root_pane"],
      );
    case "tab": {
      const r = await cli.call([
        "tab",
        "create",
        "--label",
        name,
        "--cwd",
        cwd,
        "--no-focus",
        // An empty group is no group, as before runtimes existed: never `--workspace ""`.
        ...(spec.group ? ["--workspace", spec.group] : []),
        ...env,
      ]);
      return created(r["root_pane"], str(r["tab_id"]));
    }
    case "split-below": {
      if (spec.near === undefined) throw new Error("a split-below session needs `near`");
      const r = await cli.call([
        "pane",
        "split",
        spec.near.id,
        "--direction",
        "down",
        "--ratio",
        "0.3",
        "--cwd",
        cwd,
        "--no-focus",
        ...env,
      ]);
      return created(r["pane"]);
    }
  }
}

/** Starts the command line in the pane's shell. */
export async function start(cli: HerdrCli, paneId: string, command: string): Promise<void> {
  await cli.call(["pane", "run", paneId, command]);
}

/** `pane list`, keeping only the panes of one workspace when a group is given. */
export async function list(cli: HerdrCli, group: string | undefined): Promise<readonly SessionInfo[]> {
  const panes = (await cli.call(["pane", "list"]))["panes"];
  if (!Array.isArray(panes)) return [];
  return (panes as Record<string, unknown>[])
    .filter((p) => str(p["pane_id"]) !== "" && (group === undefined || str(p["workspace_id"]) === group))
    .map((p): SessionInfo => {
      const status = paneStatus(p);
      const [title, cwd] = [str(p["title"]), str(p["cwd"])];
      return {
        ref: toRef(str(p["pane_id"]), str(p["workspace_id"]), str(p["tab_id"])),
        ...(title ? { title } : {}),
        ...(cwd ? { cwd } : {}),
        status,
        ...(status !== "shell" ? { agent: str(p["agent"]) } : {}),
      };
    });
}

/** "session" closes the pane; "container" closes its tab, or the pane when the ref names no tab. */
export async function close(cli: HerdrCli, ref: SessionRef, scope: CloseScope): Promise<void> {
  if (scope === "container" && ref.container !== undefined) await cli.call(["tab", "close", ref.container]);
  else await cli.call(["pane", "close", ref.id]);
}

/** The pane this process runs in, from the variables herdr sets in every pane. */
export function self(env: Env): SessionRef | undefined {
  const paneId = env["HERDR_PANE_ID"];
  return paneId ? toRef(paneId, env["HERDR_WORKSPACE_ID"] ?? "", "") : undefined;
}
