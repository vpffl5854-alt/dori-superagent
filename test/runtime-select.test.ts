import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, RuntimeChoiceError, readRuntimeChoice } from "../src/runtime/select.ts";

const scratch = (): string => mkdtempSync(join(tmpdir(), "dori-select-"));

const config = (text: string): string => {
  const path = join(scratch(), "config.json");
  writeFileSync(path, text);
  return path;
};
const NO_CONFIG = "/nonexistent/dori/config.json";

const pathWith = (...bins: string[]): string => {
  const dirs = bins.map((bin) => {
    const dir = join(scratch(), "bin");
    mkdirSync(dir);
    const file = join(dir, bin);
    writeFileSync(file, "#!/bin/sh\n");
    chmodSync(file, 0o755);
    return dir;
  });
  return [join(scratch(), "empty"), ...dirs].join(":");
};

describe("readRuntimeChoice precedence", () => {
  const both = pathWith("herdr", "hc");
  test.each([
    [
      "DORI_RUNTIME beats config and every detection",
      { DORI_RUNTIME: "hc", HERDR_PANE_ID: "w1:p1", PATH: both },
      '{"runtime":"herdr"}',
      "hc",
      "env",
    ],
    [
      "DORI_RUNTIME=herdr inside an hc terminal",
      { DORI_RUNTIME: "herdr", HC_TERMINAL_ID: "t3", PATH: both },
      undefined,
      "herdr",
      "env",
    ],
    [
      "config beats the caller's terminal",
      { HC_TERMINAL_ID: "t3", PATH: both },
      '{"runtime":"herdr"}',
      "herdr",
      "config",
    ],
    ["config hc with only herdr installed", { PATH: pathWith("herdr") }, '{"runtime":"hc","other":1}', "hc", "config"],
    [
      "HC_TERMINAL_ID beats HERDR_PANE_ID",
      { HC_TERMINAL_ID: "t3", HERDR_PANE_ID: "w1:p1", PATH: both },
      "{}",
      "hc",
      "detect:HC_TERMINAL_ID",
    ],
    [
      "HERDR_PANE_ID beats PATH",
      { HERDR_PANE_ID: "w1:p1", PATH: pathWith("hc") },
      undefined,
      "herdr",
      "detect:HERDR_PANE_ID",
    ],
    ["only herdr on PATH", { PATH: pathWith("herdr") }, undefined, "herdr", "detect:path"],
    ["only hc on PATH", { PATH: pathWith("hc") }, '{"other":true}', "hc", "detect:path"],
    [
      "both on PATH, herdr's directory first: hc is the default",
      { PATH: pathWith("herdr", "hc") },
      undefined,
      "hc",
      "detect:path",
    ],
    ["both on PATH, hc's directory first: still hc", { PATH: pathWith("hc", "herdr") }, "{}", "hc", "detect:path"],
    [
      "empty variables count as unset",
      { DORI_RUNTIME: "", HC_TERMINAL_ID: "", HERDR_PANE_ID: "", PATH: pathWith("hc") },
      undefined,
      "hc",
      "detect:path",
    ],
  ] as const)("%s", (_, env, configText, kind, source) => {
    const configPath = configText === undefined ? NO_CONFIG : config(configText);
    expect(readRuntimeChoice({ env, configPath })).toEqual({ kind, source });
  });
});

describe("readRuntimeChoice refusals", () => {
  test("neither binary and nothing set: RuntimeChoiceError whose message names the config path and the fix", () => {
    const configPath = config("{}");
    let caught: unknown;
    try {
      readRuntimeChoice({ env: { PATH: pathWith() }, configPath });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RuntimeChoiceError);
    const message = (caught as Error).message;
    expect(message).toContain("neither herdr nor hc is on PATH");
    expect(message).toContain(configPath);
    expect(message).toContain('"runtime": "herdr" or "hc"');
    expect(message).toContain("DORI_RUNTIME");
    expect(() => readRuntimeChoice({ env: {}, configPath: NO_CONFIG })).toThrow(RuntimeChoiceError);
  });

  test("a non-executable file named hc is not an install", () => {
    const dir = scratch();
    writeFileSync(join(dir, "hc"), "");
    chmodSync(join(dir, "hc"), 0o644);
    mkdirSync(join(dir, "herdr"));
    expect(() => readRuntimeChoice({ env: { PATH: dir }, configPath: NO_CONFIG })).toThrow(RuntimeChoiceError);
  });

  test('config value "tmux": ConfigError naming the file and the value', () => {
    const configPath = config('{"runtime":"tmux"}');
    expect(() => readRuntimeChoice({ env: { DORI_RUNTIME: "" }, configPath })).toThrow(ConfigError);
    expect(() => readRuntimeChoice({ env: {}, configPath })).toThrow(new RegExp(`${configPath}.*"tmux"`));
  });

  test("a non-string runtime value is a ConfigError too", () => {
    expect(() => readRuntimeChoice({ env: {}, configPath: config('{"runtime":7}') })).toThrow(ConfigError);
  });

  test("unreadable config JSON: ConfigError naming the file", () => {
    const configPath = config("{ runtime: herdr");
    expect(() => readRuntimeChoice({ env: { PATH: pathWith("hc") }, configPath })).toThrow(ConfigError);
    expect(() => readRuntimeChoice({ env: {}, configPath })).toThrow(configPath);
  });

  test("a config file that is not an object is a ConfigError", () => {
    expect(() => readRuntimeChoice({ env: {}, configPath: config("[]") })).toThrow(ConfigError);
  });

  test("an invalid DORI_RUNTIME is a ConfigError naming the variable and the value", () => {
    expect(() => readRuntimeChoice({ env: { DORI_RUNTIME: "tmux" }, configPath: NO_CONFIG })).toThrow(
      /DORI_RUNTIME.*"tmux"/,
    );
  });

  test("DORI_RUNTIME wins without reading a broken config", () => {
    expect(readRuntimeChoice({ env: { DORI_RUNTIME: "herdr" }, configPath: config("not json") })).toEqual({
      kind: "herdr",
      source: "env",
    });
  });
});

describe("readRuntimeChoice PATH detection is injectable", () => {
  test("exists is asked for herdr and hc in each PATH directory, in order", () => {
    const asked: string[] = [];
    const exists = (path: string): boolean => {
      asked.push(path);
      return path === "/b/hc";
    };
    expect(readRuntimeChoice({ env: { PATH: "/a:/b" }, configPath: NO_CONFIG, exists })).toEqual({
      kind: "hc",
      source: "detect:path",
    });
    expect(asked).toContain("/a/herdr");
    expect(asked).toContain("/b/hc");
  });

  test("an empty PATH entry is skipped, never read as the working directory", () => {
    const asked: string[] = [];
    const exists = (path: string): boolean => {
      asked.push(path);
      return false;
    };
    expect(() => readRuntimeChoice({ env: { PATH: ":/a:" }, configPath: NO_CONFIG, exists })).toThrow(
      RuntimeChoiceError,
    );
    expect(asked.every((p) => p.startsWith("/a/"))).toBe(true);
  });
});
