import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { findSectionRange, hasContent } from "./changelog-section.ts";

const REPO_ROOT = path.join(import.meta.dir, "..", "..");
const CHANGELOG_PATH = path.join(REPO_ROOT, "CHANGELOG.md");
const PLUGIN_PATH = path.join(REPO_ROOT, ".claude-plugin", "plugin.json");
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const UNRELEASED_LINK = /^\[Unreleased\]: (.+)\/compare\/v(.+)\.\.\.HEAD$/;
const VERSION_FIELD = /("version"\s*:\s*)"[^"]*"/;

/** The rewritten file contents for a release. */
export interface PreparedRelease {
  changelog: string;
  pluginJson: string;
}

/**
 * Moves the `[Unreleased]` entries of a changelog into a dated `## [version]` section, adds its
 * compare link and points `[Unreleased]` at the new tag, and sets `version` in the plugin manifest.
 * Throws when the version or date is malformed, `[Unreleased]` has no entries, the version already
 * has a section, or the `[Unreleased]` compare link is missing.
 */
export function prepareRelease(
  changelog: string,
  pluginJson: string,
  version: string,
  date: string,
): PreparedRelease {
  if (!SEMVER.test(version)) {
    throw new Error(`"${version}" is not a semantic version such as 1.2.3`);
  }
  if (!DATE.test(date)) {
    throw new Error(`"${date}" is not a YYYY-MM-DD date`);
  }
  const lines = changelog.split("\n");
  const unreleased = findSectionRange(lines, "Unreleased");
  if (unreleased === undefined) {
    throw new Error("CHANGELOG.md has no [Unreleased] section");
  }
  if (!hasContent(lines.slice(unreleased.start + 1, unreleased.end))) {
    throw new Error("CHANGELOG.md [Unreleased] is empty; there is nothing to release");
  }
  if (findSectionRange(lines, version) !== undefined) {
    throw new Error(`CHANGELOG.md already has a section for ${version}`);
  }
  const linkIndex = lines.findIndex((line) => UNRELEASED_LINK.test(line));
  const link = UNRELEASED_LINK.exec(lines[linkIndex] ?? "");
  if (link === null) {
    throw new Error("CHANGELOG.md has no [Unreleased] compare link");
  }
  if (!VERSION_FIELD.test(pluginJson)) {
    throw new Error("plugin.json has no version field");
  }
  const [, repository, previous] = link;
  const result = [
    ...lines.slice(0, unreleased.start + 1),
    "",
    `## [${version}] - ${date}`,
    ...lines.slice(unreleased.start + 1),
  ];
  result.splice(
    linkIndex + 2,
    1,
    `[Unreleased]: ${repository}/compare/v${version}...HEAD`,
    `[${version}]: ${repository}/compare/v${previous}...v${version}`,
  );
  return {
    changelog: result.join("\n"),
    pluginJson: pluginJson.replace(VERSION_FIELD, `$1"${version}"`),
  };
}

/** Where the release CLI reads, writes and gets the date, so tests can run it without a process. */
export interface ReleaseIo {
  readChangelog: () => string;
  readPluginJson: () => string;
  writeChangelog: (text: string) => void;
  writePluginJson: (text: string) => void;
  today: () => string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

/** Prepares the release named by the only argument and returns the exit code. */
export function runPrepareRelease(args: readonly string[], io: ReleaseIo): number {
  const [version] = args;
  if (version === undefined || args.length !== 1) {
    io.stderr("Usage: bun run release <version>\n");
    return 1;
  }
  try {
    const prepared = prepareRelease(io.readChangelog(), io.readPluginJson(), version, io.today());
    io.writeChangelog(prepared.changelog);
    io.writePluginJson(prepared.pluginJson);
    io.stdout(`Prepared ${version}: review the diff, then follow docs/how-to/cut-a-release.md\n`);
    return 0;
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = runPrepareRelease(process.argv.slice(2), {
    readChangelog: () => readFileSync(CHANGELOG_PATH, "utf8"),
    readPluginJson: () => readFileSync(PLUGIN_PATH, "utf8"),
    writeChangelog: (text) => {
      writeFileSync(CHANGELOG_PATH, text);
    },
    writePluginJson: (text) => {
      writeFileSync(PLUGIN_PATH, text);
    },
    today: () => new Date().toISOString().slice(0, 10),
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  });
}
