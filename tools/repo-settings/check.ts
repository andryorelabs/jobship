import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { compareSettings, formatDifference, isJsonValue, isRepositorySettings } from "./compare.ts";
import type { JsonValue, RepoSettings } from "./compare.ts";
import { readLiveSettings } from "./live.ts";
import type { GhApi } from "./live.ts";
import { REPO_ROOT, consoleOutput, resolveRepository, spawnGhApi } from "./repository.ts";

/** Reads and parses a JSON file. */
function readJsonFile(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8"));
}

/** Reads the settings kept as code: `repo-settings.json` and every ruleset file. */
export function readExpectedSettings(root: string = REPO_ROOT): RepoSettings {
  const rulesetsDirectory = path.join(root, ".github", "rulesets");
  const rulesets: Record<string, JsonValue> = {};
  for (const file of readdirSync(rulesetsDirectory).filter((name) => name.endsWith(".json"))) {
    const ruleset = readJsonFile(path.join(rulesetsDirectory, file));
    const name = isJsonValue(ruleset) ? rulesetName(ruleset) : undefined;
    if (!isJsonValue(ruleset) || name === undefined) {
      throw new Error(`${file} is not a named ruleset`);
    }
    rulesets[name] = ruleset;
  }
  const repository = readJsonFile(path.join(root, ".github", "repo-settings.json"));
  if (!isRepositorySettings(repository)) {
    throw new Error(".github/repo-settings.json is missing a setting or has the wrong type");
  }
  return { repository, rulesets };
}

/** The `name` of a parsed ruleset, if it has one. */
function rulesetName(ruleset: JsonValue): string | undefined {
  if (typeof ruleset !== "object" || ruleset === null || Array.isArray(ruleset)) {
    return undefined;
  }
  const name = ruleset.name;
  return typeof name === "string" ? name : undefined;
}

/** Runs `gh api <endpoint>` and captures its output. */
const runGhApi: GhApi = (endpoint) => spawnGhApi(["api", endpoint]);

/** What `runCheck` reads and reports through; injected so tests never touch the network. */
export interface CheckDependencies {
  callGh: GhApi;
  resolveRepository: () => string;
  readExpected: () => RepoSettings;
  log: (line: string) => void;
  logError: (line: string) => void;
}

const defaultDependencies: CheckDependencies = {
  callGh: runGhApi,
  resolveRepository,
  readExpected: readExpectedSettings,
  ...consoleOutput,
};

/** Diffs live settings against the files; exit 0 for no drift, 1 for drift or unreadable. */
export function runCheck(dependencies: CheckDependencies = defaultDependencies): number {
  try {
    const live = readLiveSettings(dependencies.callGh, dependencies.resolveRepository());
    const differences = compareSettings(dependencies.readExpected(), live);
    if (differences.length === 0) {
      dependencies.log("repo settings match the files");
      return 0;
    }
    dependencies.logError(
      `${differences.length} difference(s) between the files and live settings:`,
    );
    for (const difference of differences) {
      dependencies.logError(`  ${formatDifference(difference)}`);
    }
    return 1;
  } catch (error) {
    dependencies.logError(
      `repo settings unreadable: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
}

if (import.meta.main) {
  process.exit(runCheck());
}
