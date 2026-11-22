import { expect, test } from "bun:test";

import { diagnoseRender, planRenders, renderLine } from "../src/render-er.ts";

/** Captured from ffmpeg 7 on this Mac: `-c:v libnotreal` and a missing input. */
const FFMPEG_NO_ENCODER = `[vost#0:0 @ 0x7aecc3c000] Error selecting an encoder
Error opening output file out.mp4.
Error opening output files: Encoder not found`;
const FFMPEG_NO_INPUT = `Error opening input file /tmp/nope-input.mp3.
Error opening input files: No such file or directory`;

test.each([
  ["FileNotFoundError: [Errno 2] No such file or directory: 'ffmpeg'", "ffmpeg-missing"],
  [FFMPEG_NO_ENCODER, "codec"],
  ["OSError: cannot open resource", "font"],
  ["OSError: MoviePy error: Accessing time t=31.02-31.06 seconds, with clip duration=30 seconds", "audio-duration"],
  [FFMPEG_NO_INPUT, "missing-input"],
  ["Killed", "out-of-memory"],
  ["subprocess.TimeoutExpired: Command timed out", "timeout"],
  ["Traceback (most recent call last):\n  ValueError: bad frame", "unknown"],
] as const)("%p is %p", (log, kind) => {
  expect(diagnoseRender("j", log)?.kind).toBe(kind);
});

test("a clean log is not a finding", () => {
  expect(diagnoseRender("j", "MoviePy - Writing video out.mp4\nMoviePy - Done !")).toBeNull();
});

test("only memory and timeout failures are rerun; setup and script causes are held with their fix", () => {
  const plan = planRenders([
    { job: "ok", log: "MoviePy - Done !" },
    { job: "oom", log: "MemoryError" },
    { job: "codec", log: FFMPEG_NO_ENCODER },
    { job: "slow", log: "Connection reset by peer" },
    { job: "font", log: "OSError: cannot open resource" },
  ]);
  expect(plan.rerun).toEqual(["oom", "slow"]);
  expect(plan.findings.map((f) => `${f.job}:${f.kind}:${f.rerun}`)).toEqual([
    "oom:out-of-memory:true",
    "codec:codec:false",
    "slow:timeout:true",
    "font:font:false",
  ]);
});

test("the RENDER line names the job, the cause, rerun or hold, and the fix", () => {
  const f = diagnoseRender("ep12", "OSError: cannot open resource");
  expect(f && renderLine(f)).toBe(
    'RENDER ep12 font -> hold "give TextClip an absolute path to an installed font file (a Korean one such as NotoSansKR for Korean captions)"',
  );
});
