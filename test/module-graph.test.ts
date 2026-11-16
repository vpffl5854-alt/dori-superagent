import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { Glob } from "bun";

const ROOT = resolve(import.meta.dir, "..");
const TREES = ["src", "skills/dori-mode/scripts/src"];
// The skill CLI runs its command at import; it is an entry point, never imported.
const ENTRY_ONLY = new Set(["skills/dori-mode/scripts/src/cli.ts"]);

const modules = (): string[] =>
  TREES.flatMap((tree) =>
    [...new Glob("**/*.ts").scanSync({ cwd: join(ROOT, tree) })].map((file) => join(tree, file)),
  ).sort();

/** Relative imports that load the module at run time: `import type` is erased, an inline `type` specifier is not. */
const runtimeImports = (file: string): string[] =>
  [
    ...readFileSync(join(ROOT, file), "utf8").matchAll(/^(?:import|export)\s+(?!type\b)[^;]*?\sfrom\s+"(\.[^"]+)"/gm),
  ].map((m) => relative(ROOT, resolve(dirname(join(ROOT, file)), m[1] ?? "")));

test("no module imports a module that imports it back", () => {
  const graph = new Map(modules().map((file) => [file, runtimeImports(file)]));
  const cycles: string[] = [];
  const done = new Set<string>();
  const visit = (file: string, path: string[]): void => {
    const at = path.indexOf(file);
    if (at >= 0) {
      cycles.push([...path.slice(at), file].join(" -> "));
      return;
    }
    if (done.has(file)) return;
    for (const next of graph.get(file) ?? []) if (graph.has(next)) visit(next, [...path, file]);
    done.add(file);
  };
  for (const file of graph.keys()) visit(file, []);
  expect(cycles).toEqual([]);
});

test("every module loads on its own in a fresh process", async () => {
  const files = modules().filter((file) => !ENTRY_ONLY.has(file));
  expect(files.length).toBeGreaterThan(50);
  const failures: string[] = [];
  await Promise.all(
    files.map(async (file) => {
      const proc = Bun.spawn([process.execPath, "-e", `await import(${JSON.stringify(join(ROOT, file))})`], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, err] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
      if (code !== 0 || err.trim()) failures.push(`${file}: exit ${code} ${err.trim().split("\n")[0] ?? ""}`);
    }),
  );
  expect(failures).toEqual([]);
}, 60_000);
