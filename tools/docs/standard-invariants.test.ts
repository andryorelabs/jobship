import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { isObject } from "../../src/core/narrow.ts";
import { listMarkdownFiles } from "../lint-docs.ts";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");
const DOCS_ROOT = path.join(REPO_ROOT, "docs");
const UNINDEXED_PREFIXES = ["docs/agents/", "docs/adr/", "docs/brand/"];
const ENV_VARIABLE = /JOBSHIP_[A-Z][A-Z0-9_]*/g;
const ENV_SUFFIX_CALL = /(?:readSetting|settingValue)\(\s*\w+,\s*"([A-Z][A-Z0-9_]*)"/g;
const OLD_NAME = new RegExp(
  [["hunt", "line"].join(""), "HUN-", "forge", "andryore-starter"].join("|"),
  "i",
);
const LEGACY_ALLOWLIST: readonly (string | RegExp)[] = [
  /^docs\/adr\//,
  "CHANGELOG.md",
  /^docs\/brand\/(naming-.*|color-research|apply-spec)\.md$/,
  "src/core/env.test.ts",
  "src/core/doctor.test.ts",
  "src/e2e/docs.test.ts",
  "tools/shim.test.ts",
  "tools/docs/standard-invariants.test.ts",
];

function read(relative: string): string {
  return readFileSync(path.join(REPO_ROOT, relative), "utf8");
}

function readJson(relative: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(read(relative));
  if (!isObject(parsed)) throw new Error(`${relative} is not a JSON object`);
  return parsed;
}

function field(value: unknown, key: string): unknown {
  return isObject(value) ? value[key] : undefined;
}

function relativeToRoot(file: string): string {
  return path.relative(REPO_ROOT, file).split(path.sep).join("/");
}

function listSourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const full = path.join(directory, entry);
    if (statSync(full).isDirectory()) found.push(...listSourceFiles(full));
    else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) found.push(full);
  }
  return found;
}

function isAllowedLegacy(file: string): boolean {
  return LEGACY_ALLOWLIST.some((entry) =>
    typeof entry === "string" ? entry === file : entry.test(file),
  );
}

function trackedFiles(): string[] {
  const result = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: REPO_ROOT });
  return new TextDecoder().decode(result.stdout).split("\0").filter(Boolean);
}

function isBinary(content: Buffer): boolean {
  return content.subarray(0, 8000).includes(0);
}

/**
 * Reads the fenced text block under a heading of `docs/brand/copy.md`.
 * @param copy The copy file source.
 * @param heading The heading text, such as `brand line`.
 * @returns The block's text, or an empty string when the heading or block is missing.
 */
export function copyLine(copy: string, heading: string): string {
  const start = copy.indexOf(`\n## ${heading}\n`);
  if (start === -1) return "";
  const block = /```text\n([\s\S]*?)\n```/.exec(copy.slice(start));
  return block?.[1] ?? "";
}

type LockEntry = { readonly skillPath?: unknown; readonly computedHash?: unknown };

/**
 * Compares a skills lock with the skills on disk, in both directions, and checks each hash.
 * @param lock The `skills` object of `skills-lock.json`.
 * @param onDisk Skill name to the SHA-256 of its `SKILL.md`.
 * @returns One message per skill missing from the lock, missing on disk or with a wrong hash.
 */
export function checkSkillsLock(
  lock: Readonly<Record<string, LockEntry>>,
  onDisk: Readonly<Record<string, string>>,
): string[] {
  const problems: string[] = [];
  for (const [name, entry] of Object.entries(lock)) {
    const hash = onDisk[name];
    if (hash === undefined) problems.push(`${name}: locked but not in .claude/skills`);
    else if (entry.computedHash !== hash)
      problems.push(`${name}: hash differs from skills-lock.json`);
  }
  for (const name of Object.keys(onDisk)) {
    if (!(name in lock)) problems.push(`${name}: in .claude/skills but not in skills-lock.json`);
  }
  return problems;
}

function skillsOnDisk(): Record<string, string> {
  const directory = path.join(REPO_ROOT, ".claude", "skills");
  const found: Record<string, string> = {};
  if (!existsSync(directory)) return found;
  for (const name of readdirSync(directory)) {
    const file = path.join(directory, name, "SKILL.md");
    if (!existsSync(file)) continue;
    found[name] = createHash("sha256").update(readFileSync(file)).digest("hex");
  }
  return found;
}

describe("old names", () => {
  test("no tracked file outside the allowlist names a retired project name", () => {
    const offenders: string[] = [];
    for (const file of trackedFiles()) {
      if (isAllowedLegacy(file)) continue;
      let content: Buffer;
      try {
        content = readFileSync(path.join(REPO_ROOT, file));
      } catch {
        continue;
      }
      if (isBinary(content)) continue;
      if (OLD_NAME.test(content.toString("utf8"))) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});

describe("docs set", () => {
  for (const name of ["architecture", "development", "security", "configuration"]) {
    test(`docs/${name}.md exists`, () => {
      expect(existsSync(path.join(DOCS_ROOT, `${name}.md`))).toBe(true);
    });
  }

  test("every Markdown file under docs/ is linked from docs/README.md", () => {
    const index = read("docs/README.md");
    const unlinked = listMarkdownFiles(DOCS_ROOT)
      .map(relativeToRoot)
      .filter((file) => file !== "docs/README.md")
      .filter((file) => !UNINDEXED_PREFIXES.some((prefix) => file.startsWith(prefix)))
      .filter((file) => !index.includes(`(${file.slice("docs/".length)})`));
    expect(unlinked).toEqual([]);
  });

  test("docs/README.md links the privacy policy and docs/development.md links the runbook", () => {
    expect(read("docs/README.md")).toContain("(../PRIVACY_POLICY.md)");
    expect(read("docs/how-to/README.md")).toContain("(cut-a-release.md)");
    expect(read("docs/development.md")).toContain("(how-to/cut-a-release.md)");
  });

  test("docs/development.md has the repository settings and releasing anchors", () => {
    const development = read("docs/development.md");
    expect(development).toMatch(/^## Repository settings$/m);
    expect(development).toMatch(/^## Releasing$/m);
  });
});

describe("docs/configuration.md", () => {
  const configuration = read("docs/configuration.md");

  test("names every JOBSHIP_ variable that src/ reads", () => {
    const names = new Set<string>();
    for (const file of listSourceFiles(path.join(REPO_ROOT, "src"))) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(ENV_VARIABLE)) names.add(match[0]);
      for (const match of text.matchAll(ENV_SUFFIX_CALL)) names.add(`JOBSHIP_${match[1]}`);
    }
    names.delete("JOBSHIP_");
    const missing = [...names].filter((name) => !configuration.includes(name));
    expect(missing).toEqual([]);
  });

  test("names the four standard variables", () => {
    for (const name of [
      "JOBSHIP_HOME",
      "JOBSHIP_CACHE_DIR",
      "JOBSHIP_CLAUDE_PLUGINS_FILE",
      "JOBSHIP_BUILD_VERSION",
    ]) {
      expect(configuration).toContain(name);
    }
  });
});

describe("brand copy", () => {
  const copy = read("docs/brand/copy.md");

  test("copyLine reads the fenced block under a heading", () => {
    expect(copyLine("x\n## a\n\n```text\nline\n```\n", "a")).toBe("line");
    expect(copyLine("x", "a")).toBe("");
    expect(copyLine("x\n## a\n", "a")).toBe("");
  });

  test("the README slogan equals the brand line", () => {
    const brandLine = copyLine(copy, "brand line");
    expect(brandLine).not.toBe("");
    expect(read("README.md")).toContain(`\n**${brandLine}**\n`);
  });

  test("the manifest descriptions equal their copy lines", () => {
    const pluginDescription = copyLine(copy, "plugin description");
    const marketplace = readJson(".claude-plugin/marketplace.json");
    const plugins = marketplace["plugins"];
    expect(readJson("package.json")["description"]).toBe(copyLine(copy, "package description"));
    expect(readJson(".claude-plugin/plugin.json")["description"]).toBe(pluginDescription);
    expect(field(marketplace["metadata"], "description")).toBe(pluginDescription);
    expect(
      Array.isArray(plugins) ? plugins.map((entry) => field(entry, "description")) : [],
    ).toEqual([pluginDescription]);
  });
});

describe("skills lock", () => {
  test("checkSkillsLock reports a missing, extra or changed skill", () => {
    expect(checkSkillsLock({ a: { computedHash: "x" } }, { a: "x" })).toEqual([]);
    expect(checkSkillsLock({ a: { computedHash: "x" } }, { a: "y" })).toEqual([
      "a: hash differs from skills-lock.json",
    ]);
    expect(checkSkillsLock({ a: { computedHash: "x" } }, {})).toEqual([
      "a: locked but not in .claude/skills",
    ]);
    expect(checkSkillsLock({}, { b: "x" })).toEqual([
      "b: in .claude/skills but not in skills-lock.json",
    ]);
  });

  test("skills-lock.json matches .claude/skills, with copy mode and a path per skill", () => {
    const skills = readJson("skills-lock.json")["skills"];
    if (!isObject(skills)) throw new Error("skills-lock.json has no skills object");
    const lock: Record<string, LockEntry> = {};
    for (const [name, entry] of Object.entries(skills)) {
      lock[name] = {
        skillPath: field(entry, "skillPath"),
        computedHash: field(entry, "computedHash"),
      };
      expect(field(entry, "installMode"), name).toBe("copy");
      expect(field(entry, "skillPath"), name).toBe(`.claude/skills/${name}/SKILL.md`);
    }
    expect(checkSkillsLock(lock, skillsOnDisk())).toEqual([]);
    expect(Object.keys(lock).toSorted()).toEqual(["add-adr", "cut-release"]);
  });
});

describe("agent files", () => {
  test("docs/agents/ and emet.config.json carry no emet init leftovers", () => {
    const agentFiles = readdirSync(path.join(DOCS_ROOT, "agents"))
      .filter((name) => name.endsWith(".md"))
      .map((name) => `docs/agents/${name}`);
    const leftovers = [...agentFiles, "emet.config.json"].filter((file) => {
      const content = read(file);
      return content.includes("Generated by `emet init`") || /\bT01\b/.test(content);
    });
    expect(leftovers).toEqual([]);
  });
});
