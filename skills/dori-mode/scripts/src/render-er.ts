/**
 * The render hospital: reads each render job's MoviePy/ffmpeg log, names what broke (codec, font,
 * audio length, missing ffmpeg or input file, memory, timeout) and the fix, and reruns only the
 * jobs a rerun can cure. A job whose cause is in the setup or the script (a missing encoder, a font
 * path, audio longer than the video) is held with its fix, because running it again unchanged
 * fails the same way. A job with a clean log is never touched.
 */
export type RenderDiagnosis =
  | "ffmpeg-missing"
  | "codec"
  | "font"
  | "audio-duration"
  | "missing-input"
  | "out-of-memory"
  | "timeout"
  | "unknown";

type Sign = { readonly kind: RenderDiagnosis; readonly sign: RegExp; readonly fix: string; readonly rerun: boolean };

/** In order: a missing ffmpeg also prints "No such file", so it is named before missing-input. */
const SIGNS: readonly Sign[] = [
  {
    kind: "ffmpeg-missing",
    sign: /ffmpeg: command not found|No such file or directory: '?ffmpeg|ffmpeg (?:binary )?(?:was )?not found|IMAGEIO_FFMPEG_EXE/i,
    fix: "install ffmpeg (brew install ffmpeg) or point IMAGEIO_FFMPEG_EXE at it",
    rerun: false,
  },
  {
    kind: "codec",
    sign: /Unknown encoder|Encoder (?:\S+ )?not found|Error selecting an encoder|codec not currently supported in container|Could not find tag for codec|Invalid encoder type|codec [^\n]{0,40}not (?:found|supported)/i,
    fix: 'write mp4 with codec="libx264", audio_codec="aac" (check `ffmpeg -encoders` lists them)',
    rerun: false,
  },
  {
    kind: "font",
    sign: /cannot open resource|Font [^\n]{0,60}not found|fontconfig error|ImageMagick[^\n]{0,60}not (?:found|installed)|unknown font|OSError: [^\n]*\.(?:ttf|otf)/i,
    fix: "give TextClip an absolute path to an installed font file (a Korean one such as NotoSansKR for Korean captions)",
    rerun: false,
  },
  {
    kind: "audio-duration",
    sign: /Accessing time t=[\d.-]+ seconds, with clip duration=|exceeds? (?:the )?(?:clip |audio )?duration|t_end[^\n]{0,40}duration|index -?\d+ is out of bounds[^\n]*audio|AudioFileClip[^\n]*(?:IndexError|duration)/i,
    fix: "cut the audio to the video length (or the video to the audio): with_duration(min(audio.duration, video.duration))",
    rerun: false,
  },
  {
    kind: "missing-input",
    sign: /No such file or directory|could not be found|FileNotFoundError|does not exist/i,
    fix: "the input file is missing: check the image, audio or font path the job names",
    rerun: false,
  },
  {
    kind: "out-of-memory",
    sign: /MemoryError|Cannot allocate memory|\bKilled\b|signal 9|out of memory/i,
    fix: "rerun with fewer threads or a lower resolution once the host has memory",
    rerun: true,
  },
  {
    kind: "timeout",
    sign: /timed? ?out|TimeoutExpired|Connection reset|Temporary failure in name resolution/i,
    fix: "a transient stall; rerun",
    rerun: true,
  },
];

/** A log that shows a Python traceback or an ffmpeg error but no known sign is still a failure. */
const FAILED = /Traceback \(most recent call last\)|\bError\b|\bfailed\b|exit (?:code|status) [1-9]/i;

export type RenderFinding = {
  readonly job: string;
  readonly kind: RenderDiagnosis;
  readonly fix: string;
  readonly rerun: boolean;
};

export const diagnoseRender = (job: string, log: string): RenderFinding | null => {
  for (const s of SIGNS) if (s.sign.test(log)) return { job, kind: s.kind, fix: s.fix, rerun: s.rerun };
  return FAILED.test(log)
    ? { job, kind: "unknown", fix: "read the log's last traceback; no known cause matched", rerun: false }
    : null;
};

export type RenderPlan = { readonly findings: readonly RenderFinding[]; readonly rerun: readonly string[] };

export const planRenders = (jobs: readonly { readonly job: string; readonly log: string }[]): RenderPlan => {
  const findings = jobs.flatMap(({ job, log }) => diagnoseRender(job, log) ?? []);
  return { findings, rerun: findings.filter((f) => f.rerun).map((f) => f.job) };
};

export const renderLine = (f: RenderFinding): string =>
  `RENDER ${f.job} ${f.kind} -> ${f.rerun ? "rerun" : "hold"} ${JSON.stringify(f.fix)}`;
