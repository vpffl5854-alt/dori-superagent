import { describe, expect, test } from "bun:test";
import { join } from "node:path";

type Workflow = {
  readonly name: string;
  readonly on: Record<string, unknown>;
  readonly permissions: Record<string, string>;
  readonly jobs: Record<string, { readonly steps: { readonly uses?: string }[] }>;
};

const WORKFLOWS = join(import.meta.dir, "..", ".github", "workflows");

async function workflow(file: string): Promise<Workflow> {
  return Bun.YAML.parse(await Bun.file(join(WORKFLOWS, file)).text()) as Workflow;
}

describe("CLA workflows keep fork code away from secrets and write tokens", () => {
  test("no workflow is triggered by pull_request_target", async () => {
    const files = await Array.fromAsync(new Bun.Glob("*.{yml,yaml}").scan(WORKFLOWS));
    expect(files).toContain("cla.yml");
    for (const file of files) {
      expect(Object.keys((await workflow(file)).on), file).not.toContain("pull_request_target");
    }
  });

  test("the workflow holding the write token starts only from the default branch and checks nothing out", async () => {
    const cla = await workflow("cla.yml");
    expect(Object.keys(cla.on).sort()).toEqual(["issue_comment", "workflow_run"]);
    const steps = Object.values(cla.jobs).flatMap((job) => job.steps);
    expect(
      steps.filter((s) => s.uses?.startsWith("actions/checkout") || s.uses?.includes("download-artifact")),
    ).toEqual([]);
  });

  test("the workflow a fork can edit has no permissions, no secrets and no checkout", async () => {
    const text = await Bun.file(join(WORKFLOWS, "cla-request.yml")).text();
    const request = Bun.YAML.parse(text) as Workflow;
    expect(Object.keys(request.on)).toEqual(["pull_request"]);
    expect(request.permissions).toEqual({});
    expect(text).not.toContain("secrets.");
    expect(text).not.toContain("github.token");
    expect(Object.values(request.jobs).flatMap((job) => job.steps.map((s) => s.uses))).toEqual([undefined]);
  });

  test("cla.yml waits for the workflow name that cla-request.yml declares", async () => {
    const cla = await workflow("cla.yml");
    const request = await workflow("cla-request.yml");
    expect((cla.on["workflow_run"] as { workflows: string[] }).workflows).toEqual([request.name]);
  });
});
