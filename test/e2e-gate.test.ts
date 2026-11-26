import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Real CLI processes on a temporary DORI_HOME: a fake gh and a hook reviewer stand in for GitHub and the model.
const cli = resolve(import.meta.dir, "../src/cli.ts");
const head = "c".repeat(40);

function script(path: string, body: string): void {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

test("CLI: a failed review at the head removes the CLEAR receipt that merge would have used", async () => {
  const home = mkdtempSync(join(tmpdir(), "dori-gate-e2e-"));
  const bin = join(home, "bin");
  mkdirSync(bin);
  script(
    join(bin, "gh"),
    `#!/bin/sh
case "$1 $2" in
"pr view") printf '{"headRefOid":"%s"}\\n' "$GH_HEAD" ;;
"pr checks") printf '[{"name":"ci","bucket":"pass"}]\\n' ;;
"pr merge") exit 0 ;;
"api "*) printf '{"total_count":0,"workflow_runs":[]}\\n' ;;
*) exit 1 ;;
esac
`,
  );
  const mode = join(home, "review-mode");
  const reviewer = join(home, "reviewer.sh");
  script(
    reviewer,
    `#!/bin/sh
case "$(cat "$1")" in
clear) printf 'no findings\\nVERDICT: CLEAR\\n' ;;
block) printf 'finding\\nVERDICT: BLOCK\\n' ;;
fail) printf 'partial output\\n'; exit 9 ;;
failclear) printf 'no findings\\nVERDICT: CLEAR\\n'; exit 9 ;;
noverdict) printf 'partial output\\n' ;;
esac
`,
  );
  writeFileSync(join(home, "config.json"), JSON.stringify({ hooks: { reviewCommand: ["/bin/sh", reviewer, mode] } }));
  const env = {
    ...process.env,
    DORI_HOME: home,
    DORI_TELEMETRY: "0",
    GH_HEAD: head,
    PATH: `${bin}:${process.env["PATH"] ?? ""}`,
  };
  const run = async (...argv: string[]) => {
    const proc = Bun.spawn([process.execPath, cli, ...argv], { env, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { out, err, code };
  };
  const setMode = (m: string) => writeFileSync(mode, m);
  const receipts = () => readdirSync(join(home, "receipts"));
  const merge = async () => {
    const r = await run("merge", "o/r#123", "--dry-run");
    return { code: r.code, message: r.out.trim() || r.err.trim() };
  };
  const refused = async (why: string) => {
    const r = await merge();
    expect(r.code).toBe(2);
    expect(r.message).toContain(`MERGE_REFUSED ${why}`);
  };

  setMode("clear");
  const first = await run("review", "o/r#123");
  expect(first.code).toBe(0);
  expect(first.out).toContain(`REVIEW o/r#123 head=${head} verdict=CLEAR`);
  expect(await merge()).toEqual({ code: 0, message: `MERGE_OK o/r#123 head=${head} (dry run)` });

  setMode("noverdict");
  const ambiguous = await run("review", "o/r#123");
  expect(ambiguous.code).toBe(1);
  expect(ambiguous.err).toContain("no VERDICT");
  expect(receipts().filter((n) => n.endsWith(".json"))).toEqual([]);
  expect(receipts().filter((n) => n.endsWith(".noverdict.txt"))).toHaveLength(1);
  await refused(`no review receipt at head ${head.slice(0, 12)}`);

  setMode("failclear");
  const failed = await run("review", "o/r#123");
  expect(failed.code).toBe(1);
  expect(failed.err).toContain("reviewer exited 9");
  expect(receipts().filter((n) => n.endsWith(".json"))).toEqual([]);
  expect(receipts().filter((n) => n.endsWith(".noverdict.txt"))).toHaveLength(2);
  await refused(`no review receipt at head ${head.slice(0, 12)}`);

  setMode("clear");
  expect((await run("review", "o/r#123")).code).toBe(0);
  expect((await merge()).code).toBe(0);

  setMode("block");
  const blocked = await run("review", "o/r#123");
  expect(blocked.code).toBe(1);
  expect(blocked.out).toContain(`REVIEW o/r#123 head=${head} verdict=BLOCK`);
  await refused(`review at ${head.slice(0, 12)} is BLOCK`);
});
