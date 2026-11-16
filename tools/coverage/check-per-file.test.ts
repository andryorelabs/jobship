import { describe, expect, test } from "bun:test";

import { checkPerFile, parseFileCoverage, PER_FILE_FLOOR } from "./check-per-file.ts";
import { coverageExceptions, type CoverageException } from "./coverage-exceptions.ts";

const table = (rows: readonly (readonly [string, string, string])[]): string =>
  [
    "-----------|---------|---------|",
    "File       | % Funcs | % Lines |",
    "-----------|---------|---------|",
    "All files  |   99.00 |   99.00 |",
    ...rows.map(([path, functions, lines]) => ` ${path}  |  ${functions} |  ${lines} | 1-2`),
    "-----------|---------|---------|",
  ].join("\n");

const exists = (): boolean => true;
const justified = (lines: number, functions: number): CoverageException => ({
  reason: "entry point",
  lines,
  functions,
});

describe("parseFileCoverage", () => {
  test("reads file rows and skips the header and the All files row", () => {
    expect(parseFileCoverage(table([["src/a.ts", "100.00", "97.50"]]))).toEqual([
      { path: "src/a.ts", functions: 100, lines: 97.5 },
    ]);
  });
});

describe("checkPerFile", () => {
  test("passes when every file meets the floor", () => {
    const result = checkPerFile(table([["src/a.ts", "98.00", "97.00"]]), {}, exists);
    expect(result).toEqual({ ok: true, failures: [] });
  });

  test("names a new file with 50% lines and no exception", () => {
    const result = checkPerFile(table([["src/new.ts", "100.00", "50.00"]]), {}, exists);
    expect(result.ok).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain("src/new.ts");
    expect(result.failures[0]).toContain("no exception");
  });

  test("fails a file under the function floor", () => {
    const result = checkPerFile(table([["src/a.ts", "97.99", "100.00"]]), {}, exists);
    expect(result.failures[0]).toContain("src/a.ts");
  });

  test("accepts an under-floor file held by its exception", () => {
    const result = checkPerFile(
      table([["src/a.ts", "60.00", "80.50"]]),
      { "src/a.ts": justified(80, 60) },
      exists,
    );
    expect(result).toEqual({ ok: true, failures: [] });
  });

  test("fails an exception whose file dropped below its floor", () => {
    const result = checkPerFile(
      table([["src/a.ts", "59.00", "79.00"]]),
      { "src/a.ts": justified(80, 60) },
      exists,
    );
    expect(result.failures).toEqual([
      "src/a.ts line coverage 79% is below its exception floor of 80%",
      "src/a.ts function coverage 59% is below its exception floor of 60%",
    ]);
  });

  test("fails a stale exception for a file that now meets the floor", () => {
    const result = checkPerFile(
      table([["src/a.ts", "100.00", "100.00"]]),
      { "src/a.ts": justified(80, 60) },
      exists,
    );
    expect(result.failures[0]).toContain("stale");
  });

  test("fails a reasonless exception", () => {
    const result = checkPerFile(
      table([["src/a.ts", "60.00", "80.00"]]),
      { "src/a.ts": { reason: "  ", lines: 80, functions: 60 } },
      exists,
    );
    expect(result.failures).toEqual(["exception for src/a.ts has an empty reason"]);
  });

  test("fails an exception whose file was deleted", () => {
    const result = checkPerFile(
      table([]),
      { "src/gone.ts": justified(80, 60) },
      (path) => path !== "src/gone.ts",
    );
    expect(result.failures).toEqual([
      "exception for src/gone.ts is stale: the file does not exist",
    ]);
  });

  test("fails an exception for an existing file missing from the table", () => {
    const result = checkPerFile(table([]), { "src/a.ts": justified(80, 60) }, exists);
    expect(result.failures[0]).toContain("not in the coverage table");
  });

  test("checks existence against the working directory by default", () => {
    const result = checkPerFile(table([]), { "src/does-not-exist.ts": justified(1, 1) });
    expect(result.failures[0]).toContain("does not exist");
  });
});

describe("recorded coverage exceptions", () => {
  test("each has a reason and a floor under the per-file floor", () => {
    for (const exception of Object.values(coverageExceptions)) {
      expect(exception.reason.trim()).not.toBe("");
      expect(
        exception.lines < PER_FILE_FLOOR.lines || exception.functions < PER_FILE_FLOOR.functions,
      ).toBe(true);
    }
  });
});
