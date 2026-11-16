import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { readCustomBoards, updateCustomBoards } from "./custom-boards.ts";

let root = "";

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "jobship-custom-boards-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("updateCustomBoards", () => {
  test("reports custom-boards-write-failed when the change throws and writes nothing", async () => {
    const result = await updateCustomBoards(root, () => {
      throw new Error("change exploded");
    });
    expect(result).toEqual({
      ok: false,
      error: { code: "custom-boards-write-failed", message: "change exploded" },
    });
    expect(existsSync(path.join(root, "boards.json"))).toBe(false);
  });

  test("returns the read failure without calling change", async () => {
    writeFileSync(path.join(root, "boards.json"), "{ not json");
    let called = false;
    const result = await updateCustomBoards(root, () => {
      called = true;
      return { ok: true, value: { boards: [], value: null } };
    });
    expect(result.ok).toBe(false);
    expect(called).toBe(false);
  });

  test("passes through a failed change", async () => {
    const result = await updateCustomBoards(root, () => ({
      ok: false,
      error: { code: "board-invalid", message: "nope" },
    }));
    expect(result).toEqual({ ok: false, error: { code: "board-invalid", message: "nope" } });
  });
});

describe("readCustomBoards", () => {
  test("rejects a file that is not valid JSON", async () => {
    writeFileSync(path.join(root, "boards.json"), "{ not json");
    const result = await readCustomBoards(root);
    expect(result.ok ? "" : result.error.code).toBe("custom-boards-invalid");
  });
});
