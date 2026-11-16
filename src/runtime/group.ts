import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

const realOrResolved = (path: string): string => {
  const resolved = resolve(path);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
};

/** The session group of one store root: 8 hex chars of sha256 over the resolved path, so two homes never share one. */
export function groupId(storeRoot: string): string {
  return createHash("sha256").update(realOrResolved(storeRoot)).digest("hex").slice(0, 8);
}
