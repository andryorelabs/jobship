import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { dispatch, runMain, type MainIo } from "../cli.ts";

type Fakes = {
  io: MainIo;
  stdout: string[];
  stderr: string[];
  fetched: string[];
  written: { file: string; text: string }[];
  spawns: { count: number };
};

function fakes(options: {
  tty: boolean;
  env?: Record<string, string>;
  cache?: string | null;
  version?: string;
  cwd?: string;
}): Fakes {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const fetched: string[] = [];
  const written: { file: string; text: string }[] = [];
  const spawns = { count: 0 };
  const io: MainIo = {
    env: { HOME: "/nonexistent", ...options.env },
    cwd: options.cwd ?? os.tmpdir(),
    stdout: { isTTY: options.tty, write: (chunk) => stdout.push(chunk) },
    stderr: { isTTY: false, write: (chunk) => stderr.push(chunk) },
    version: options.version ?? "0.8.0",
    now: () => 1_800_000_000_000,
    fetchImpl: (url) => {
      fetched.push(url);
      return Promise.resolve(Response.json({ tag_name: "v0.9.0" }));
    },
    readCacheText: () => options.cache ?? null,
    writeCacheText: (file, text) => {
      written.push({ file, text });
    },
    spawnRefresh: () => {
      spawns.count += 1;
    },
  };
  return { io, stdout, stderr, fetched, written, spawns };
}

const NEWER_CACHE = JSON.stringify({ checkedAt: 1_800_000_000_000 - 1000, latest: "v0.9.0" });

describe("runMain update notice", () => {
  test("a TTY with a newer cached release prints one notice line on stderr", async () => {
    const run = fakes({ tty: true, cache: NEWER_CACHE });
    expect(await runMain(["--version"], run.io)).toBe(0);
    expect(run.stdout.join("")).toBe("version: 0.0.0-dev\n");
    expect(run.stderr).toHaveLength(1);
    expect(run.stderr[0]).toContain("0.9.0");
    expect(run.fetched).toEqual([]);
  });

  test("JSON mode prints no notice and spawns no refresh", async () => {
    const run = fakes({ tty: false, cache: null });
    await runMain(["--version"], run.io);
    expect(run.stderr).toEqual([]);
    expect(run.spawns.count).toBe(0);
    expect(run.stdout.join("")).toBe('{"ok":true,"data":{"version":"0.0.0-dev"}}\n');
  });

  test("--json on a TTY prints no notice", async () => {
    const run = fakes({ tty: true, cache: NEWER_CACHE });
    await runMain(["--version", "--json"], run.io);
    expect(run.stderr).toEqual([]);
  });

  test("JOBSHIP_NO_UPDATE_CHECK=1 spawns no refresh and prints no notice", async () => {
    const run = fakes({ tty: true, cache: null, env: { JOBSHIP_NO_UPDATE_CHECK: "1" } });
    await runMain(["--version"], run.io);
    expect(run.spawns.count).toBe(0);
    expect(run.stderr).toEqual([]);
  });

  test("an empty cache on a TTY spawns the detached refresh once", async () => {
    const run = fakes({ tty: true, cache: null });
    await runMain(["--version"], run.io);
    expect(run.spawns.count).toBe(1);
    expect(run.fetched).toEqual([]);
  });

  test("the hidden refresh command fetches and writes the cache, and prints nothing", async () => {
    const run = fakes({ tty: true, cache: null });
    expect(await runMain(["__update-check"], run.io)).toBe(0);
    expect(run.fetched).toHaveLength(1);
    expect(run.written).toHaveLength(1);
    expect(run.stdout).toEqual([]);
  });

  test("the hidden refresh command does nothing when the check is disabled", async () => {
    const run = fakes({ tty: true, env: { CI: "true" } });
    expect(await runMain(["__update-check"], run.io)).toBe(0);
    expect(run.fetched).toEqual([]);
  });

  test("a failure exits with its envelope's code and prints readable text on a TTY", async () => {
    const run = fakes({ tty: true, env: { NO_COLOR: "1" } });
    expect(await runMain(["bogus"], run.io)).toBe(2);
    expect(run.stdout.join("")).toContain("error: unknown command");
  });
});

describe("dispatch help and flags", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "jobship-dispatch-"));
  const env = { HOME: home };

  test("--version", async () => {
    expect(await dispatch(["--version"], env, home)).toEqual({
      ok: true,
      data: { version: "0.0.0-dev" },
    });
  });

  test("usage lists every command with a summary", async () => {
    const envelope = await dispatch(["--help"], env, home);
    expect(JSON.stringify(envelope)).toContain("summaries");
    expect(JSON.stringify(envelope)).toContain("--no-color");
  });

  test.each([["doctor"], ["init"], ["setup"], ["sweep"], ["inbox"]])(
    "%s --help lists its flags",
    async (command) => {
      const envelope = await dispatch([command, "--help"], env, home);
      expect(envelope.ok).toBe(true);
      expect(JSON.stringify(envelope)).toContain(`jobship ${command} [flags]`);
    },
  );

  test("a two-word command has its own help", async () => {
    const envelope = await dispatch(["inbox", "eval", "--help"], env, home);
    expect(JSON.stringify(envelope)).toContain("jobship inbox eval [flags]");
  });

  test("--help on an unknown command is an unknown command failure", async () => {
    const envelope = await dispatch(["bogus", "--help"], env, home);
    expect(envelope.ok).toBe(false);
  });

  test("an unknown flag is a usage failure, a global flag is not", async () => {
    const bad = await dispatch(["setup", "--bogus"], env, home);
    expect(bad.ok ? "" : bad.error.code).toBe("usage");
    const good = await dispatch(["setup", "--no-color", "--bogus"], env, home);
    expect(good.ok ? "" : good.error.message).toContain("--bogus");
  });

  test("cleanup", () => {
    rmSync(home, { recursive: true, force: true });
  });
});
