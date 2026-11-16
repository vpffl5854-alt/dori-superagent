import { expect, test } from "bun:test";

import { SOCKET_PATH_MAX, socketPathLength, socketRootBase } from "./socket-budget.ts";

const session = "e2e-123456";
const sized = (n: number) => `/${"t".repeat(n - 1)}`;

test("the budget counts a terminal holder's socket, the longest name hc creates", () => {
  const coreOnly = (tmp: string) => `${tmp}/dhc-XXXXXX/r/herdr-core/${session}.sock`.length;
  const holder = (tmp: string) => `${tmp}/dhc-XXXXXX/r/herdr-core/${session}.holder.fe8a46d1.sock`.length;
  // A tmpdir where the core socket fits but a holder socket would not.
  const tmp = sized(SOCKET_PATH_MAX - coreOnly("") - 1);
  expect(coreOnly(tmp)).toBeLessThanOrEqual(SOCKET_PATH_MAX);
  expect(holder(tmp)).toBeGreaterThan(SOCKET_PATH_MAX);
  expect(socketPathLength(tmp, session)).toBe(holder(tmp));
  expect(socketRootBase(tmp, session)).toBe("/tmp");
});

test("a tmpdir with room for the holder socket is kept", () => {
  const tmp = sized(SOCKET_PATH_MAX - socketPathLength("", session));
  expect(socketPathLength(tmp, session)).toBe(SOCKET_PATH_MAX);
  expect(socketRootBase(tmp, session)).toBe(tmp);
});
