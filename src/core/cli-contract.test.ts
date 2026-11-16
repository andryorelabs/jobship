import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { outputModeFor, writeOutput } from "../cli.ts";
import { colorEnabled } from "./color.ts";
import {
  COMMAND_FLAGS,
  COMMAND_HELP,
  COMMANDS,
  commandHelp,
  withoutGlobalFlags,
} from "./commands.ts";
import { exitCodeFor, failure, success } from "./envelope.ts";
import { EXIT_CODES } from "./exit-codes.ts";
import { renderHuman, resolveOutputMode } from "./human.ts";
import { installInterruptHandler } from "./shutdown.ts";

const cliPath = path.join(import.meta.dir, "../cli.ts");

function collector(isTTY: boolean): {
  stream: { isTTY: boolean; write(chunk: string): void };
  chunks: string[];
} {
  const chunks: string[] = [];
  return {
    chunks,
    stream: {
      isTTY,
      write(chunk: string): void {
        chunks.push(chunk);
      },
    },
  };
}

describe("EXIT_CODES and exitCodeFor", () => {
  test("the contract values", () => {
    expect(EXIT_CODES).toEqual({ ok: 0, findings: 1, usage: 2, internal: 3, interrupted: 130 });
  });

  test("envelopes map to ok, findings, usage and internal", () => {
    expect(exitCodeFor(success({}))).toBe(0);
    expect(exitCodeFor(failure("lint-failed", "x"))).toBe(1);
    expect(exitCodeFor(failure("usage", "x"))).toBe(2);
    expect(exitCodeFor(failure("internal", "x"))).toBe(3);
  });
});

describe("installInterruptHandler", () => {
  test("SIGINT exits 130", () => {
    let listener: (() => void) | undefined;
    const exits: number[] = [];
    installInterruptHandler(
      {
        on(_signal, handler) {
          listener = handler;
        },
      },
      (code) => exits.push(code),
    );
    listener?.();
    expect(exits).toEqual([130]);
  });
});

describe("resolveOutputMode", () => {
  test("a TTY on stdout is human", () => {
    expect(resolveOutputMode(["doctor"], { isTTY: true })).toBe("human");
  });

  test("a pipe is JSON", () => {
    expect(resolveOutputMode(["doctor"], { isTTY: false })).toBe("json");
    expect(resolveOutputMode(["doctor"], {})).toBe("json");
  });

  test("--json forces JSON on a TTY", () => {
    expect(resolveOutputMode(["doctor", "--json"], { isTTY: true })).toBe("json");
  });

  test("the Guard is always JSON", () => {
    expect(outputModeFor(["guard"], { isTTY: true, write: () => undefined })).toBe("json");
    expect(outputModeFor(["doctor"], { isTTY: true, write: () => undefined })).toBe("human");
  });
});

describe("colorEnabled", () => {
  const tty = { isTTY: true };
  const pipe = { isTTY: false };

  test("follows the TTY by default", () => {
    expect(colorEnabled({}, tty, [])).toBe(true);
    expect(colorEnabled({}, pipe, [])).toBe(false);
  });

  test("NO_COLOR, --no-color and TERM=dumb turn it off", () => {
    expect(colorEnabled({ NO_COLOR: "1" }, tty, [])).toBe(false);
    expect(colorEnabled({}, tty, ["--no-color"])).toBe(false);
    expect(colorEnabled({ TERM: "dumb" }, tty, [])).toBe(false);
  });

  test("an empty NO_COLOR is ignored", () => {
    expect(colorEnabled({ NO_COLOR: "" }, tty, [])).toBe(true);
  });

  test("FORCE_COLOR turns it on for a pipe, and 0 turns it off", () => {
    expect(colorEnabled({ FORCE_COLOR: "1" }, pipe, [])).toBe(true);
    expect(colorEnabled({ FORCE_COLOR: "0" }, tty, [])).toBe(false);
  });

  test("NO_COLOR beats FORCE_COLOR", () => {
    expect(colorEnabled({ NO_COLOR: "1", FORCE_COLOR: "1" }, tty, [])).toBe(false);
  });
});

describe("renderHuman", () => {
  test("renders scalars, nested objects and arrays as lines", () => {
    const text = renderHuman(
      success({
        name: "x",
        empty: [],
        list: ["a", { b: 1 }],
        nested: { deep: true },
        multi: "a\nb",
      }),
    );
    expect(text).toBe(
      [
        "name: x",
        "empty: -",
        "list:",
        "  - a",
        "  -",
        "    b: 1",
        "nested:",
        "  deep: true",
        "multi:",
        "  a",
        "  b",
      ].join("\n"),
    );
  });

  test("renders a string payload as is", () => {
    expect(renderHuman(success("hello"))).toBe("hello");
  });

  test("renders an error with its recovery action", () => {
    expect(renderHuman(failure("usage", "bad flag", { recoveryAction: "see --help" }))).toBe(
      "error: bad flag (usage)\nnext: see --help",
    );
    expect(renderHuman(failure("usage", "bad flag"))).toBe("error: bad flag (usage)");
  });
});

describe("writeOutput", () => {
  test("json mode writes one envelope line", () => {
    const { stream, chunks } = collector(true);
    writeOutput(success({ a: 1 }), "json", stream, false);
    expect(chunks).toEqual(['{"ok":true,"data":{"a":1}}\n']);
  });

  test("human mode writes readable lines, coloring the error label when asked", () => {
    const plain = collector(true);
    writeOutput(failure("usage", "bad"), "human", plain.stream, false);
    expect(plain.chunks).toEqual(["error: bad (usage)\n"]);
    const colored = collector(true);
    writeOutput(failure("usage", "bad"), "human", colored.stream, true);
    expect(colored.chunks[0]).toContain("\u001b[31merror:");
  });
});

describe("command help", () => {
  test("every command in the registry has help for each of its flags", () => {
    for (const name of Object.keys(COMMAND_FLAGS)) {
      const help = COMMAND_HELP[name];
      expect(help).toBeDefined();
      expect(Object.keys(help?.flags ?? {}).toSorted()).toEqual(
        [...(COMMAND_FLAGS[name] ?? [])].toSorted(),
      );
      expect(help?.summary).not.toBe("");
    }
    for (const name of Object.keys(COMMANDS)) expect(COMMAND_HELP[name]).toBeDefined();
  });

  test("commandHelp lists the command flags with the global ones", () => {
    const help = commandHelp("sweep");
    expect(help?.flags.map((entry) => entry.flag)).toEqual([
      "--source",
      "--keyword",
      "--data <dir>",
      "--json",
      "--no-color",
    ]);
    expect(commandHelp("ingest")?.flags.filter((entry) => entry.flag === "--json")).toHaveLength(1);
    expect(commandHelp("nope")).toBeNull();
  });

  test("global flags are stripped unless the command owns them", () => {
    expect(withoutGlobalFlags("sweep", ["--json", "--no-color", "--source", "x"])).toEqual([
      "--source",
      "x",
    ]);
    expect(withoutGlobalFlags("ingest", ["--json", "[]", "--no-color"])).toEqual(["--json", "[]"]);
  });
});

type Spawned = { code: number; stdout: string; stderr: string };

function runCli(args: string[], env: Record<string, string>): Spawned {
  const result = Bun.spawnSync([process.execPath, cliPath, ...args], {
    env: { PATH: process.env["PATH"] ?? "", ...env },
  });
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

function runOnTty(args: string[], env: Record<string, string>): Spawned | null {
  const script = Bun.which("script");
  if (script === null) return null;
  const command = [process.execPath, cliPath, ...args].map((part) => `'${part}'`).join(" ");
  const result = Bun.spawnSync([script, "-qec", command, "/dev/null"], {
    env: { PATH: process.env["PATH"] ?? "", ...env },
  });
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

describe("TTY and pipe contract", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "jobship-contract-"));
  const env = { HOME: home, JOBSHIP_NO_UPDATE_CHECK: "1" };

  test("stdout piped prints the JSON envelope even when stderr is a TTY", () => {
    const result = runCli(["--version"], env);
    expect(JSON.parse(result.stdout)).toEqual({ ok: true, data: { version: "0.0.0-dev" } });
  });

  test("stdout on a TTY prints readable lines", () => {
    const result = runOnTty(["--version", "--no-color"], env);
    if (result === null) return;
    expect(result.stdout.trim()).toBe("version: 0.0.0-dev");
  });

  test("--json forces JSON on a TTY", () => {
    const result = runOnTty(["--version", "--json"], env);
    if (result === null) return;
    expect(JSON.parse(result.stdout.trim())).toEqual({ ok: true, data: { version: "0.0.0-dev" } });
  });

  test("a usage error exits 2 on a TTY with readable text", () => {
    const result = runOnTty(["bogus", "--no-color"], env);
    if (result === null) return;
    expect(result.code).toBe(2);
    expect(result.stdout).toContain("error: unknown command");
  });

  test("the Guard keeps its JSON on a TTY and fails closed", () => {
    const result = runCli(["guard"], env);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('"permissionDecision":"deny"');
  });

  test("--help lists the commands and a command's --help lists its flags", () => {
    const top = runCli(["--help"], env);
    expect(top.stdout).toContain("sweep");
    expect(runCli(["sweep", "--help"], env).stdout).toContain('"flag":"--source"');
    expect(runCli(["doctor", "--help"], env).stdout).toContain('"usage":"jobship doctor [flags]"');
  });

  test("an unknown flag still exits 2", () => {
    expect(runCli(["doctor", "--bogus"], env).code).toBe(2);
  });

  test("no update check is spawned when stdout is piped", () => {
    const cacheDir = path.join(home, "cache");
    runCli(["--version"], { HOME: home, JOBSHIP_CACHE_DIR: cacheDir });
    expect(Bun.file(path.join(cacheDir, "update-check.json")).size).toBe(0);
  });

  test("cleanup", () => {
    rmSync(home, { recursive: true, force: true });
  });
});
