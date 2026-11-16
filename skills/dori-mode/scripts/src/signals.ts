import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

import { fetchHttp, type Http } from "./messenger/http.ts";
import type { Runner } from "./run.ts";
import { parseSignal, type Signal, SignalSyntaxError, splitDone } from "./signals-parse.ts";

export type Check = { readonly signal: string; readonly ok: boolean; readonly detail: string };

export type SignalIo = { readonly http?: Http; readonly cwd?: string; readonly home?: string };

export const COMMAND_TIMEOUT_MS = 120_000;

const publishedVersions = (out: string): unknown[] => {
  try {
    return [JSON.parse(out)].flat();
  } catch {
    return [];
  }
};

const resolvePath = (p: string, io: SignalIo): string => {
  const home = io.home ?? homedir();
  const expanded = p === "~" ? home : p.startsWith("~/") ? join(home, p.slice(2)) : p;
  return isAbsolute(expanded) ? expanded : join(io.cwd ?? process.cwd(), expanded);
};

const dig = (v: unknown, path: readonly (string | number)[]): { readonly found: boolean; readonly value: unknown } => {
  let cur = v;
  for (const k of path) {
    if (cur === null || typeof cur !== "object" || !(k in (cur as object))) return { found: false, value: undefined };
    cur = (cur as Record<string | number, unknown>)[k];
  }
  return { found: true, value: cur };
};

const short = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 120);

export const checkSignal = async (signal: string, run: Runner, io: SignalIo = {}): Promise<Check> => {
  const s = signal.trim();
  let sig: Signal;
  try {
    sig = parseSignal(s);
  } catch (e) {
    return { signal: s, ok: false, detail: e instanceof SignalSyntaxError ? e.message : String(e) };
  }
  switch (sig.kind) {
    case "merged": {
      const r = await run(["gh", "pr", "view", sig.n, "--repo", sig.repo, "--json", "state,mergeCommit"]);
      const j = r.code === 0 ? (JSON.parse(r.out) as { state?: string; mergeCommit?: { oid?: string } | null }) : {};
      const sha = j.mergeCommit?.oid ?? "";
      return {
        signal: s,
        ok: j.state === "MERGED" && sha.length > 0,
        detail: j.state ? `${j.state} ${sha.slice(0, 10)}`.trim() : r.err || "no answer",
      };
    }
    case "closed": {
      const r = await run(["gh", "issue", "view", sig.n, "--repo", sig.repo, "--json", "state"]);
      const j = r.code === 0 ? (JSON.parse(r.out) as { state?: string }) : {};
      return { signal: s, ok: j.state === "CLOSED", detail: j.state ?? (r.err || "no answer") };
    }
    case "published": {
      const r = await run(["npm", "view", `${sig.pkg}@${sig.version}`, "version", "--json"]);
      // npm 12 prints `version --json` as an array, older npm as a bare string.
      const ok = r.code === 0 && publishedVersions(r.out).includes(sig.version);
      return {
        signal: s,
        ok,
        detail: ok ? `registry has ${sig.pkg}@${sig.version}` : r.err || r.out || "not published",
      };
    }
    case "command": {
      const r = await run(sig.argv, { ...(io.cwd ? { cwd: io.cwd } : {}), timeoutMs: COMMAND_TIMEOUT_MS });
      if (r.code !== 0)
        return { signal: s, ok: false, detail: `exit ${r.code}: ${short(r.err || r.out) || "no output"}` };
      if (sig.stdout && !sig.stdout.test(r.out))
        return {
          signal: s,
          ok: false,
          detail: `exit 0 but stdout does not match ${sig.stdout}: ${short(r.out) || "(empty)"}`,
        };
      return { signal: s, ok: true, detail: sig.stdout ? `exit 0, stdout matches ${sig.stdout}` : "exit 0" };
    }
    case "file": {
      const path = resolvePath(sig.path, io);
      const f = Bun.file(path);
      if (!(await f.exists())) return { signal: s, ok: false, detail: `missing: ${path}` };
      if (sig.sha256) {
        const got = new Bun.CryptoHasher("sha256").update(await f.arrayBuffer()).digest("hex");
        if (got !== sig.sha256)
          return { signal: s, ok: false, detail: `sha256 ${got.slice(0, 12)}… != ${sig.sha256.slice(0, 12)}…` };
      }
      if (sig.json) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(await f.text());
        } catch {
          return { signal: s, ok: false, detail: `not JSON: ${path}` };
        }
        const hit = dig(parsed, sig.json.path);
        const want = JSON.stringify(sig.json.value);
        if (!hit.found) return { signal: s, ok: false, detail: `no field .${sig.json.path.join(".")}` };
        if (JSON.stringify(hit.value) !== want)
          return {
            signal: s,
            ok: false,
            detail: `.${sig.json.path.join(".")} is ${short(JSON.stringify(hit.value))}, want ${want}`,
          };
      }
      return {
        signal: s,
        ok: true,
        detail: `present${sig.sha256 ? ", sha256 matches" : ""}${sig.json ? `, .${sig.json.path.join(".")} matches` : ""}`,
      };
    }
    case "url": {
      let res: { readonly status: number; readonly body: string };
      try {
        res = await (io.http ?? fetchHttp)({ method: "GET", url: sig.url });
      } catch (e) {
        return { signal: s, ok: false, detail: `request failed: ${short(String(e))}` };
      }
      if (res.status !== sig.status)
        return { signal: s, ok: false, detail: `status ${res.status}, want ${sig.status}` };
      if (sig.body && !sig.body.test(res.body))
        return { signal: s, ok: false, detail: `status ${res.status} but body does not match ${sig.body}` };
      return { signal: s, ok: true, detail: `status ${res.status}${sig.body ? ", body matches" : ""}` };
    }
  }
};

export const checkDone = async (done: string, run: Runner, io: SignalIo = {}): Promise<Check[]> => {
  const parts = splitDone(done);
  if (!parts.length) return [{ signal: done, ok: false, detail: "empty Done line" }];
  return Promise.all(parts.map((p) => checkSignal(p, run, io)));
};

export const doneSyntaxErrors = (done: string): string[] => {
  const parts = splitDone(done);
  if (!parts.length) return ["(empty Done line)"];
  return parts.flatMap((p) => {
    try {
      parseSignal(p);
      return [];
    } catch (e) {
      return [`${p} -> ${e instanceof Error ? e.message : String(e)}`];
    }
  });
};
