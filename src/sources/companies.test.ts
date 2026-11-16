import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { readCompanies } from "./companies.ts";

let root = "";

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "jobship-companies-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function save(content: unknown): void {
  writeFileSync(path.join(root, "companies.json"), JSON.stringify(content));
}

function failureMessage(result: ReturnType<typeof readCompanies>): string {
  return result.ok ? "" : result.error.message;
}

describe("readCompanies", () => {
  test("returns an empty list when the file is missing", () => {
    expect(readCompanies({ path: root })).toEqual({ ok: true, value: [] });
  });

  test("rejects an unknown origin", () => {
    save({ companies: [{ ats: "greenhouse", slug: "acme", origin: "guessed" }] });
    expect(failureMessage(readCompanies({ path: root }))).toContain("origin");
  });

  test("rejects a non-string checkedAt", () => {
    save({ companies: [{ ats: "greenhouse", slug: "acme", checkedAt: 5 }] });
    expect(failureMessage(readCompanies({ path: root }))).toContain("checkedAt");
  });

  test("rejects an entry without ats and slug", () => {
    save({ companies: [{ ats: "greenhouse" }] });
    expect(failureMessage(readCompanies({ path: root }))).toContain("string ats and slug");
  });
});
