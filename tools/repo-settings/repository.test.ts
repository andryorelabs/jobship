import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  REPO_ROOT,
  consoleOutput,
  assertExpectedRepository,
  readPackageRepository,
  repositoryFromUrl,
  resolveRepository,
  spawnCommand,
  spawnGh,
  spawnGhApi,
} from "./repository.ts";
import type { GhRunner } from "./repository.ts";

const quiet: GhRunner = () => ({ exitCode: 0, stdout: "  \n", stderr: "" });
const failingGh: GhRunner = () => ({ exitCode: 1, stdout: "", stderr: "not a repo" });

describe("resolveRepository", () => {
  test("runs gh pinned to the checkout, whatever the process cwd is", () => {
    const seen: string[] = [];
    const runGh: GhRunner = (_args, cwd) => {
      seen.push(cwd);
      return { exitCode: 0, stdout: "andryorelabs/jobship\n", stderr: "" };
    };
    const original = process.cwd();
    try {
      process.chdir("/");
      expect(resolveRepository(runGh)).toBe("andryorelabs/jobship");
    } finally {
      process.chdir(original);
    }
    expect(seen).toEqual([REPO_ROOT]);
  });

  test("throws when gh fails", () => {
    expect(() => resolveRepository(failingGh)).toThrow("gh repo view failed: not a repo");
  });

  test("throws when gh prints nothing", () => {
    expect(() => resolveRepository(quiet)).toThrow("no output");
  });
});

describe("package repository guard", () => {
  test("parses the URL forms package.json and git use", () => {
    expect(repositoryFromUrl("git+https://github.com/andryorelabs/jobship.git")).toBe(
      "andryorelabs/jobship",
    );
    expect(repositoryFromUrl("git@github.com:andryorelabs/jobship.git")).toBe(
      "andryorelabs/jobship",
    );
    expect(repositoryFromUrl("https://example.com/x")).toBeUndefined();
  });

  test("package.json names andryorelabs/jobship", () => {
    expect(readPackageRepository()).toBe("andryorelabs/jobship");
  });

  test("accepts a match and refuses a different repository", () => {
    expect(() => {
      assertExpectedRepository("AndryOreLabs/jobship", "andryorelabs/jobship");
    }).not.toThrow();
    expect(() => {
      assertExpectedRepository("someone/else", "andryorelabs/jobship");
    }).toThrow("refusing to apply");
  });
});

/** Reads the repository from a `package.json` holding `manifest`. */
function readFrom(manifest: string): string {
  const root = mkdtempSync(path.join(tmpdir(), "repo-package-"));
  try {
    writeFileSync(path.join(root, "package.json"), manifest);
    return readPackageRepository(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("readPackageRepository with another root", () => {
  test("reads a string repository field", () => {
    expect(readFrom('{"repository":"https://github.com/a/b"}')).toBe("a/b");
  });

  test("reads an object repository field", () => {
    expect(readFrom('{"repository":{"url":"git+https://github.com/a/b.git"}}')).toBe("a/b");
  });

  test("throws when there is no repository URL on GitHub", () => {
    for (const manifest of [
      "{}",
      '{"repository":{}}',
      '{"repository":"https://example.com/x"}',
      "7",
    ]) {
      expect(() => readFrom(manifest)).toThrow("no GitHub repository URL");
    }
  });
});

describe("spawnCommand", () => {
  test("captures stdout and the exit code", () => {
    expect(spawnCommand("echo", ["hello"])).toEqual({ exitCode: 0, stdout: "hello\n", stderr: "" });
  });

  test("passes stdin and the working directory", () => {
    expect(spawnCommand("cat", [], { input: "piped" }).stdout).toBe("piped");
    expect(spawnCommand("pwd", [], { cwd: "/" }).stdout).toBe("/\n");
  });

  test("reports a failing command", () => {
    expect(spawnCommand("sh", ["-c", "echo bad >&2; exit 3"])).toEqual({
      exitCode: 3,
      stdout: "",
      stderr: "bad\n",
    });
  });

  test("spawnGhApi reports ok from the exit code, with or without stdin", () => {
    expect(spawnGhApi(["--version"]).ok).toBe(true);
    expect(spawnGhApi(["--version"], "ignored").stdout).toContain("gh version");
    expect(spawnGhApi(["no-such-subcommand"]).ok).toBe(false);
  });

  test("consoleOutput writes to stdout and stderr", () => {
    const log = spyOn(console, "log").mockImplementation(() => undefined);
    const error = spyOn(console, "error").mockImplementation(() => undefined);
    consoleOutput.log("out");
    consoleOutput.logError("err");
    expect(log).toHaveBeenCalledWith("out");
    expect(error).toHaveBeenCalledWith("err");
    log.mockRestore();
    error.mockRestore();
  });

  test("spawnGh runs gh in the given directory without a network call", () => {
    const outcome = spawnGh(["--version"], "/");
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).toContain("gh version");
  });
});
