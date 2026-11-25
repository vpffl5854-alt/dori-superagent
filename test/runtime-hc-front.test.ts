import { describe, expect, test } from "bun:test";
import { terminal } from "./fake-hc.ts";
import { rig, T1 } from "./hc-rig.ts";

// #209: hc reported a status but no `foreground`. The terminal's root process is pid 900 (terminal()'s default); the
// rows are `ps -A -ww -o pid=,pgid=,tpgid=,tty=,args=` output in the shape macOS printed for the e2e fixture.
const FIXTURE = 'sh -c . "$0" /w/test/fixtures/fake-agent-7501.sh';
const table = (...rows: string[]): string => `${rows.join("\n")}\n`;
const absent = (app = "fake") => terminal({ foreground: null, status: { state: "idle", app } });

const shown = (ps: string | undefined, app = "fake") => {
  const r = rig({ t1: absent(app) });
  if (ps !== undefined) r.fake.knobs.ps = ps;
  return r;
};

describe("hc foreground missing: the OS process table must show the agent in front", () => {
  test.each([
    [
      "the fixture typed into the login shell (its own job group in front)",
      table(
        "  900   900   950 ttys010  /bin/zsh",
        "  970   969   950 ttys010  /bin/zsh",
        `  950   950   950 ttys010  ${FIXTURE} --append-system-prompt /w/prompts/lead.md`,
        "  951   950   950 ttys010  sleep 2",
      ),
      "fake",
    ],
    ["the fixture as the terminal's root process", table(`  900   900   900 ttys023  ${FIXTURE}`), "fake"],
    [
      "an agent named by its executable",
      table("  900   900   950 ttys001  -zsh", "  950   950   950 ttys001  /usr/local/bin/omo --resume"),
      "omo",
    ],
  ])("%s: delivered", async (_, ps, app) => {
    const { fake, rt } = shown(ps, app);
    expect((await rt.deliver(T1, "hi")).kind).toBe("delivered");
    expect(fake.sent).toEqual([{ id: "t1", text: "hi" }]);
  });

  test.each([
    [
      "suspended: the login shell has the terminal back",
      table("  900   900   900 ttys010  /bin/zsh", `  950   950   900 ttys010  ${FIXTURE}`),
    ],
    [
      "a stale report with another program in front (python3 after the agent was suspended)",
      table(
        "  900   900   980 ttys010  /bin/zsh",
        `  950   950   980 ttys010  ${FIXTURE}`,
        "  980   980   980 ttys010  python3 -q",
      ),
    ],
    [
      "a program that only takes the app's file as an argument",
      table("  900   900   980 ttys010  /bin/zsh", "  980   980   980 ttys010  vim /w/fake-agent-7501.sh"),
    ],
    [
      "an interactive shell in the agent's group",
      table(
        "  900   900   950 ttys010  /bin/zsh",
        `  950   950   950 ttys010  ${FIXTURE}`,
        "  952   950   950 ttys010  bash",
      ),
    ],
    ["nothing provable: ps fails", undefined],
    ["nothing provable: the root is not listed", table(`  950   950   950 ttys010  ${FIXTURE}`)],
    ["nothing provable: the root has no terminal", table("  900   900     0 ??       sh -c x /w/fake-agent-7501.sh")],
    ["nothing provable: nothing is in the foreground group", table("  900   900   950 ttys010  /bin/zsh")],
  ])("%s: no-agent, nothing typed", async (_, ps) => {
    const { fake, rt } = shown(ps);
    expect(await rt.deliver(T1, "secret text")).toEqual({ kind: "no-agent" });
    expect(fake.calls.some((c) => c[0] === "send")).toBe(false);
  });

  test.each([
    ["a shell command that only edits a file named like the app", "sh -c vim /w/omo.md"],
    ["a shell command that only reads a log named like a platform build", "sh -c tail -f /var/log/omo-2026.log"],
    ["a shell command that only edits the file $0 names", 'sh -c vim "$0" /w/omo.md'],
    ["a shell command that only prints the path $0 names", "sh -c echo $0 /w/omo-x.sh"],
  ])("%s: no-agent, nothing typed", async (_, args) => {
    const { fake, rt } = shown(
      table("  900   900   980 ttys010  /bin/zsh", `  980   980   980 ttys010  ${args}`),
      "omo",
    );
    expect(await rt.deliver(T1, "secret text")).toEqual({ kind: "no-agent" });
    expect(fake.calls.some((c) => c[0] === "send")).toBe(false);
  });

  test("the probe carries the group it read", async () => {
    const { rt } = shown(table("  900   900   950 ttys010  /bin/zsh", `  950   950   950 ttys010  ${FIXTURE}`));
    const p = await rt.probe(T1);
    expect(p).toMatchObject({ status: "idle", agent: "fake", pgid: 950, rootPid: 900, shellInFront: false });
    expect(p.foreground?.map((f) => f.pid)).toEqual([950]);
  });

  test("a foreground hc names still decides: its shell is refused whatever ps shows", async () => {
    const { fake, rt } = rig({ t1: terminal({ foreground: { name: "zsh", argv: ["-zsh"], pid: 900 } }) });
    fake.knobs.ps = table("  900   900   950 ttys010  -zsh", "  950   950   950 ttys010  /usr/local/bin/omo");
    expect(await rt.deliver(T1, "x")).toEqual({ kind: "no-agent" });
    expect(fake.sent).toEqual([]);
  });
});
