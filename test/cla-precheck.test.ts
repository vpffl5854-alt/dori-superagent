import { describe, expect, test } from "bun:test";
import { join } from "node:path";

// The check is executed the way actions/github-script runs it: the script text from the shipped cla.yml as the body of
// an async function whose parameters are github, context and core. process is passed in too, so the script reads the
// workflow's own env block instead of this test process's environment.
type Commit = { readonly author: { readonly login: string; readonly id: number } | null };
type Comment = { readonly id: number; readonly user: { readonly login: string }; readonly body: string };
type Pull = {
  readonly number: number;
  readonly head: { readonly sha: string; readonly repo: { readonly id: number } };
};
type Status = { readonly sha: string; readonly context: string; readonly state: string };
type Step = {
  readonly name?: string;
  readonly uses?: string;
  readonly run?: string;
  readonly with?: { script?: string };
};
type Workflow = {
  readonly on: Record<string, unknown>;
  readonly permissions: Record<string, string>;
  readonly env?: Record<string, string>;
  readonly jobs: Record<string, { readonly steps: Step[] }>;
};

const WORKFLOWS = join(import.meta.dir, "..", ".github", "workflows");
const BOT = "github-actions[bot]";
const MARKER = "CLA Assistant Lite bot";

async function workflow(file: string): Promise<Workflow> {
  return Bun.YAML.parse(await Bun.file(join(WORKFLOWS, file)).text()) as Workflow;
}

const workflowRun = (sha: string, repoId: number) => ({
  eventName: "workflow_run",
  payload: {
    workflow_run: { head_sha: sha, head_branch: "patch-1", head_repository: { id: repoId, owner: { login: "fork" } } },
  },
});
const signingComment = { eventName: "issue_comment", payload: { issue: { number: 7 } } };

type World = {
  readonly event: { readonly eventName: string; readonly payload: unknown };
  readonly pulls?: readonly Pull[];
  readonly commits?: readonly Commit[];
  readonly signed?: readonly { id: number; name: string }[];
  readonly comments?: readonly Comment[];
  readonly signatureFile?: unknown;
};

async function runCheck(world: World) {
  const parsed = await workflow("cla.yml");
  const script = parsed.jobs["cla"]?.steps.find((s) => s.name === "Check stored CLA signatures")?.with?.script;
  if (script === undefined) throw new Error("cla.yml has no 'Check stored CLA signatures' step with a script");

  const pulls = world.pulls ?? [{ number: 7, head: { sha: "abc", repo: { id: 1 } } }];
  const statuses: Status[] = [];
  const created: { issue_number: number; body: string }[] = [];
  const updated: { comment_id: number; body: string }[] = [];
  const failed: string[] = [];
  const listed: { head: string | undefined; state: string | undefined }[] = [];
  const signatureFile = world.signatureFile ?? {
    type: "file",
    encoding: "base64",
    content: Buffer.from(JSON.stringify({ signedContributors: world.signed ?? [] })).toString("base64"),
  };
  const rest = {
    repos: {
      getContent: async () => ({ data: signatureFile }),
      createCommitStatus: async (status: Status) => {
        statuses.push({ sha: status.sha, context: status.context, state: status.state });
      },
    },
    pulls: {
      list: Symbol("pulls.list"),
      listCommits: Symbol("pulls.listCommits"),
      get: async ({ pull_number }: { pull_number: number }) => ({ data: pulls.find((p) => p.number === pull_number) }),
    },
    issues: {
      listComments: Symbol("issues.listComments"),
      createComment: async (comment: { issue_number: number; body: string }) => {
        created.push(comment);
      },
      updateComment: async (comment: { comment_id: number; body: string }) => {
        updated.push(comment);
      },
    },
  };
  const github = {
    rest,
    paginate: async (fn: unknown, params: { head?: string; state?: string }) => {
      if (fn === rest.pulls.list) {
        listed.push({ head: params.head, state: params.state });
        return [...pulls];
      }
      if (fn === rest.pulls.listCommits) return [...(world.commits ?? [])];
      if (fn === rest.issues.listComments) return [...(world.comments ?? [])];
      throw new Error("paginate called with an unexpected endpoint");
    },
  };
  const context = { ...world.event, repo: { owner: "o", repo: "r" }, serverUrl: "https://github.com", runId: 1 };
  const core = {
    info: () => {},
    notice: () => {},
    setFailed: (s: string) => {
      failed.push(s);
    },
  };
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
    ...args: string[]
  ) => (github: unknown, context: unknown, core: unknown, process: unknown) => Promise<void>;
  await new AsyncFunction("github", "context", "core", "process", script)(github, context, core, { env: parsed.env });
  return { statuses, created, updated, failed, listed };
}

const linked = (login: string, id: number): Commit => ({ author: { login, id } });
const unlinked: Commit = { author: null };
const failure = [{ sha: "abc", context: "cla", state: "failure" }];
const success = [{ sha: "abc", context: "cla", state: "success" }];

describe("cla.yml stored-signature check", () => {
  test("a pull request made only of commits with no linked GitHub author fails the cla status", async () => {
    const { statuses, created, failed } = await runCheck({
      event: workflowRun("abc", 1),
      commits: [unlinked, unlinked],
    });
    expect(failed).toEqual([]);
    expect(statuses).toEqual(failure);
    expect(created.length).toBe(1);
  });

  test("an allowlisted author plus one unlinked commit still fails the cla status", async () => {
    const { statuses } = await runCheck({
      event: workflowRun("abc", 1),
      commits: [linked("code-yeongyu", 11153873), unlinked],
    });
    expect(statuses).toEqual(failure);
  });

  test("only allowlisted or signed linked authors pass and get no comment", async () => {
    const { statuses, created, updated } = await runCheck({
      event: workflowRun("abc", 1),
      commits: [linked("code-yeongyu", 11153873), linked("someone", 42), linked("dependabot[bot]", 49699333)],
      signed: [{ id: 42, name: "someone" }],
    });
    expect(statuses).toEqual(success);
    expect(created).toEqual([]);
    expect(updated).toEqual([]);
  });

  test("an unsigned author gets one sign request the CLA action will recognise as its own", async () => {
    const { statuses, created } = await runCheck({ event: workflowRun("abc", 1), commits: [linked("newcomer", 99)] });
    expect(statuses).toEqual(failure);
    expect(created.map((c) => c.issue_number)).toEqual([7]);
    expect(created[0]?.body).toContain(MARKER);
  });

  test("an existing sign request is not posted or rewritten again", async () => {
    const { created, updated } = await runCheck({
      event: workflowRun("abc", 1),
      commits: [linked("newcomer", 99)],
      comments: [{ id: 5, user: { login: BOT }, body: `please sign <sub>Posted by the **${MARKER}**.</sub>` }],
    });
    expect(created).toEqual([]);
    expect(updated).toEqual([]);
  });

  test("a comment carrying the marker from someone other than the bot does not stand in for the sign request", async () => {
    const { created } = await runCheck({
      event: workflowRun("abc", 1),
      commits: [linked("newcomer", 99)],
      comments: [{ id: 5, user: { login: "newcomer" }, body: MARKER }],
    });
    expect(created.length).toBe(1);
  });

  test("a sign request left over after every author signed is replaced once", async () => {
    const { statuses, updated } = await runCheck({
      event: signingComment,
      commits: [linked("newcomer", 99)],
      signed: [{ id: 99, name: "newcomer" }],
      comments: [{ id: 5, user: { login: BOT }, body: `please sign <sub>Posted by the **${MARKER}**.</sub>` }],
    });
    expect(statuses).toEqual(success);
    expect(updated.map((u) => u.comment_id)).toEqual([5]);
    expect(updated[0]?.body).toContain(MARKER);
  });

  test("workflow_run resolves the pull request by GitHub's head commit and head repository, not by anything else", async () => {
    const pulls = [
      { number: 3, head: { sha: "abc", repo: { id: 2 } } },
      { number: 4, head: { sha: "old", repo: { id: 1 } } },
      { number: 9, head: { sha: "abc", repo: { id: 1 } } },
    ];
    const { statuses, created, listed } = await runCheck({
      event: workflowRun("abc", 1),
      pulls,
      commits: [linked("newcomer", 99)],
    });
    expect(listed).toEqual([{ head: "fork:patch-1", state: "open" }]);
    expect(statuses).toEqual(failure);
    expect(created.map((c) => c.issue_number)).toEqual([9]);
  });

  test("a run whose head no longer belongs to an open pull request writes nothing", async () => {
    const { statuses, created, failed } = await runCheck({
      event: workflowRun("gone", 1),
      commits: [linked("newcomer", 99)],
    });
    expect({ statuses, created, failed }).toEqual({ statuses: [], created: [], failed: [] });
  });

  test("a signature file that is not a file fails the step instead of passing it", async () => {
    const { statuses, failed } = await runCheck({ event: workflowRun("abc", 1), signatureFile: [] });
    expect(failed).toEqual(["signatures/cla.json is not a file on cla-signatures"]);
    expect(statuses).toEqual([]);
  });
});
