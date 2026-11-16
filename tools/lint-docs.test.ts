import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  collectAnchors,
  findBrokenLinks,
  listMarkdownFiles,
  runLintDocs,
  slugifyHeading,
} from "./lint-docs.ts";

let root = "";

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "lint-docs-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("findBrokenLinks", () => {
  test("accepts links to existing files and directories", () => {
    mkdirSync(path.join(root, "docs"));
    writeFileSync(path.join(root, "docs", "a.md"), "# a\n");
    const index = path.join(root, "index.md");
    writeFileSync(index, "[a](docs/a.md) and [dir](docs)\n");
    expect(findBrokenLinks(index)).toEqual([]);
  });

  test("reports a missing target with its line number", () => {
    const index = path.join(root, "index.md");
    writeFileSync(index, "ok\n[gone](missing.md#top)\n");
    expect(findBrokenLinks(index)).toEqual([{ file: index, line: 2, target: "missing.md#top" }]);
  });

  test("ignores urls, anchors and fenced code", () => {
    const index = path.join(root, "index.md");
    writeFileSync(index, "# Top\n[x](https://example.com) [y](#top)\n```\n[z](nope.md)\n```\n");
    expect(findBrokenLinks(index)).toEqual([]);
  });
});

describe("anchors", () => {
  test("slugifies like GitHub: case, punctuation, backticks, emoji and links", () => {
    expect(slugifyHeading("Hello, World!")).toBe("hello-world");
    expect(slugifyHeading("The `jobship doctor` check")).toBe("the-jobship-doctor-check");
    expect(slugifyHeading("<<b>b>Nested <em>tags</em>")).toBe("nested-tags");
    expect(slugifyHeading("a < b")).toBe("a--b");
    expect(slugifyHeading("🔖 Release")).toBe("-release");
    expect(slugifyHeading("See [the guide](x.md) now")).toBe("see-the-guide-now");
    expect(slugifyHeading("snake_case and a-b")).toBe("snake_case-and-a-b");
  });

  test("numbers duplicate headings and ignores fenced code", () => {
    const anchors = collectAnchors("# A\n## A\n### A\n```\n# Hidden\n```\n## B ##\n");
    expect([...anchors].toSorted()).toEqual(["a", "a-1", "a-2", "b"]);
  });

  test("accepts existing anchors in the same and in another file", () => {
    writeFileSync(path.join(root, "b.md"), "# Top\n## Dup\n## Dup\n");
    const index = path.join(root, "index.md");
    writeFileSync(index, "# Mine\n[a](#mine) [b](b.md#top) [c](b.md#dup-1) [d](b.md#TOP)\n");
    expect(findBrokenLinks(index)).toEqual([]);
  });

  test("reports a missing anchor with its link", () => {
    writeFileSync(path.join(root, "b.md"), "# Top\n");
    const index = path.join(root, "index.md");
    writeFileSync(index, "# Mine\n[a](#nope) [b](b.md#missing-heading) [c](gone.md#x)\n");
    expect(findBrokenLinks(index).map((link) => link.target)).toEqual([
      "#nope",
      "b.md#missing-heading",
      "gone.md#x",
    ]);
  });

  test("does not check anchors inside non-Markdown or directory targets", () => {
    mkdirSync(path.join(root, "dir"));
    writeFileSync(path.join(root, "x.html"), "<h1>x</h1>\n");
    const index = path.join(root, "index.md");
    writeFileSync(index, "[a](dir#x) [b](x.html#y) [c](b%20c.md#bad%ZZ)\n");
    writeFileSync(path.join(root, "b c.md"), "# T\n");
    expect(findBrokenLinks(index).map((link) => link.target)).toEqual(["b%20c.md#bad%ZZ"]);
  });
});

describe("listMarkdownFiles", () => {
  test("skips node_modules", () => {
    mkdirSync(path.join(root, "node_modules"));
    writeFileSync(path.join(root, "node_modules", "x.md"), "x\n");
    writeFileSync(path.join(root, "a.md"), "a\n");
    expect(listMarkdownFiles(root)).toEqual([path.join(root, "a.md")]);
  });
});

describe("runLintDocs", () => {
  test("exits 0 when clean", () => {
    writeFileSync(path.join(root, "a.md"), "# A\n[a](#a)\n");
    const messages: string[] = [];
    expect(runLintDocs(root, (message) => messages.push(message))).toBe(0);
    expect(messages).toEqual([]);
  });

  test("exits 1 and names the broken link", () => {
    writeFileSync(path.join(root, "a.md"), "# A\n[a](#missing)\n");
    const messages: string[] = [];
    expect(runLintDocs(root, (message) => messages.push(message))).toBe(1);
    expect(messages).toEqual(["a.md:2: broken link #missing"]);
  });
});
