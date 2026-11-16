/** Saves what a Discord message carries under <stateDir>/discord-media/ so a lane can open the image itself. */
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";

import { run } from "../run.ts";
import type { MediaStore } from "./discord-types.ts";

const MAX_MEDIA_BYTES = 10 * 1024 * 1024;
const MAX_MEDIA_TOTAL_BYTES = 512 * 1024 * 1024;
const MEDIA_FETCH_TIMEOUT_MS = 30_000;
const EXT_BY_TYPE: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "video/mp4": "mp4",
  "video/webm": "webm",
};

const safeExtension = (type: string, name: string): string => {
  const known = EXT_BY_TYPE[type];
  if (known) return known;
  const raw = (name.split(".").pop() ?? "").toLowerCase();
  const cleaned = raw.replace(/[^a-z0-9]/g, "").slice(0, 8);
  return cleaned.length > 0 ? cleaned : "bin";
};

/** Saves what a Discord message carries under <stateDir>/discord-media/ so a lane can open the image itself. */
export const mediaStore = (stateDir: string): MediaStore => {
  const dir = `${stateDir}/discord-media`;
  const trim = (incoming: number): void => {
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    const entries = names
      .map((name) => {
        try {
          const st = statSync(`${dir}/${name}`);
          return { path: `${dir}/${name}`, size: st.size, at: st.mtimeMs };
        } catch {
          return null;
        }
      })
      .filter((e): e is { path: string; size: number; at: number } => e !== null)
      .sort((a, b) => a.at - b.at);
    let total = entries.reduce((sum, e) => sum + e.size, 0);
    for (const e of entries) {
      if (total + incoming <= MAX_MEDIA_TOTAL_BYTES) break;
      try {
        unlinkSync(e.path);
        total -= e.size;
      } catch {}
    }
  };
  return {
    save: async (messageId, index, ref) => {
      const res = await fetch(ref.url, { signal: AbortSignal.timeout(MEDIA_FETCH_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`GET ${ref.url} -> ${res.status}`);
      const declared = Number(res.headers.get("content-length") ?? "0");
      if (declared > MAX_MEDIA_BYTES)
        throw new Error(`${ref.url} is ${declared} bytes, past the ${MAX_MEDIA_BYTES} limit`);
      const chunks: Uint8Array[] = [];
      let size = 0;
      const reader = res.body?.getReader();
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;
          size += value.byteLength;
          if (size > MAX_MEDIA_BYTES) {
            await reader.cancel().catch(() => {});
            throw new Error(`${ref.url} is past the ${MAX_MEDIA_BYTES} byte limit`);
          }
          chunks.push(value);
        }
      } else {
        const whole = new Uint8Array(await res.arrayBuffer());
        size = whole.byteLength;
        if (size > MAX_MEDIA_BYTES) throw new Error(`${ref.url} is ${size} bytes, past the ${MAX_MEDIA_BYTES} limit`);
        chunks.push(whole);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const type = (res.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
      const ext = safeExtension(type, ref.name);
      mkdirSync(dir, { recursive: true });
      trim(size);
      const base = `${dir}/${messageId}-${index}`;
      const path = `${base}.${ext}`;
      writeFileSync(path, bytes);
      if (!type.startsWith("video/")) return [path];
      const frame = `${base}.png`;
      const ff = await run(["ffmpeg", "-y", "-loglevel", "error", "-ss", "0.5", "-i", path, "-frames:v", "1", frame], {
        timeoutMs: 20_000,
      });
      return ff.code === 0 && existsSync(frame) ? [frame, path] : [path];
    },
  };
};
