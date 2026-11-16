import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { CommandContext } from "../core/commands.ts";
import { run } from "./command.ts";
import { isSafeKey, packPath, scaffoldPrepPack, validatePrepPack, type FactIndex } from "./pack.ts";

const facts: FactIndex = { facts: [{ id: "f-api", text: "Built a billing API", tags: [] }] };

let root: string;
let ctx: CommandContext;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "interview-cov-"));
  ctx = { dataDir: { path: root }, env: {}, cwd: root };
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("pack helpers", () => {
  test("isSafeKey rejects blank, oversized and NUL keys", () => {
    expect(isSafeKey("  ")).toBe(false);
    expect(isSafeKey("a".repeat(301))).toBe(false);
    expect(isSafeKey("a\0b")).toBe(false);
    expect(isSafeKey("acme")).toBe(true);
  });

  test("packPath hashes keys that are not filename safe", () => {
    const dir = { path: root };
    expect(path.basename(packPath(dir, "acme-dev"))).toBe("acme-dev.md");
    expect(path.basename(packPath(dir, "a/b"))).toMatch(/^a-b-[0-9a-f]{8}\.md$/);
    expect(path.basename(packPath(dir, "a..b"))).toMatch(/^a\.b-[0-9a-f]{8}\.md$/);
    expect(path.basename(packPath(dir, "///"))).toMatch(/^pack-[0-9a-f]{8}\.md$/);
  });

  test("scaffoldPrepPack rejects unsafe keys and reports write failures", () => {
    const unsafe = scaffoldPrepPack({ path: root }, "", facts);
    expect(!unsafe.ok && unsafe.error.code).toBe("usage");
    const blocked = path.join(root, "blocked");
    writeFileSync(blocked, "x");
    const failed = scaffoldPrepPack({ path: blocked }, "acme", facts);
    expect(!failed.ok && failed.error.code).toBe("internal");
  });

  test("scaffold without facts leaves a TODO story hint", () => {
    const created = scaffoldPrepPack({ path: root }, "empty", { facts: [] });
    expect(created.ok).toBe(true);
  });

  test("validatePrepPack flags missing sections, facts and fields", () => {
    const markdown = [
      "## Stories",
      "### One",
      "- Facts:",
      "- Situation: x",
      "### Two",
      "- Action: y",
      "- Facts: ghost, f-api",
      "text outside a field",
      "",
    ].join("\n");
    const rules = validatePrepPack(markdown, facts).map((finding) => finding.rule);
    expect(rules).toContain("missing-section");
    expect(rules).toContain("story-without-facts");
    expect(rules).toContain("missing-field");
    expect(rules).toContain("unknown-fact");
    const noFactsLine = validatePrepPack("## Stories\n### Solo\n", facts).map((f) => f.rule);
    expect(noFactsLine).toContain("story-without-facts");
  });
});

describe("interview command errors", () => {
  test("usage, unsafe key and data-dir failures", async () => {
    expect((await run(["pack", "--x"], ctx)).ok).toBe(false);
    const unsafe = await run(["pack", " "], ctx);
    expect(!unsafe.ok && unsafe.error.message).toContain("unsafe key");
    const noDir = await run(["pack", "acme"], { dataDir: null, env: {}, cwd: root });
    expect(!noDir.ok && noDir.error.code).toBe("data-dir-not-found");
  });

  test("fact bank, existing pack and missing pack failures", async () => {
    const noBank = await run(["pack", "acme"], ctx);
    expect(noBank.ok).toBe(false);
    writeFileSync(path.join(root, "facts.yaml"), "facts:\n  - id: f-api\n    text: Built\n");
    mkdirSync(path.join(root, "prep"));
    const missing = await run(["check", "acme"], ctx);
    expect(!missing.ok && missing.error.code).toBe("not-found");
    expect((await run(["pack", "acme"], ctx)).ok).toBe(true);
    const again = await run(["pack", "acme"], ctx);
    expect(!again.ok && again.error.code).toBe("already-exists");
  });
});
