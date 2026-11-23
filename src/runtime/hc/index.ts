import type { Exec } from "../exec.ts";
import { spawnExec } from "../exec.ts";
import type {
  AgentIdentity,
  CloseScope,
  CreateSpec,
  DeliverOptions,
  DeliverOutcome,
  Key,
  Probe,
  ReadOptions,
  SessionInfo,
  SessionRef,
  SessionRuntime,
  SubmitResult,
} from "../types.ts";
import { deliver, keys, read, submitTyped, typeIntoShell } from "./deliver.ts";
import { closeTab, keepAsTab } from "./app.ts";
import { probe } from "./probe.ts";
import { close, create, list, selfRef, start } from "./sessions.ts";

export type HcRuntimeOptions = {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly log?: (line: string) => void;
};

/** herdr-core (`hc`) behind the session runtime interface, one `hc --json` call per step. */
export class HcRuntime implements SessionRuntime {
  readonly kind = "hc";
  private readonly env: Readonly<Record<string, string | undefined>>;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (line: string) => void;

  constructor(
    private readonly exec: Exec = spawnExec,
    options: HcRuntimeOptions = {},
  ) {
    this.env = options.env ?? process.env;
    this.sleep = options.sleep ?? ((ms) => Bun.sleep(ms));
    this.log = options.log ?? ((line) => void process.stderr.write(`${line}\n`));
  }

  self(): SessionRef | undefined {
    return selfRef(this.env);
  }

  /** hc has no workspaces: a group is only the `dori.group` label value. */
  async createGroup(label: string, _cwd: string): Promise<string> {
    return label;
  }

  create(spec: CreateSpec): Promise<SessionRef> {
    return create(this.exec, spec, this.env["SHELL"] || "sh");
  }

  start(ref: SessionRef, command: string): Promise<void> {
    return start(this.exec, ref.id, command);
  }

  list(filter?: { readonly group?: string }): Promise<readonly SessionInfo[]> {
    return list(this.exec, filter?.group);
  }

  probe(ref: SessionRef): Promise<Probe> {
    return probe(this.exec, ref.id);
  }

  read(ref: SessionRef, lines: number, opts?: ReadOptions): Promise<string> {
    return read(this.exec, ref.id, lines, opts?.unwrapped ?? false);
  }

  deliver(ref: SessionRef, text: string, opts?: DeliverOptions): Promise<DeliverOutcome> {
    return deliver(this.exec, ref.id, text, opts, this.sleep);
  }

  /** Enter for text an earlier delivery left in the input (omo missed hc's Enter), into the same agent only (#108). */
  submitTyped(ref: SessionRef, into: AgentIdentity): Promise<SubmitResult> {
    return submitTyped(this.exec, ref.id, into, this.sleep);
  }

  typeIntoShell(ref: SessionRef, text: string): Promise<boolean> {
    return typeIntoShell(this.exec, ref.id, text);
  }

  keys(ref: SessionRef, names: readonly Key[]): Promise<void> {
    return keys(this.exec, ref.id, names);
  }

  /** Kill then remove; hc has no container, so the scope does not change anything. The app tab showing the terminal goes too. */
  async close(ref: SessionRef, _scope?: CloseScope): Promise<void> {
    await close(this.exec, ref.id, this.sleep, this.log);
    await closeTab(this.exec, ref.id, this.log);
  }

  /** A terminal opened in this core is not on screen until the herdr app shows it as a tab, next to `anchor`'s space. */
  keepAsTab(ref: SessionRef, anchor?: SessionRef): Promise<void> {
    return keepAsTab(this.exec, ref.id, this.log, anchor?.id);
  }
}
