// A Unix socket path is capped at 104 bytes on macOS and 108 on Linux, counting the closing NUL. An hc core keeps its
// sockets in <root>/r/herdr-core/: <session>.sock for the core, and <session>.holder.<8 hex>.sock for each terminal's
// holder (hc 0.1.17), the longest name it creates. The budget counts that one.
export const SOCKET_PATH_MAX = 100;
const SOCKET_DIR = "/dhc-XXXXXX/r/herdr-core/";
const LONGEST_SOCKET_SUFFIX = ".holder.00000000.sock";

export const socketPathLength = (tmp: string, session: string): number =>
  tmp.length + SOCKET_DIR.length + session.length + LONGEST_SOCKET_SUFFIX.length;

/** The directory the isolated core's root goes under: the given tmpdir while every socket fits, else /tmp. */
export const socketRootBase = (tmp: string, session: string): string =>
  socketPathLength(tmp, session) <= SOCKET_PATH_MAX ? tmp : "/tmp";
