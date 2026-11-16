# Session runtimes: herdr and hc

**Dori runs its sessions on herdr or on hc (herdr-core), chosen by the `runtime` key in `$DORI_HOME/config.json`; sessions on both can live in one home, and `dori migrate` moves them from one runtime to the other.**

A session is one terminal with an agent or a loop in it: the lead, duty, the duty loop, the hourly loop, or a lane. herdr gives Dori workspaces, tabs and panes and detects the agent in a pane. hc gives Dori plain terminals with labels, and the agent in a terminal reports its own status. The harness talks to both through one interface, and nothing above that interface knows which runtime it is using.

## The interface

`SessionRuntime` in `src/runtime/types.ts` is the whole contract. Each runtime has one adapter, `src/runtime/herdr/` and `src/runtime/hc/`, and both run their CLI through one injectable process runner (`src/runtime/exec.ts`), so tests replace the binary with a recorder.

| Method | What it does |
|---|---|
| `self()` | The caller's own session, from `HERDR_PANE_ID` (+ `HERDR_WORKSPACE_ID`) or `HC_TERMINAL_ID` |
| `createGroup(label, cwd)` | herdr: a new workspace, returns its id. hc: returns the label, no call |
| `create(spec)` | A session with the user's shell in it and nothing started |
| `start(ref, command)` | Runs the command line in that shell |
| `list(filter)` | The live sessions, all of them or one group's |
| `probe(ref)` | One snapshot: status, agent name, foreground processes, title, cwd |
| `read(ref, lines)` | The last lines of the screen |
| `deliver(ref, text, opts)` | One message to the agent; never types into a shell |
| `submitTyped(ref, into)` | Presses only Enter for text an earlier delivery typed (herdr) |
| `typeIntoShell(ref, text)` | The operator's `--to-shell`, only into a session with no agent |
| `keys(ref, keys)` | Enter or Escape |
| `close(ref, scope)` | Closes the session, or its herdr tab |

A session is stored as a `SessionRef`: the runtime, the id (`w1:p3` on herdr, `t7` on hc), and the group and tab when the runtime has them. Every stored lane and role keeps its own ref, so commands on an existing session go to the runtime that opened it, whatever runtime is selected for new sessions. Lane records written before runtimes existed have no ref and read as herdr.

## Choosing a runtime

New sessions open on one runtime, picked in this order (`readRuntimeChoice` in `src/runtime/select.ts`):

1. `DORI_RUNTIME=herdr` or `DORI_RUNTIME=hc`.
2. `"runtime": "herdr"` or `"runtime": "hc"` in `$DORI_HOME/config.json` (default `~/.dori/config.json`). This is the same file the dori-mode skill reads, so one line sets both.
3. `HC_TERMINAL_ID` is set: Dori runs inside an hc terminal, so hc.
4. `HERDR_PANE_ID` is set: Dori runs inside a herdr pane, so herdr.
5. The binaries on PATH: hc (herdr-core) when it is installed, else herdr. hc is the default runtime; with both installed, herdr is one config line away.

When neither binary is on PATH and nothing above decides, Dori refuses and prints the fix in one line:

```
neither herdr nor hc is on PATH: install hc (herdr-core) or herdr, or set "runtime": "herdr" or "hc" in <DORI_HOME>/config.json, or DORI_RUNTIME
```

(The real message prints the absolute path of your config file.)

An invalid value in `DORI_RUNTIME` or in the config file is an error, never a fallback. `dori status` prints the choice first, as `RUNTIME hc (from config)`; the sources are `env`, `config`, `detect:HC_TERMINAL_ID`, `detect:HERDR_PANE_ID` and `detect:path`. When no runtime can be chosen, it prints `RUNTIME unset:` and the fix. The dori-mode skill's `dori boot` prints the same `RUNTIME` line, or `RUNTIME unavailable:` and fails its check.

## How herdr verbs map to hc

The herdr adapter calls the left column, the hc adapter the right one. Every hc call carries `--json`.

| herdr | hc | Used for |
|---|---|---|
| `workspace create --label L --cwd D --no-focus` | `run --bg --no-parent --no-notify --cwd D --label dori.group=G ... -- env K=V $SHELL` | The lead on `dori up` (on hc, a group is only a label) |
| `tab create --label L --cwd D --no-focus [--workspace W]` | the same `run --bg ...` | Duty, lanes, migrated sessions |
| `pane split <near> --direction down --ratio 0.3` | the same `run --bg ...` | The duty loop and the hourly loop |
| `pane run <pane> <command>` | `send <t> -- <command>` | Starting the agent or loop in the new shell |
| `pane get <pane>` | `get <t>` | The status word and the agent name |
| `pane read <pane> --lines N --source recent` | `read <t> --lines N` | Screen reads (the migrate capture, launch checks) |
| `pane close <pane>`, or `tab close <tab>` | `kill <t>`, then `rm <t>` | Closing a session |
| `agent prompt <pane> <text>` | `send <t> [--if idle\|working] [--force] -- <text>` | Delivering a message |
| `pane send-text <pane> <text>` | not needed: `send` pastes and presses Enter in one step | herdr's fallback when `agent prompt` answers `agent_not_ready` |
| `pane send-keys <pane> enter` | `keys <t> enter` | Submitting typed text; Escape is `esc` on hc |
| `pane process-info --pane <pane>` | `get <t>` (its `foreground` and `pid` fields) | Whether a shell is in front |
| `--session <name>` (from `DORI_HERDR_SESSION`) | `HC_SESSION=<name>` in the environment | An isolated server, as the end-to-end tests use |

Listing is `pane list` on herdr and `ls [--label dori.group=G]` on hc. On hc, `rm` answers `live` while the program is still dying, so Dori retries it 5 times, 200 ms apart, and logs one line if the terminal is still running after that.

## Status

Dori reads a session's status before it types anything into it. The words are `idle`, `working`, `blocked`, `done`, `error`, `unknown`, `shell` (no agent, a bare shell) and `gone`.

On herdr the status is herdr's own detection of the agent in the pane. herdr reports an omo with live monitors as `working` even between turns, so when herdr says `working` Dori also reads the screen and believes `idle` only when omo's empty input box is at the bottom.

On hc the status comes from the agent's own report, an OSC 7501 escape sequence. omo reports `working` for as long as any monitor or background session is live, even between turns (#178), so when an agent with no shell in front reports `working`, Dori also reads the last 30 screen lines and believes `idle` only when omo's empty input box is at the bottom, the same check as on herdr; a failed or empty read stays `working`. Recent omo builds emit that report. An agent that never reports stays `unknown`, or `shell` when an interactive shell leads the foreground, and Dori holds every message to it in its inbox without sending. For a reporting agent Dori probes first and then sends with a gate. The inbox, the one path that types queued messages into an agent, sends its batch with `--if idle`, or with `--if working` when the idle came from the screen while hc still says `working`; when hc refuses because the agent moved in between, the batch stays queued and the next flush tries again. That second gate cannot tell a new turn from the idle state, because omo reports `working` for both: a turn that starts in the one hc round trip between the screen read and the send still gets the batch. The dori-mode scripts' direct sends and the migration checkpoint ask gate on the status they just read instead, `--if idle` after `idle` and `--if working` after `working`. A refused send comes back to the script as `failed`; a send whose outcome cannot be known (an ambiguous delivery, or any send made while the agent was working) comes back as `unconfirmed`, and the script never resends it. The migration ask treats only a gone agent as a stop; a refused or unconfirmed ask is not surfaced yet (tracked as a follow-up). An agent that reports `done` (its turn finished, waiting for input) is sent to without a gate, because hc's `--if` accepts only `idle` and `working`. A `blocked` or `error` agent gets nothing unless the sender forces it. A suspended agent leaves its shell in front, and on both runtimes Dori then holds the message whatever the status word says.

Set `notes = false` in `~/.config/herdr-core/config.toml`. With notes on, hc types notes into a parent agent on its own, and Dori's inbox is meant to be the only thing that types into an agent. Dori already opens every terminal with `--no-parent --no-notify`.

## Grouping

On herdr, `dori up` creates a workspace named `dori`: the lead is its root pane, duty a tab, and the two loops are splits below duty. A lane opened from a pane in that workspace becomes a tab there.

hc has no workspaces, tabs or layout. Dori opens one terminal per session and labels it:

- `dori.group`: the home's group, the first 8 hex characters of the sha256 of the resolved `DORI_HOME` path, so two homes never share one;
- `dori.role`: `lead`, `duty`, `duty-loop`, `hourly-loop` or `lane`;
- `dori.name`: the session's name;
- `dori.lane`: the lane key, on lanes only.

`hc ls --label dori.group=<g>` lists one home's sessions. The terminal also gets the session name as its hc name when no live terminal holds it, but Dori identifies a terminal by its address and labels, never by the name.

Only one duty loop runs per home, whatever the runtime: it takes `duty/lock` under `DORI_HOME`, and a second `dori duty` is refused while it is held.

## Targets

`dori send`, `dori role` and `dori inbox` take a session in several forms:

- `herdr:w1:p3` or `hc:t7`, with the runtime spelled out;
- a bare `w1:p3`, which is a herdr pane;
- `lead` or `duty`;
- a lane key.

A bare `t7` is not a ref, because `t7` is a legal lane key: a lane named `t7` is that lane. Stored roles and inbox file names keep herdr refs bare and prefix every other runtime (`hc:t7`), so files written before runtimes existed still match.

## Migrating sessions

```
dori migrate [--to hc|herdr] (--lane K | --role lead|duty|duty-loop|hourly-loop | --all) [--dry-run] [--wait-minutes N] [--resume]
```

`--to` defaults to the selected runtime. `--all` takes every open lane, then lead and duty, then the duty loop and the hourly loop. For each agent session the steps are:

1. Hold. A journal is created at `DORI_HOME/migrate/<name>.json` and the lane is marked as migrating, so the duty loop neither nudges it nor flushes its inbox.
2. Checkpoint. The agent is asked to write a handoff checkpoint (goal, open todos, last state) to `briefs/<name>.handoff.md` and stop. Dori waits until it stops working, up to `--wait-minutes` (default 10). A `blocked` agent is asked nothing.
3. Capture. A handoff brief `briefs/<name>.migrate-<time>.md` is written: the original brief, a `## Handoff` section with the last 20 lane log entries, the checkpoint, the last 80 screen lines and the queued messages, then the lane rules.
4. Open. The replacement opens on the target, in this home's group on hc or a new `dori` workspace on herdr, with the agent started on the handoff brief.
5. Verify. The replacement must report `idle` or `working` within 3 minutes.
6. Move the inbox. A forward marker on the old inbox names the new session, and the old entries are merged into the new inbox. Queued entries stay queued, held entries stay held, and an entry that was typed but never submitted becomes held.
7. Switch. The lane or role record points at the new session, and the lane keeps the old ref in `migratedFrom`.
8. Close. The old session is closed, messages that late senders appended to the old inbox are moved over, the marker is removed, and the journal is deleted.

Each session ends with one line:

- `MIGRATED <name> <old> -> <new>`: done.
- `MIGRATE_ROLLBACK <name> <new> <why>`: verify failed. The replacement is closed, the inbox goes back unchanged with held entries still held, the hold is lifted, and the exit code is 3.
- `DEFERRED <name> blocked` or `DEFERRED <name> working past N min`: nothing moved, and the hold is lifted.
- `SKIP <name> already on <runtime>`.

`--dry-run` prints `PLAN <name> <old> -> <runtime>` with the number of queued messages and changes nothing. A run that was cut short resumes at the phase its journal recorded when it is started again, and a second `dori migrate` of the same session is refused while one runs.

`--resume` starts the replacement on the old agent's own session file (`omo --session <path>`) instead of a handoff brief. It is accepted only when the old session is live and `idle` or `done` and the lane has a recorded session path; otherwise it is refused and nothing moves.

The two loops are plain processes with no inbox and no agent, so they skip steps 2, 3, 5 and 6. The duty loop's old session closes before the new one opens, since the lock allows one per home. The hourly loop's new session opens first, and its own lock keeps the two from running the same hour.

## Hooks and prompts

`$DORI_HOME/config.json` can also hold `hooks`, argv templates that run without a shell:

```json
{
  "runtime": "hc",
  "hooks": {
    "onReady": ["notify-send", "READY {key}", "{text} {evidence}"],
    "onReport": ["logger", "-t", "dori", "{key}: {text}"],
    "onLost": ["logger", "-t", "dori", "LOST {key}: {text}"],
    "reviewCommand": ["my-reviewer", "--pr", "{pr}", "--sha", "{sha}"]
  }
}
```

`onReady` runs on `dori ready`, `onReport` on `dori report`, and `onLost` when the duty loop finds a lane whose session vanished. `{key}`, `{text}` and `{evidence}` are replaced inside each element. Hooks run in the background, and a failing hook is one stderr line; it never fails the command. `reviewCommand` replaces the built-in reviewer in `dori review`, gets `{pr}`, `{repo}`, `{number}`, `{sha}` and `{text}` (the rendered review prompt), and must print a `VERDICT: CLEAR` or `VERDICT: BLOCK` line. `DORI_PROMPTS_DIR` points Dori at another directory of prompt files in place of the repo's `prompts/`.

## Limits

- No remote sessions. hc can run terminals on other machines (`--on`), and Dori does not use it: every session is on the local core, and `dori` ignores terminals mirrored from other machines.
- No window layout on hc. The lead, duty and the loops are separate terminals; open them with `hc attach <t>`.
- hc on Windows is untested here.

## Tests

`bun test ./test/` covers both adapters against recorders. Three end-to-end tests run real servers in isolated sessions with a stand-in agent: `test/e2e.test.ts` on herdr (`herdr --session`), `test/e2e-hc.test.ts` on hc (its own `HC_SESSION` and XDG directories, with a fixture agent that reports OSC 7501), and `test/e2e-migrate.test.ts`, which moves a lane from herdr to hc. Each is skipped when its binary is not on PATH.
