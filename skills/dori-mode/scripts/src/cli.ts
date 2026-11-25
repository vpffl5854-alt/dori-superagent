#!/usr/bin/env bun
import { parseArgs } from "node:util";

import { type Command, die, makeCli } from "./cli-context.ts";
import { journalCommands, journalErrors } from "./cli-journal.ts";
import { laneCommands } from "./cli-lanes.ts";
import { messengerCommands, messengerErrors } from "./cli-messenger.ts";
import { opsCommands } from "./cli-ops.ts";
import { bountyCommands, huntCommands } from "./cli-hunt.ts";
import { incidentsCommands } from "./cli-incidents.ts";
import { upstreamCommands } from "./cli-upstream.ts";
import { briefingCommands } from "./cli-briefing.ts";
import { dorichatCommands } from "./cli-dorichat.ts";
import { decisionsCommands } from "./cli-decisions.ts";
import { macCommands } from "./cli-mac.ts";
import { notifyCommands } from "./cli-notify.ts";
import { routeCommands } from "./cli-route.ts";
import { shortsCommands } from "./cli-shorts.ts";
import { snsCommands } from "./cli-sns.ts";
import { ConfigError, loadConfig } from "./config.ts";
import type { FlowDeps } from "./done-flow.ts";
import { LaunchError } from "./launch.ts";
import { Registry } from "./registry.ts";
import { realClock, run } from "./run.ts";

const USAGE = `dori <command> [options]

  launch <key> --title T --brief FILE --done "merged o/r#N; closed o/r#M" [--thread REF] [--model M] [--cwd DIR]
         [--wall-minutes N|none] [--token-limit N|none] [--cost-limit N|none] [--activity-path FILE ...] [--dry-run]
  adopt  <key> --pane ID --title T --brief FILE --done "..." [--thread REF]
  sync   [--write]                     registry vs live panes; read-only unless --write
  boot                                 read-only check after a restart: Slack auth, vanished panes, journals, open worklog items, stale watches
  report <key> --kind milestone|blocker|question|halted|done --text TEXT
                                       append a durable progress report and print its [REPORT] line
  checkpoint <key> --step ID --result TEXT --evidence PATH [--remote-effect RECEIPT]...
                                       record a completed step once; a conflicting rewrite is refused
  checkpoints <key>                    read completed steps before resuming remote work
  verify-pr <owner/repo> <num> [--loop N] [--cwd DIR]
                                       check every commit's author/committer email and PR-level tests; print the UI test loop (not run)
  claim-done [<key>] --evidence TEXT  key defaults to the lane registered for your own session (HC_TERMINAL_ID or HERDR_PANE_ID)
  object-done <key> --reason TEXT [--reason TEXT ...]
  lesson add <key> --rule TEXT --evidence PATH [--cwd DIR]
  lesson add --global --rule TEXT --evidence REF
                                       the lead's lesson for every lane, whatever its repo
  lesson list [--cwd DIR]             show current lessons (global ones included), newest first
  lesson mark <id> --outcome pending|helped|no-effect|harmful|encoded
  worklog add <title> --source REF     record an owner request when it arrives
  worklog next|note <id> <text>        set the item's next step, or add a note (a decision, an owner)
  worklog close <id> --result TEXT     close the item with what came of it
  worklog list [--open]                items as JSON; <stateDir>/worklog.md holds the same for reading
  close  <key> [--note TEXT] [--lesson TEXT] [--evidence PATH]
                                       close now (Done signals must read back live); an optional lesson never blocks it
  pause  <key> [--note TEXT]           the owner said wait: goal paused (read back), running turn stopped, no nudges; exit 3 if unconfirmed
  resume <key> [--note TEXT]           undo pause: goal resumed (read back), lane back to its earlier status
  watch                                long-running: emits LANE_* lines every 30 s
  freshness [--loop MIN]               nudge silent lanes, post their last report via hooks.threadReply
  dead-panes [--loop MIN]              print DEAD_PANE <id> for stopped agent panes
  guard [--loop MIN]                   host load, memory, disk and pane-count alerts
  heavy <label> -- <command ...>       run a heavy command when a slot is free and load is low
  can-launch                           exit 0 if the host has room for a new lane, else print why and exit 4
  send <slack|telegram|discord> --to TARGET --text TEXT [--thread ID] [--edit ID]
                                       post or edit a message (tokens from DORI_SLACK_TOKEN or the file DORI_SLACK_TOKEN_FILE names, DORI_TELEGRAM_TOKEN, DORI_DISCORD_TOKEN)
  presence <slack|discord>             keep the account shown as online until stopped
  transcribe <audio-file>              run hooks.transcribe and print the text
  route  --text TEXT [--no-devin]      print the central router's pick (chat, coding to lane or Devin, video, status)
  cost   [--month YYYY-MM|prev] [--write]   per-model calls, input length, cost, failures, retries, success rate from omo session logs
  hunt   [owner/repo ...] [--write]    unclaimed good-first-issues and bugs (config huntRepos by default); --write saves lane briefs
  shorts topics [--no-send]            run the topics slot, save 3 candidates, send them to Telegram to pick
  shorts make (--auto|--topic T|--pick N) [--script FILE] [--no-send]
                                       script -> voice -> images -> MoviePy render -> check -> Telegram video
  shorts render <job>                  render and check an existing job again (hooks.render)
  shorts publish|private [job|latest] make an uploaded short public (or private again); AI-made stays declared
  shorts config [<key> <value>]        show or change voice, background, topics, interests, maxSeconds, font, time
  shorts trend-topics                  topics steered by popular YouTube titles for config shorts.interests
  shorts wiki-topics | wiki-script <title> <out> | wiki-image <title> <out>
                                       "everything in the world" slots: random Korean Wikipedia topics, script, lead image
  sns scrape <platform> <handle> | run [--heal] | heal
                                       public YouTube/Instagram/Threads/TikTok profiles; heal rewrites a broken selector
  bounty [--report]                    paying GitHub issues (Algora) a Mac lane could win; --report tells owner + backlog
  decide --text T [--source S]         add a standing decision of the owner's to the ledger every pane reads
  decisions                            print the decision ledger
  notify --level now|later --text T    an alert: now = 도리방 at once, later = in the next morning briefing
  mac windows | look --app A          Mac windows, or one app's controls by name (OmO desktop engine, inside Herdr)
  mac do --text "계산기로 6 곱하기 7" [--no-send]
                                       a spoken request: DeepSeek picks one action at a time from the controls by name,
                                       Sonnet after two failures (or when the text says 소넷); a repeat runs its learned steps;
                                       도리방 "맥 …" / "맥에서 …" queues the same for 맥손
  mac press --app A --steps "a,b|c" [--expect V] [--no-send]
                                       press controls by name in the background, before/after photos to 도리방;
                                       a pay/delete/send/post step waits for 진행 in 도리방; outside Herdr it queues for 맥손
  mac recipe save <name> --app A --steps S [--expect V] | recipe run <name> | recipe list
  mac stop | resume                    the stop switch (도리방 "멈춰" / "재개"); the chord ctrl+alt+shift+escape stops too
  mac selftest [--report] | serve      6×7 on Calculator; serve is the 맥손 tab (queue + daily self-test)
  dorichat                             도리방 listener: approval button presses and the owner's text -> lead inbox
  briefing [--no-send]                 morning briefing (finished/working/lost lanes, faults, shorts, approvals, cost) to Telegram
  upstream [--report] | apply <branch>  merge the original repo in a throwaway worktree + CI; apply fast-forwards live after a yes
  incidents [--report]                 repeating faults in Dori's own logs; --report files issue + backlog + tells owner
  render-er <log-dir> [--rerun]        diagnose MoviePy/ffmpeg logs; --rerun runs only curable failed jobs via hooks.render
  er     [--loop MIN]                  infirmary: ER <key> <rate-limit|model-dead|context-overflow|auth> -> prescription
  inbound slack|telegram [--loop MIN]  print INBOUND lines: Slack unread thread replies / Telegram owner DMs, edits and media + configured topic
                                       the Dori posted in (any helper), DMs and channels with unread mentions`;

const config = await loadConfig().catch((e: unknown) =>
  e instanceof ConfigError ? die(e.message) : Promise.reject(e),
);
const deps: FlowDeps = { run, clock: realClock, registry: new Registry(config.stateDir), config };
const [command = "", ...rest] = process.argv.slice(2);

const flags = parseArgs({
  args: rest,
  allowPositionals: true,
  strict: false,
  options: {
    title: { type: "string" },
    brief: { type: "string" },
    done: { type: "string" },
    thread: { type: "string" },
    model: { type: "string" },
    cwd: { type: "string" },
    pane: { type: "string" },
    evidence: { type: "string" },
    reason: { type: "string", multiple: true },
    note: { type: "string" },
    write: { type: "boolean" },
    loop: { type: "string" },
    to: { type: "string" },
    text: { type: "string" },
    edit: { type: "string" },
    kind: { type: "string" },
    step: { type: "string" },
    result: { type: "string" },
    "remote-effect": { type: "string", multiple: true },
    "wall-minutes": { type: "string" },
    "token-limit": { type: "string" },
    "cost-limit": { type: "string" },
    "activity-path": { type: "string", multiple: true },
    rule: { type: "string" },
    outcome: { type: "string" },
    lesson: { type: "string" },
    "dry-run": { type: "boolean" },
    global: { type: "boolean" },
    source: { type: "string" },
    open: { type: "boolean" },
    "no-devin": { type: "boolean" },
    month: { type: "string" },
    rerun: { type: "boolean" },
    topic: { type: "string" },
    pick: { type: "string" },
    script: { type: "string" },
    "no-send": { type: "boolean" },
    auto: { type: "boolean" },
    heal: { type: "boolean" },
    report: { type: "boolean" },
    level: { type: "string" },
    app: { type: "string" },
    steps: { type: "string" },
    expect: { type: "string" },
  },
});

const commands: Readonly<Record<string, Command>> = {
  ...journalCommands,
  ...laneCommands,
  ...opsCommands,
  ...messengerCommands,
  ...routeCommands,
  ...huntCommands,
  ...shortsCommands,
  ...snsCommands,
  ...incidentsCommands,
  ...bountyCommands,
  ...upstreamCommands,
  ...briefingCommands,
  ...dorichatCommands,
  ...decisionsCommands,
  ...notifyCommands,
  ...macCommands,
};
const handler = Object.hasOwn(commands, command) ? commands[command] : undefined;

try {
  if (handler) await handler(makeCli(command, rest, flags, config, deps));
  else {
    console.log(USAGE);
    process.exit(command ? 1 : 0);
  }
} catch (e) {
  if (e instanceof LaunchError || [...messengerErrors, ...journalErrors].some((type) => e instanceof type))
    die((e as Error).message);
  throw e;
}
