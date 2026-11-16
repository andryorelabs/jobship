import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isRecord, readRootManifest, repositoryRoot, stringEntriesOf } from "./package-manifest.ts";

const scratchDirectories: string[] = [];
let fileSpy: { mockRestore(): void } | undefined;

afterEach(async () => {
  fileSpy?.mockRestore();
  fileSpy = undefined;
  await Promise.all(
    scratchDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("isRecord", () => {
  test("accepts plain objects only", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(isRecord("text")).toBe(false);
  });
});

describe("readRootManifest", () => {
  test("reads the root package.json", async () => {
    const manifest = await readRootManifest();
    expect(manifest.name).toBe("jobship");
    expect(await Bun.file(`${repositoryRoot}/package.json`).exists()).toBe(true);
  });

  test("rejects a manifest that is not a JSON object", async () => {
    const directory = await mkdtemp(join(tmpdir(), "package-manifest-"));
    scratchDirectories.push(directory);
    const arrayManifest = join(directory, "package.json");
    await writeFile(arrayManifest, "[]");
    fileSpy = spyOn(Bun, "file").mockReturnValue(Bun.file(arrayManifest));
    const failure = await readRootManifest().then(
      () => "resolved",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    expect(failure).toBe("package.json is not a JSON object");
  });
});

describe("stringEntriesOf", () => {
  test("keeps only the string entries of an object field", () => {
    const entries = stringEntriesOf({ scripts: { test: "bun test", count: 1 } }, "scripts");
    expect([...entries]).toEqual([["test", "bun test"]]);
  });

  test("returns an empty map for a missing or non-object field", () => {
    expect(stringEntriesOf({}, "scripts").size).toBe(0);
    expect(stringEntriesOf({ scripts: ["a"] }, "scripts").size).toBe(0);
  });
});
