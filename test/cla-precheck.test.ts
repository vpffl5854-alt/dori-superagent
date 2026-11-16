import { describe, expect, test } from "bun:test";
import { join } from "node:path";

// The pre-check is executed the way actions/github-script runs it: the script text from the shipped cla.yml as the
// body of an async function whose parameters are github, context and core.
type Commit = { readonly author: { readonly login: string; readonly id: number } | null };
type Outputs = { readonly outputs: Record<string, string>; readonly info: string[]; readonly failed: string[] };

const WORKFLOW = join(import.meta.dir, "..", ".github", "workflows", "cla.yml");

async function precheckScript(): Promise<string> {
  const parsed = Bun.YAML.parse(await Bun.file(WORKFLOW).text()) as {
    jobs: { cla: { steps: { name?: string; with?: { script?: string } }[] } };
  };
  const step = parsed.jobs.cla.steps.find((s) => s.name === "Check stored CLA signatures");
  const script = step?.with?.script;
  if (script === undefined) throw new Error("cla.yml has no 'Check stored CLA signatures' step with a script");
  return script;
}

async function runPrecheck(
  commits: readonly Commit[],
  signed: readonly { id: number; name: string }[],
): Promise<Outputs> {
  const outputs: Record<string, string> = {};
  const info: string[] = [];
  const failed: string[] = [];
  const signatureContent = Buffer.from(JSON.stringify({ signedContributors: signed })).toString("base64");
  const listCommits = Symbol("listCommits");
  const github = {
    rest: {
      repos: { getContent: async () => ({ data: { type: "file", content: signatureContent, encoding: "base64" } }) },
      pulls: { listCommits },
    },
    paginate: async (fn: unknown) => {
      if (fn !== listCommits) throw new Error("paginate called with something other than pulls.listCommits");
      return [...commits];
    },
  };
  const context = { repo: { owner: "o", repo: "r" }, payload: { pull_request: { number: 7 } } };
  const core = {
    setOutput: (k: string, v: string) => {
      outputs[k] = v;
    },
    info: (s: string) => {
      info.push(s);
    },
    setFailed: (s: string) => {
      failed.push(s);
    },
  };
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
    ...args: string[]
  ) => (github: unknown, context: unknown, core: unknown) => Promise<void>;
  await new AsyncFunction("github", "context", "core", await precheckScript())(github, context, core);
  return { outputs, info, failed };
}

const linked = (login: string, id: number): Commit => ({ author: { login, id } });
const unlinked: Commit = { author: null };

describe("cla.yml stored-signature pre-check", () => {
  test("a pull request made only of commits with no linked GitHub author goes to CLA Assistant", async () => {
    const { outputs, info, failed } = await runPrecheck([unlinked, unlinked], []);
    expect(failed).toEqual([]);
    expect(outputs["needs_cla_action"]).toBe("true");
    expect(info.some((line) => line.includes("2 commit(s) have no linked GitHub author"))).toBe(true);
  });

  test("an allowlisted author plus one unlinked commit still goes to CLA Assistant", async () => {
    const { outputs } = await runPrecheck([linked("code-yeongyu", 11153873), unlinked], []);
    expect(outputs["needs_cla_action"]).toBe("true");
  });

  test("only allowlisted or signed linked authors short-circuit with the unchanged log line", async () => {
    const { outputs, info } = await runPrecheck(
      [linked("code-yeongyu", 11153873), linked("someone", 42), linked("dependabot[bot]", 49699333)],
      [{ id: 42, name: "someone" }],
    );
    expect(outputs["needs_cla_action"]).toBe("false");
    expect(info).toEqual(["All linked commit authors already signed the CLA or are allowlisted."]);
  });

  test("a linked author who has not signed goes to CLA Assistant by login", async () => {
    const { outputs, info } = await runPrecheck([linked("newcomer", 99)], []);
    expect(outputs["needs_cla_action"]).toBe("true");
    expect(info.some((line) => line.includes("unsigned contributors: newcomer"))).toBe(true);
  });

  test("a signature file that is not a file fails the step instead of passing it", async () => {
    const outputs: Record<string, string> = {};
    const failed: string[] = [];
    const github = {
      rest: { repos: { getContent: async () => ({ data: [] }) }, pulls: { listCommits: Symbol("x") } },
      paginate: async () => [],
    };
    const core = {
      setOutput: (k: string, v: string) => {
        outputs[k] = v;
      },
      info: () => {},
      setFailed: (s: string) => {
        failed.push(s);
      },
    };
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
      ...args: string[]
    ) => (github: unknown, context: unknown, core: unknown) => Promise<void>;
    await new AsyncFunction("github", "context", "core", await precheckScript())(
      github,
      { repo: { owner: "o", repo: "r" }, payload: { pull_request: { number: 7 } } },
      core,
    );
    expect(failed).toEqual(["signatures/cla.json is not a file on cla-signatures"]);
    expect(outputs["needs_cla_action"]).toBeUndefined();
  });
});
