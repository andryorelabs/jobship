import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const MARKDOWN_LINK = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const EXTERNAL_TARGET = /^([a-z][a-z0-9+.-]*:|\/\/)/i;
const IGNORED_DIRECTORIES: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  "dist",
  "coverage",
  ".claude",
]);

const HEADING_LINE = /^ {0,3}#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/;
const SLUG_DISALLOWED = /[^\p{L}\p{N}\p{M}\s_-]/gu;

export type BrokenLink = { readonly file: string; readonly line: number; readonly target: string };

/**
 * Lists the markdown files under a directory, skipping dependency and build folders.
 * @param root The directory to walk.
 * @returns Absolute paths of every `.md` file found.
 */
export function listMarkdownFiles(root: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (IGNORED_DIRECTORIES.has(entry.name)) continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) found.push(...listMarkdownFiles(full));
    else if (entry.name.endsWith(".md")) found.push(full);
  }
  return found;
}

/**
 * Removes HTML tags until none are left, then any stray angle bracket, so a nested tag such
 * as `<<b>b>` cannot leave a tag behind.
 * @param text Heading text that may contain inline HTML.
 * @returns The text without tags or angle brackets.
 */
function stripHtmlTags(text: string): string {
  const stripped = text.replace(/<[^<>]*>/g, "");
  return stripped === text ? text.replace(/[<>]/g, "") : stripHtmlTags(stripped);
}

/**
 * Turns heading text into a GitHub-style slug, without the duplicate suffix.
 * @param heading The heading text, with inline Markdown.
 * @returns The lowercase slug with spaces as hyphens and punctuation removed.
 */
export function slugifyHeading(heading: string): string {
  return stripHtmlTags(heading.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1"))
    .toLowerCase()
    .replace(SLUG_DISALLOWED, "")
    .replace(/\s/g, "-");
}

/**
 * Collects the anchor slugs a Markdown document defines, numbering repeats as GitHub does.
 * @param text The Markdown source.
 * @returns The set of slugs, where a repeated heading gets a `-1`, `-2` suffix.
 */
export function collectAnchors(text: string): Set<string> {
  const anchors = new Set<string>();
  const seen = new Map<string, number>();
  let inFence = false;
  for (const line of text.split("\n")) {
    if (line.trimStart().startsWith("```")) inFence = !inFence;
    if (inFence) continue;
    const heading = HEADING_LINE.exec(line)?.[1];
    if (heading === undefined) continue;
    const base = slugifyHeading(heading);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    anchors.add(count === 0 ? base : `${base}-${count}`);
  }
  return anchors;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function anchorExists(file: string, fragment: string): boolean {
  if (!file.endsWith(".md") || !existsSync(file) || statSync(file).isDirectory()) return true;
  return collectAnchors(readFileSync(file, "utf8")).has(safeDecode(fragment).toLowerCase());
}

/**
 * Finds relative markdown links whose target file, directory or heading anchor does not exist.
 * Absolute URLs are ignored; `#anchor` links are checked against the target file's headings.
 * @param file The markdown file to scan.
 * @returns One entry per broken link, with its line number.
 */
export function findBrokenLinks(file: string): BrokenLink[] {
  const broken: BrokenLink[] = [];
  const lines = readFileSync(file, "utf8").split("\n");
  let inFence = false;
  lines.forEach((text, index) => {
    if (text.trimStart().startsWith("```")) inFence = !inFence;
    if (inFence) return;
    for (const match of text.matchAll(MARKDOWN_LINK)) {
      const target = match[1] ?? "";
      if (EXTERNAL_TARGET.test(target)) continue;
      const [pathPart = "", ...fragmentParts] = target.split("#");
      const fragment = fragmentParts.join("#");
      const withoutFragment = safeDecode(pathPart);
      const resolved =
        withoutFragment === "" ? file : path.resolve(path.dirname(file), withoutFragment);
      if (!existsSync(resolved)) {
        broken.push({ file, line: index + 1, target });
        continue;
      }
      if (fragment === "" || anchorExists(resolved, fragment)) continue;
      broken.push({ file, line: index + 1, target });
    }
  });
  return broken;
}

/**
 * Lints every Markdown file under a root and reports each broken link.
 * @param root The directory to lint.
 * @param report Receives one message per broken link.
 * @returns The process exit code: 0 when clean, 1 otherwise.
 */
export function runLintDocs(root: string, report: (message: string) => void): number {
  const broken = listMarkdownFiles(root).flatMap(findBrokenLinks);
  for (const link of broken) {
    report(`${path.relative(root, link.file)}:${link.line}: broken link ${link.target}`);
  }
  return broken.length === 0 ? 0 : 1;
}

if (import.meta.main) process.exit(runLintDocs(process.cwd(), console.error));
