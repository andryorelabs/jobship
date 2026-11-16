import { readFileSync } from "node:fs";
import path from "node:path";

const CHANGELOG_PATH = path.join(import.meta.dir, "..", "..", "CHANGELOG.md");
const SECTION_HEADING = /^## \[([^\]]+)\]/;
const LINK_REFERENCE = /^\[[^\]]+\]: /;
const HEADING = /^\s*#{1,6}(\s|$)/;

/** Where a section starts and ends in a changelog split into lines; `end` is exclusive. */
export interface SectionRange {
  start: number;
  end: number;
}

/** Locates the section whose heading names `name`, or returns `undefined` when there is none. */
export function findSectionRange(lines: readonly string[], name: string): SectionRange | undefined {
  const start = lines.findIndex((line) => SECTION_HEADING.exec(line)?.[1] === name);
  if (start === -1) {
    return undefined;
  }
  const rest = lines.slice(start + 1);
  const offset = rest.findIndex((line) => SECTION_HEADING.test(line) || LINK_REFERENCE.test(line));
  return { start, end: offset === -1 ? lines.length : start + 1 + offset };
}

/** Whether the lines hold anything beyond headings and blank lines. */
export function hasContent(sectionLines: readonly string[]): boolean {
  return sectionLines.some((line) => line.trim() !== "" && !HEADING.test(line));
}

/**
 * Returns the body of the `CHANGELOG.md` section for a release tag, without its heading.
 * The tag may carry a leading `v`. Throws when the section is missing or has no content
 * beyond headings and blank lines, so a release is never published with empty notes.
 */
export function extractChangelogSection(changelog: string, tag: string): string {
  const version = tag.replace(/^v/, "");
  const lines = changelog.split("\n");
  const range = /^\d/.test(version) ? findSectionRange(lines, version) : undefined;
  if (range === undefined) {
    throw new Error(`CHANGELOG.md has no section for ${tag}`);
  }
  const sectionLines = lines.slice(range.start + 1, range.end);
  if (!hasContent(sectionLines)) {
    throw new Error(`CHANGELOG.md section for ${tag} is empty`);
  }
  return sectionLines.join("\n").trim();
}

/** Where the notes CLI reads and writes, so tests can run it without a process. */
export interface ChangelogSectionIo {
  readChangelog: () => string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

/** Prints the section for the tag given as the only argument and returns the exit code. */
export function runChangelogSection(args: readonly string[], io: ChangelogSectionIo): number {
  const [tag] = args;
  if (tag === undefined || args.length !== 1) {
    io.stderr("Usage: bun tools/release/changelog-section.ts <tag>\n");
    return 1;
  }
  try {
    io.stdout(`${extractChangelogSection(io.readChangelog(), tag)}\n`);
    return 0;
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = runChangelogSection(process.argv.slice(2), {
    readChangelog: () => readFileSync(CHANGELOG_PATH, "utf8"),
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  });
}
