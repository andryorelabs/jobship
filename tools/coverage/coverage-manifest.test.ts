import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { coverageExemptions } from "./coverage-exemptions.ts";
import {
  findCoverageProblems,
  listModules,
  listRepositoryModules,
  readCoverageIgnorePatterns,
} from "./coverage-manifest.ts";

const repoRoot = resolve(import.meta.dir, "../..");

describe("findCoverageProblems", () => {
  const modules = ["src/a.ts", "src/b.ts"];

  test("accepts loaded modules and justified exemptions", () => {
    expect(
      findCoverageProblems({
        modules,
        loadedModules: new Set(["src/a.ts"]),
        exemptions: { "src/b.ts": "process entry point" },
      }),
    ).toEqual([]);
  });

  test("flags a module no test loads and that has no exemption", () => {
    expect(
      findCoverageProblems({ modules, loadedModules: new Set(["src/a.ts"]), exemptions: {} }),
    ).toEqual(["src/b.ts is not loaded by any test and has no exemption"]);
  });

  test("flags an empty reason", () => {
    expect(
      findCoverageProblems({
        modules,
        loadedModules: new Set(["src/a.ts"]),
        exemptions: { "src/b.ts": "  " },
      }),
    ).toEqual(["exemption for src/b.ts has an empty reason"]);
  });

  test("flags an exemption for a missing module", () => {
    expect(
      findCoverageProblems({
        modules,
        loadedModules: new Set(modules),
        exemptions: { "src/gone.ts": "was an entry point" },
      }),
    ).toEqual(["exemption for src/gone.ts is stale: the module does not exist"]);
  });

  test("flags an exemption for a module a test now loads", () => {
    expect(
      findCoverageProblems({
        modules,
        loadedModules: new Set(modules),
        exemptions: { "src/a.ts": "no test" },
      }),
    ).toEqual(["exemption for src/a.ts is stale: a test now loads it"]);
  });
});

describe("readCoverageIgnorePatterns", () => {
  test("reads the patterns from the test section", () => {
    expect(
      readCoverageIgnorePatterns('[test]\ncoveragePathIgnorePatterns = ["a/**", "b.ts"]\n'),
    ).toEqual(["a/**", "b.ts"]);
  });

  test("returns nothing when the section or the key is missing or malformed", () => {
    expect(readCoverageIgnorePatterns("")).toEqual([]);
    expect(readCoverageIgnorePatterns("test = 1\n")).toEqual([]);
    expect(readCoverageIgnorePatterns("[test]\ncoverage = true\n")).toEqual([]);
    expect(readCoverageIgnorePatterns('[test]\ncoveragePathIgnorePatterns = ["a", 1]\n')).toEqual([
      "a",
    ]);
  });
});

describe("repository modules", () => {
  const modules = listRepositoryModules(repoRoot);

  test("lists src and tools modules without tests, fixtures or ignored paths", () => {
    expect(modules).toContain("src/cli.ts");
    expect(modules).toContain("tools/coverage/run-tests.ts");
    expect(modules.some((path) => path.endsWith(".test.ts"))).toBe(false);
    expect(modules.some((path) => path.includes("/fixtures/"))).toBe(false);
    expect(modules).not.toContain("tools/build-binaries.ts");
  });

  test("an ignore pattern drops the matching modules", () => {
    expect(listModules(repoRoot, ["tools/**"]).some((path) => path.startsWith("tools/"))).toBe(
      false,
    );
  });

  test("every exemption names an existing module and gives a reason", () => {
    for (const [modulePath, reason] of Object.entries(coverageExemptions)) {
      expect(existsSync(resolve(repoRoot, modulePath))).toBe(true);
      expect(modules).toContain(modulePath);
      expect(reason.trim()).not.toBe("");
    }
  });
});
