export type Signal =
  | { readonly kind: "merged" | "closed"; readonly repo: string; readonly n: string }
  | { readonly kind: "published"; readonly pkg: string; readonly version: string }
  | { readonly kind: "command"; readonly argv: readonly string[]; readonly stdout?: RegExp }
  | {
      readonly kind: "file";
      readonly path: string;
      readonly sha256?: string;
      readonly json?: { readonly path: readonly (string | number)[]; readonly value: unknown };
    }
  | { readonly kind: "url"; readonly url: string; readonly status: number; readonly body?: RegExp };

export const UNREADABLE = [
  "unreadable signal; use one of:",
  "merged <owner/repo>#N | closed <owner/repo>#N | published <pkg>@<version>",
  'command ["argv","as","json"] [stdout~"regex"]',
  "file <path> [sha256=<hex>] [json:.a.b=<json value>]",
  'url <http(s) url> [status=200] [body~"regex"]',
].join(" ");

export class SignalSyntaxError extends Error {}

const readJson = (s: string, i: number): { readonly value: unknown; readonly end: number } => {
  const open = s[i];
  let end = i;
  if (open === '"') {
    end++;
    while (end < s.length && s[end] !== '"') end += s[end] === "\\" ? 2 : 1;
    end++;
  } else if (open === "[" || open === "{") {
    let depth = 0;
    for (; end < s.length; end++) {
      const c = s[end];
      if (c === '"') {
        end++;
        while (end < s.length && s[end] !== '"') end += s[end] === "\\" ? 2 : 1;
      } else if (c === "[" || c === "{") depth++;
      else if ((c === "]" || c === "}") && --depth === 0) break;
    }
    end++;
  } else {
    while (end < s.length && !/\s/.test(s[end] ?? "")) end++;
  }
  const text = s.slice(i, end);
  try {
    return { value: JSON.parse(text), end };
  } catch {
    if (open === '"' || open === "[" || open === "{")
      throw new SignalSyntaxError(`not valid JSON at "${text.slice(0, 40)}"`);
    return { value: text, end };
  }
};

export const splitDone = (done: string): string[] => {
  const body = done.replace(/^Done\s*=\s*/i, "");
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '"') {
      i++;
      while (i < body.length && body[i] !== '"') i += body[i] === "\\" ? 2 : 1;
    } else if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") depth--;
    else if (c === ";" && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(body.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
};

type Opt = { readonly key: string; readonly op: "=" | "~"; readonly value: unknown };

const readOptions = (s: string, i: number): Opt[] => {
  const opts: Opt[] = [];
  while (i < s.length) {
    while (/\s/.test(s[i] ?? "")) i++;
    if (i >= s.length) break;
    const m = /^([a-z0-9_]+(?::[^=~\s]+)?)([=~])/i.exec(s.slice(i));
    if (!m?.[1] || !m[2]) throw new SignalSyntaxError(`expected key=value or key~"regex" at "${s.slice(i, i + 30)}"`);
    i += m[0].length;
    const r = readJson(s, i);
    opts.push({ key: m[1], op: m[2] as "=" | "~", value: r.value });
    i = r.end;
  }
  return opts;
};

const regex = (o: Opt | undefined, what: string): RegExp | undefined => {
  if (!o) return undefined;
  if (o.op !== "~" || typeof o.value !== "string") throw new SignalSyntaxError(`${what} takes ~"regex"`);
  try {
    return new RegExp(o.value);
  } catch {
    throw new SignalSyntaxError(`${what}: invalid regex ${o.value}`);
  }
};

const onlyKeys = (opts: readonly Opt[], allowed: (k: string) => boolean, kind: string) => {
  const bad = opts.find((o) => !allowed(o.key));
  if (bad) throw new SignalSyntaxError(`${kind}: unknown option ${bad.key}`);
};

export const parseSignal = (raw: string): Signal => {
  const s = raw.trim();
  const gh = /^(merged|closed)\s+([\w.-]+\/[\w.-]+)(?:#|\/(?:pull|issues)\/)(\d+)\s*$/i.exec(s);
  if (gh?.[1] && gh[2] && gh[3]) return { kind: gh[1].toLowerCase() as "merged" | "closed", repo: gh[2], n: gh[3] };
  const pub = /^published\s+(\S+)@(\S+)\s*$/i.exec(s);
  if (pub?.[1] && pub[2]) return { kind: "published", pkg: pub[1], version: pub[2] };
  const head = /^(command|file|url)\s+/i.exec(s);
  if (!head?.[1]) throw new SignalSyntaxError(UNREADABLE);
  const kind = head[1].toLowerCase();
  const at = head[0].length;
  if (kind === "command") {
    if (s[at] !== "[") throw new SignalSyntaxError('command takes a JSON argv array, e.g. command ["bun","test"]');
    const { value, end } = readJson(s, at);
    if (!Array.isArray(value) || !value.length || !value.every((a) => typeof a === "string" && a.length > 0))
      throw new SignalSyntaxError("command argv must be a non-empty array of non-empty strings");
    const opts = readOptions(s, end);
    onlyKeys(opts, (k) => k === "stdout", "command");
    const stdout = regex(
      opts.find((o) => o.key === "stdout"),
      "stdout",
    );
    return { kind: "command", argv: value as string[], ...(stdout !== undefined ? { stdout } : {}) };
  }
  if (kind === "file") {
    const pathTok =
      s[at] === '"'
        ? readJson(s, at)
        : { value: /^\S+/.exec(s.slice(at))?.[0] ?? "", end: at + (/^\S+/.exec(s.slice(at))?.[0].length ?? 0) };
    if (typeof pathTok.value !== "string" || !pathTok.value) throw new SignalSyntaxError("file needs a path");
    const opts = readOptions(s, pathTok.end);
    onlyKeys(opts, (k) => k === "sha256" || k.startsWith("json:"), "file");
    const sha = opts.find((o) => o.key === "sha256");
    if (sha && (sha.op !== "=" || typeof sha.value !== "string" || !/^[0-9a-f]{64}$/i.test(sha.value)))
      throw new SignalSyntaxError("sha256= takes 64 hex characters");
    const js = opts.find((o) => o.key.startsWith("json:"));
    if (js && js.op !== "=") throw new SignalSyntaxError("json:<path> takes =<json value>");
    const jsonPath = js
      ? js.key
          .slice(5)
          .replace(/^\./, "")
          .split(".")
          .filter(Boolean)
          .map((p) => (/^\d+$/.test(p) ? Number(p) : p))
      : [];
    if (js && !jsonPath.length) throw new SignalSyntaxError("json: needs a field path like json:.version");
    return {
      kind: "file",
      path: pathTok.value,
      ...(sha ? { sha256: String(sha.value).toLowerCase() } : {}),
      ...(js ? { json: { path: jsonPath, value: js.value } } : {}),
    };
  }
  const urlTok = /^\S+/.exec(s.slice(at))?.[0] ?? "";
  if (!/^https?:\/\/\S+$/i.test(urlTok)) throw new SignalSyntaxError("url needs an http(s) URL");
  const opts = readOptions(s, at + urlTok.length);
  onlyKeys(opts, (k) => k === "status" || k === "body", "url");
  const st = opts.find((o) => o.key === "status");
  if (st && (st.op !== "=" || !Number.isInteger(st.value))) throw new SignalSyntaxError("status= takes an integer");
  const body = regex(
    opts.find((o) => o.key === "body"),
    "body",
  );
  return { kind: "url", url: urlTok, status: st ? Number(st.value) : 200, ...(body !== undefined ? { body } : {}) };
};
