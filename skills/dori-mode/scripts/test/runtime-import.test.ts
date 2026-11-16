import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

// The scripts import the session runtime from the clone's src/runtime by relative path: install.sh links the skill
// into the clone, so ../../../../src/runtime is the clone's own. A copy of the skill outside the clone has no such path.
const RUNTIME = join(import.meta.dir, "../../../../src/runtime/types.ts");

test("the session runtime resolves from the clone the skill lives in", async () => {
  if (!existsSync(RUNTIME))
    throw new Error(
      `dori-mode scripts need the dori-superagent clone around them (${RUNTIME} is missing): the skill was copied out of the clone; link it with install.sh instead`,
    );
  const types = await import("../../../../src/runtime/types.ts");
  expect(types.parseRef("hc:t7")).toEqual({ runtime: "hc", id: "t7" });
  expect(types.formatRef({ runtime: "hc", id: "t7" })).toBe("hc:t7");
});
