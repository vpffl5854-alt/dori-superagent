"""Render one shorts job: <job>/script.json + optional voice/<i>.* and images/<i>.* -> <job>/out.mp4 (1080x1920).

Each script line is one scene: its image (cover-cropped) or a dark background, the line as a caption, and its
voice clip. A scene lasts exactly as long as its voice, so audio never runs past the video; a line with no
voice gets a reading-time duration. Usage: render.py <job-dir> <font-path>
"""

import json
import sys
from pathlib import Path

from moviepy import AudioFileClip, ColorClip, CompositeVideoClip, ImageClip, TextClip, concatenate_videoclips

W, H, FPS = 1080, 1920, 30
PAD = 0.3


def first(folder: Path, index: int) -> Path | None:
    hits = sorted(folder.glob(f"{index}.*")) if folder.is_dir() else []
    return hits[0] if hits else None


def background(path: Path | None, duration: float):
    if path is None:
        return ColorClip((W, H), color=(18, 18, 24), duration=duration)
    img = ImageClip(str(path))
    scale = max(W / img.w, H / img.h)
    img = img.resized(scale)
    return img.cropped(x_center=img.w / 2, y_center=img.h / 2, width=W, height=H).with_duration(duration)


def caption(text: str, font: str, duration: float, y: int, size: int):
    # A translucent plate behind the words: white text over a busy photo (noise, textures) is unreadable with an
    # outline alone, and the plate keeps every frame legible whatever the background happens to be.
    clip = TextClip(
        font=font,
        text=text,
        font_size=size,
        color="white",
        stroke_color="black",
        stroke_width=8,
        method="caption",
        size=(W - 120, None),
        text_align="center",
        bg_color=(0, 0, 0, 160),
        margin=(28, 28),
        duration=duration,
    )
    return clip.with_position(("center", y))


def scene(job: Path, index: int, line: str, title: str, font: str):
    voice_path = first(job / "voice", index)
    voice = AudioFileClip(str(voice_path)) if voice_path else None
    duration = voice.duration + PAD if voice else min(6.0, max(2.0, len(line) * 0.12))
    layers = [background(first(job / "images", index), duration), caption(line, font, duration, int(H * 0.62), 72)]
    if title:
        layers.append(caption(title, font, duration, int(H * 0.08), 64))
    clip = CompositeVideoClip(layers, size=(W, H)).with_duration(duration)
    return clip.with_audio(voice) if voice else clip


def main() -> int:
    job, font = Path(sys.argv[1]), sys.argv[2]
    script = json.loads((job / "script.json").read_text(encoding="utf-8"))
    lines = [str(x).strip() for x in script.get("lines", []) if str(x).strip()]
    if not lines:
        print("Error: script.json has no lines", file=sys.stderr)
        return 1
    title = str(script.get("title", "")).strip()
    video = concatenate_videoclips([scene(job, i, line, title, font) for i, line in enumerate(lines)])
    video.write_videofile(str(job / "out.mp4"), fps=FPS, codec="libx264", audio_codec="aac", threads=2, logger=None)
    print(f"MoviePy - Done ! {job / 'out.mp4'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
