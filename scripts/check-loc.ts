/**
 * The 250-line rule: no TypeScript source or test file may exceed MAX_LINES. There are no exceptions.
 *
 * Prints `LOC_OK <n> files` and exits 0, or one `LOC_OVER` line per file over the cap and exits 1.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { Glob } from "bun";

const MAX_LINES = 250;
const ROOTS = ["src", "test", "skills/dori-mode/scripts/src", "skills/dori-mode/scripts/test"] as const;

const countLines = (text: string): number => {
  const pieces = text.split("\n");
  return pieces.at(-1) === "" ? pieces.length - 1 : pieces.length;
};

const sourceFiles = (root: string): string[] => {
  const files: string[] = [];
  for (const dir of ROOTS) {
    if (!existsSync(join(root, dir))) continue;
    for (const file of new Glob("**/*.ts").scanSync({ cwd: join(root, dir), onlyFiles: true })) {
      const rel = relative(root, join(root, dir, file))
        .split(sep)
        .join("/");
      if (!rel.split("/").includes("node_modules")) files.push(rel);
    }
  }
  return files.sort();
};

const checkLoc = (root: string): { readonly files: number; readonly problems: readonly string[] } => {
  const files = sourceFiles(root);
  const problems: string[] = [];
  for (const file of files) {
    const n = countLines(readFileSync(join(root, file), "utf8"));
    if (n > MAX_LINES) problems.push(`LOC_OVER ${file} ${n}`);
  }
  return { files: files.length, problems };
};

if (import.meta.main) {
  const { files, problems } = checkLoc(process.cwd());
  for (const p of problems) console.log(p);
  if (problems.length) process.exit(1);
  console.log(`LOC_OK ${files} files`);
}
