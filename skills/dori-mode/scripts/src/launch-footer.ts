import { fileURLToPath } from "node:url";

import type { DoriConfig } from "./config.ts";
import type { Lane } from "./registry.ts";

// The footer names this CLI by path: a bare `dori` can resolve to the root harness, whose `report` accepts unknown
// flags and writes no journal, so a jsonl-v1 lane would read NO-REPORT for its whole life.
export const shellQuote = (s: string): string => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`);
/** `bun <cli>`, behind `env K=V ...` when the lane's own environment cannot carry `env` (an omo-host lane). */
export const cliCommand = (
  path: string = fileURLToPath(new URL("./cli.ts", import.meta.url)),
  env: Readonly<Record<string, string>> = {},
): string => {
  const assigns = Object.entries(env).map(([k, v]) => shellQuote(`${k}=${v}`));
  return `${assigns.length ? `env ${assigns.join(" ")} ` : ""}bun ${shellQuote(path)}`;
};
const CLI = cliCommand();

const FOOTER_HEADING = "## Lane footer (written by dori launch)";
export const BRIEF_START = "<!-- dori launch: the brief starts below -->";
const FOOTER_START = "<!-- dori launch: footer start -->";
const FOOTER_END = "<!-- dori launch: footer end -->";

// startLane writes the launch text over the brief before the tab exists, so a retry after a failed tab create reads a
// brief that already has lessons and a footer. Rebuild from the text between the markers launch wrote, so a retry ships
// what a first launch would. Only a file that ends with launch's footer is cut: the owner's text may quote the heading.
export const originalBrief = (text: string): string => {
  const brief = text.replace(/\s*$/, "");
  const foot = brief.endsWith(FOOTER_END) ? brief.lastIndexOf(`\n${FOOTER_START}\n`) : -1;
  if (foot === -1) return brief;
  const start = brief.indexOf(`${BRIEF_START}\n`);
  return brief.slice(start === -1 || start > foot ? 0 : start + BRIEF_START.length + 1, foot).replace(/\s*$/, "");
};

/**
 * The argv a lane sends its [REPORT] line to the lead with, by the lead's runtime. A lane in an agent session (omo-host)
 * has no terminal id in its environment to tell it which runtime the lead's pane is on, so the footer names the command.
 */
export const leadSendArgv = (kind: string | undefined, leadPane: string): readonly string[] | undefined =>
  !leadPane
    ? undefined
    : kind === "hc"
      ? ["hc", "send", leadPane, "--"]
      : kind === "herdr"
        ? ["herdr", "pane", "run", leadPane]
        : undefined;

export const footer = (
  lane: Lane,
  leadPane: string,
  identities: DoriConfig["repoIdentities"] = {},
  cli: string = CLI,
  leadSend: readonly string[] | undefined = undefined,
): string =>
  [
    "",
    FOOTER_START,
    FOOTER_HEADING,
    `- Key: ${lane.key}. Work thread: ${lane.thread}.`,
    `- Done = ${lane.done}. The lane closes only when every signal reads back live.`,
    `- Persist each milestone, blocker, question, halt and completion with ${cli} report ${lane.key} --kind milestone|blocker|question|halted|done --text "what, with evidence links". It appends reports.jsonl and prints the human [REPORT] line; ${leadSend ? `send that line to the lead as this argv array (the line as its last element), never a shell string: ${JSON.stringify([...leadSend, "[REPORT] ..."])}` : `send that line to pane ${leadPane || "(lead pane)"} as an argv array, never a shell string`}.`,
    ...(Object.keys(identities).length
      ? [
          "- Before committing, set the repository's identity below for that command only; never change the global Git identity. For a repository not listed, ask the lead for its identity before the first commit.",
          ...Object.entries(identities).map(
            ([repo, identity]) =>
              `  - ${repo}: git -c user.name=${quoteForPane(identity.name)} -c user.email=${quoteForPane(identity.email)} commit ...`,
          ),
        ]
      : []),
    `- Before claiming PR work done, run ${cli} verify-pr <owner/repo> <number>. A PR with source fix commits must change a test or carry a "No test: <reason>" line in its body; a fix commit without its own test is a warning. Run the printed UI test loop at the reported head before calling those tests stable.`,
    `- After each completed step: ${cli} checkpoint ${lane.key} --step <unique-step> --result <result> --evidence <path-or-URL> [--remote-effect <completed-push/merge/deploy-receipt>] (one flag per receipt).`,
    `- On resume, run ${cli} checkpoints ${lane.key} before doing work. Never repeat a recorded remote side effect. If a crash may have happened between the remote action and checkpoint, read the live remote receipt first and use the service's idempotency key; a local journal cannot make that remote action atomic.`,
    `- Supervision ceilings: ${JSON.stringify(lane.budget ?? {})}. A breach marks blocked and alerts; it never kills the agent. Report a blocker and wait for the lead's decision rather than overriding the ceiling.`,
    `- When done: ${cli} claim-done ${lane.key} --evidence "<merge SHA, closed issue, version>". See references/done-protocol.md.`,
    FOOTER_END,
    "",
  ].join("\n");

export const quoteForPane = (arg: string): string =>
  /^[\w./:@=-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
