import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const CHANGELOG = path.resolve(import.meta.dir, "..", "CHANGELOG.md");
const VERSION_HEADING = /^## \[([^\]]+)\]/gm;
const LINK_REFERENCE = /^\[([^\]]+)\]:\s*\S+/gm;

/**
 * Lists problems in a Keep a Changelog document.
 * @param text The CHANGELOG source.
 * @returns One message per missing preamble mention, `[Unreleased]` heading or link reference.
 */
export function findChangelogProblems(text: string): string[] {
  const problems: string[] = [];
  const headings = [...text.matchAll(VERSION_HEADING)].map((match) => match[1] ?? "");
  const references = new Set([...text.matchAll(LINK_REFERENCE)].map((match) => match[1] ?? ""));
  if (!/Keep a Changelog/i.test(text)) problems.push("preamble does not name Keep a Changelog");
  if (!/Semantic Versioning/i.test(text))
    problems.push("preamble does not name Semantic Versioning");
  if (!headings.includes("Unreleased")) problems.push("missing [Unreleased] heading");
  for (const heading of headings) {
    if (!references.has(heading)) problems.push(`no link reference for [${heading}]`);
  }
  return problems;
}

describe("findChangelogProblems", () => {
  const preamble = "Keep a Changelog and Semantic Versioning.\n\n";

  test("accepts a complete changelog with pre-release and yanked headings", () => {
    const text = `${preamble}## [Unreleased]\n\n## [1.0.0-rc.1] - 2026-01-02\n\n## [0.9.0] - 2026-01-01 [YANKED]\n\n[Unreleased]: https://x/compare/v1.0.0-rc.1...HEAD\n[1.0.0-rc.1]: https://x/compare/v0.9.0...v1.0.0-rc.1\n[0.9.0]: https://x/releases/tag/v0.9.0\n`;
    expect(findChangelogProblems(text)).toEqual([]);
  });

  test("fails when a version heading has no link reference", () => {
    const text = `${preamble}## [Unreleased]\n\n## [0.2.0] - 2026-01-01\n\n[Unreleased]: https://x/compare\n`;
    expect(findChangelogProblems(text)).toEqual(["no link reference for [0.2.0]"]);
  });

  test("fails without [Unreleased] or the preamble mentions", () => {
    expect(findChangelogProblems("# Changelog\n")).toEqual([
      "preamble does not name Keep a Changelog",
      "preamble does not name Semantic Versioning",
      "missing [Unreleased] heading",
    ]);
  });
});

describe("CHANGELOG.md", () => {
  test("is complete", () => {
    expect(findChangelogProblems(readFileSync(CHANGELOG, "utf8"))).toEqual([]);
  });
});
