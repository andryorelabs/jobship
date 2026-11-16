import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const ADR_DIRECTORY = path.join(import.meta.dir, "..", "docs", "adr");
const ADR_FILE = /^(\d{4})-[a-z0-9-]+\.md$/;

const TEMPLATE_FILE = "0000-template.md";
const REVISED_LINE = /^Revised:(.*)$/gm;
const REVISED_FORM = /^ \d{4}-\d{2}-\d{2} \S.*$/;

/**
 * Lists the `Revised:` lines of an ADR that lack a date or a reason.
 * @param text The ADR source.
 * @returns The offending lines, empty when every one is `Revised: YYYY-MM-DD reason`.
 */
export function findMalformedRevisedLines(text: string): string[] {
  return [...text.matchAll(REVISED_LINE)]
    .filter((match) => !REVISED_FORM.test(match[1] ?? ""))
    .map((match) => match[0]);
}

const adrFiles = readdirSync(ADR_DIRECTORY).filter(
  (name) => ADR_FILE.test(name) && name !== TEMPLATE_FILE,
);
const index = readFileSync(path.join(ADR_DIRECTORY, "README.md"), "utf8");

describe("ADR index", () => {
  test("every ADR file is linked from the index", () => {
    const missing = adrFiles.filter((name) => !index.includes(`(${name})`));
    expect(missing).toEqual([]);
  });

  test("every indexed ADR file exists", () => {
    const linked = [...index.matchAll(/\((\d{4}-[a-z0-9-]+\.md)\)/g)].map(
      (match) => match[1] ?? "",
    );
    expect(linked.filter((name) => name !== TEMPLATE_FILE && !adrFiles.includes(name))).toEqual([]);
  });

  test("numbers are unique and sequential from 0001", () => {
    const numbers = adrFiles.map((name) => Number(name.slice(0, 4))).toSorted((a, b) => a - b);
    expect(numbers).toEqual(numbers.map((_, position) => position + 1));
  });
});

describe("ADR form", () => {
  const REQUIRED_SECTIONS = ["## Context", "## Decision", "## Consequences"];

  test("the template is 0000-template.md and is not counted as an ADR", () => {
    expect(readdirSync(ADR_DIRECTORY)).toContain(TEMPLATE_FILE);
    expect(adrFiles).not.toContain(TEMPLATE_FILE);
  });

  test("a Revised line needs a date and a reason", () => {
    expect(findMalformedRevisedLines("Revised: 2026-11-16 fixed the scope")).toEqual([]);
    expect(findMalformedRevisedLines("Revised: fixed the scope")).toEqual([
      "Revised: fixed the scope",
    ]);
    expect(findMalformedRevisedLines("Revised: 2026-11-16")).toEqual(["Revised: 2026-11-16"]);
    expect(findMalformedRevisedLines("Status: Accepted")).toEqual([]);
  });

  for (const name of adrFiles) {
    const text = readFileSync(path.join(ADR_DIRECTORY, name), "utf8");

    test(`${name} has Status and Date header lines`, () => {
      expect(text).toMatch(/^Status: \S.*$/m);
      expect(text).toMatch(/^Date: \d{4}-\d{2}-\d{2}$/m);
    });

    test(`${name} has well-formed Revised lines`, () => {
      expect(findMalformedRevisedLines(text)).toEqual([]);
    });

    test(`${name} has Context, Decision and Consequences sections`, () => {
      const missing = REQUIRED_SECTIONS.filter((section) => !text.includes(`\n${section}\n`));
      expect(missing).toEqual([]);
    });
  }

  test("the index has Status and Superseded or amended by columns", () => {
    expect(index).toMatch(/^\| #\s+\| Title\s+\| Status\s+\| Superseded or amended by\s+\|$/m);
  });
});
