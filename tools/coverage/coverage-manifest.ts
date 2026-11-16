import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Inputs for {@link findCoverageProblems}: all module paths are repo-relative POSIX paths.
 */
export interface CoverageManifestInput {
  readonly modules: readonly string[];
  readonly loadedModules: ReadonlySet<string>;
  readonly exemptions: Readonly<Record<string, string>>;
}

const MODULE_ROOTS = ["src", "tools"] as const;

/**
 * Reads `coveragePathIgnorePatterns` from a `bunfig.toml` text: the paths Bun leaves out of the
 * coverage table on purpose.
 */
export function readCoverageIgnorePatterns(bunfig: string): string[] {
  const parsed: unknown = Bun.TOML.parse(bunfig);
  if (typeof parsed !== "object" || parsed === null) return [];
  const testSection: unknown = (parsed as { test?: unknown }).test;
  if (typeof testSection !== "object" || testSection === null) return [];
  const patterns: unknown = (testSection as { coveragePathIgnorePatterns?: unknown })
    .coveragePathIgnorePatterns;
  if (!Array.isArray(patterns)) return [];
  return patterns.filter((pattern): pattern is string => typeof pattern === "string");
}

/**
 * Lists every source module under `src/` and `tools/` that the coverage table should show:
 * test files, declarations and paths matching `ignorePatterns` are left out.
 */
export function listModules(root: string, ignorePatterns: readonly string[]): string[] {
  const ignored = ignorePatterns.map((pattern) => new Bun.Glob(pattern));
  return MODULE_ROOTS.flatMap((moduleRoot) =>
    Array.from(new Bun.Glob(`${moduleRoot}/**/*.ts`).scanSync({ cwd: root })),
  )
    .map((path) => path.split("\\").join("/"))
    .filter((path) => !path.endsWith(".test.ts") && !path.endsWith(".d.ts"))
    .filter((path) => !ignored.some((glob) => glob.match(path)))
    .toSorted();
}

/**
 * Lists the modules of `root` per {@link listModules}, honouring the ignore patterns in its
 * `bunfig.toml`.
 */
export function listRepositoryModules(root: string): string[] {
  return listModules(
    root,
    readCoverageIgnorePatterns(readFileSync(join(root, "bunfig.toml"), "utf8")),
  );
}

/**
 * Returns one message per violation of the coverage manifest policy: every module must show up
 * in the coverage table of a full run, or carry an exemption with a reason. An exemption for a
 * module that is missing or now loaded is stale. Empty means the manifest holds.
 */
export function findCoverageProblems(input: CoverageManifestInput): string[] {
  const problems: string[] = [];
  const known = new Set(input.modules);
  for (const modulePath of input.modules) {
    const exempt = Object.hasOwn(input.exemptions, modulePath);
    if (!input.loadedModules.has(modulePath) && !exempt) {
      problems.push(`${modulePath} is not loaded by any test and has no exemption`);
    }
  }
  for (const [modulePath, reason] of Object.entries(input.exemptions)) {
    if (reason.trim() === "") {
      problems.push(`exemption for ${modulePath} has an empty reason`);
    }
    if (!known.has(modulePath)) {
      problems.push(`exemption for ${modulePath} is stale: the module does not exist`);
    } else if (input.loadedModules.has(modulePath)) {
      problems.push(`exemption for ${modulePath} is stale: a test now loads it`);
    }
  }
  return problems;
}
