import { describe, expect, test } from "bun:test";

import { prepareRelease, runPrepareRelease, type ReleaseIo } from "./prepare-release.ts";

const REPO = "https://example.test/o/r";

const CHANGELOG = [
  "# Changelog",
  "",
  "## [Unreleased]",
  "",
  "### Added",
  "",
  "- A new thing.",
  "",
  "## [0.8.0] - 2026-11-15",
  "",
  "- Old thing.",
  "",
  `[Unreleased]: ${REPO}/compare/v0.8.0...HEAD`,
  `[0.8.0]: ${REPO}/compare/v0.7.0...v0.8.0`,
  "",
].join("\n");

const PLUGIN = '{\n  "name": "x",\n  "version": "0.8.0",\n  "license": "MIT"\n}\n';

describe("prepareRelease", () => {
  test("moves Unreleased entries into a dated section with compare links", () => {
    const { changelog, pluginJson } = prepareRelease(CHANGELOG, PLUGIN, "0.9.0", "2026-12-01");
    expect(changelog).toBe(
      [
        "# Changelog",
        "",
        "## [Unreleased]",
        "",
        "## [0.9.0] - 2026-12-01",
        "",
        "### Added",
        "",
        "- A new thing.",
        "",
        "## [0.8.0] - 2026-11-15",
        "",
        "- Old thing.",
        "",
        `[Unreleased]: ${REPO}/compare/v0.9.0...HEAD`,
        `[0.9.0]: ${REPO}/compare/v0.8.0...v0.9.0`,
        `[0.8.0]: ${REPO}/compare/v0.7.0...v0.8.0`,
        "",
      ].join("\n"),
    );
    expect(pluginJson).toBe(PLUGIN.replace("0.8.0", "0.9.0"));
  });

  test("refuses an Unreleased section with no entries", () => {
    const empty = CHANGELOG.replace("### Added\n\n- A new thing.\n\n", "");
    expect(() => prepareRelease(empty, PLUGIN, "0.9.0", "2026-12-01")).toThrow(
      "[Unreleased] is empty",
    );
    const headingsOnly = CHANGELOG.replace("- A new thing.\n\n", "");
    expect(() => prepareRelease(headingsOnly, PLUGIN, "0.9.0", "2026-12-01")).toThrow("is empty");
  });

  test("refuses a malformed version or date", () => {
    expect(() => prepareRelease(CHANGELOG, PLUGIN, "v0.9", "2026-12-01")).toThrow(
      "semantic version",
    );
    expect(() => prepareRelease(CHANGELOG, PLUGIN, "0.9.0", "12/01/2026")).toThrow("YYYY-MM-DD");
  });

  test("refuses a version that already has a section", () => {
    expect(() => prepareRelease(CHANGELOG, PLUGIN, "0.8.0", "2026-12-01")).toThrow("already has");
  });

  test("refuses a changelog without an Unreleased section or compare link", () => {
    const noSection = CHANGELOG.replace("## [Unreleased]", "## [Next]");
    expect(() => prepareRelease(noSection, PLUGIN, "0.9.0", "2026-12-01")).toThrow(
      "no [Unreleased] section",
    );
    const noLink = CHANGELOG.replace(`[Unreleased]: ${REPO}/compare/v0.8.0...HEAD\n`, "");
    expect(() => prepareRelease(noLink, PLUGIN, "0.9.0", "2026-12-01")).toThrow("compare link");
  });

  test("refuses a manifest without a version", () => {
    expect(() => prepareRelease(CHANGELOG, "{}", "0.9.0", "2026-12-01")).toThrow("no version");
  });
});

/** Builds an in-memory IO and exposes what the CLI wrote. */
function createIo(changelog: string): {
  io: ReleaseIo;
  written: { changelog?: string; pluginJson?: string };
  out: string[];
  err: string[];
} {
  const written: { changelog?: string; pluginJson?: string } = {};
  const out: string[] = [];
  const err: string[] = [];
  return {
    written,
    out,
    err,
    io: {
      readChangelog: () => changelog,
      readPluginJson: () => PLUGIN,
      writeChangelog: (text) => {
        written.changelog = text;
      },
      writePluginJson: (text) => {
        written.pluginJson = text;
      },
      today: () => "2026-12-01",
      stdout: (text) => out.push(text),
      stderr: (text) => err.push(text),
    },
  };
}

describe("runPrepareRelease", () => {
  test("writes both files and exits 0", () => {
    const { io, written, out } = createIo(CHANGELOG);
    expect(runPrepareRelease(["0.9.0"], io)).toBe(0);
    expect(written.changelog).toContain("## [0.9.0] - 2026-12-01");
    expect(written.pluginJson).toContain('"version": "0.9.0"');
    expect(out.join("")).toContain("Prepared 0.9.0");
  });

  test("exits 1 and writes nothing when Unreleased is empty", () => {
    const { io, written, err } = createIo("## [Unreleased]\n\n## [0.8.0] - x\n\n- a\n");
    expect(runPrepareRelease(["0.9.0"], io)).toBe(1);
    expect(written).toEqual({});
    expect(err.join("")).toContain("is empty");
  });

  test("exits 1 with usage when the version argument is missing or extra", () => {
    const { io, err } = createIo(CHANGELOG);
    expect(runPrepareRelease([], io)).toBe(1);
    expect(runPrepareRelease(["0.9.0", "x"], io)).toBe(1);
    expect(err.join("")).toContain("Usage");
  });
});
