import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { formatSizeSummary, reportsVersion, runBinaryReport, smokeRun } from "./binary-report.ts";

let directory = "";
let good = "";
let wrong = "";
let failing = "";

/** Writes an executable shell script that stands in for a built binary. */
function fakeBinary(name: string, body: string): string {
  const file = path.join(directory, name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

beforeAll(() => {
  directory = mkdtempSync(path.join(tmpdir(), "binary-report-"));
  good = fakeBinary("good", 'echo \'{"version":"1.2.3"}\'');
  wrong = fakeBinary("wrong", 'echo \'{"version":"0.0.0-dev"}\'');
  failing = fakeBinary("failing", "echo boom >&2; exit 3");
});

afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe("formatSizeSummary", () => {
  test("renders a Markdown table with MiB and bytes", () => {
    expect(formatSizeSummary([{ name: "jobship-linux-x64", bytes: 2 * 1024 * 1024 }])).toBe(
      [
        "| Binary | Size | Bytes |",
        "| --- | --- | --- |",
        "| jobship-linux-x64 | 2.0 MiB | 2097152 |",
        "",
      ].join("\n"),
    );
  });
});

describe("reportsVersion", () => {
  test("matches output that names the version", () => {
    expect(reportsVersion('{"version":"1.2.3"}', "1.2.3")).toBe(true);
    expect(reportsVersion("0.0.0-dev", "1.2.3")).toBe(false);
  });
});

describe("smokeRun", () => {
  test("passes when the binary reports the version", () => {
    expect(smokeRun(good, "1.2.3")).toBeUndefined();
  });

  test("fails on a wrong version or a non-zero exit", () => {
    expect(smokeRun(wrong, "1.2.3")).toContain("expected 1.2.3");
    expect(smokeRun(failing, "1.2.3")).toContain("exited 3");
  });
});

/** Runs the CLI and collects what it printed. */
function run(args: readonly string[]): { code: number; out: string; err: string } {
  let out = "";
  let err = "";
  const code = runBinaryReport(
    args,
    (text) => {
      out += text;
    },
    (text) => {
      err += text;
    },
  );
  return { code, out, err };
}

describe("runBinaryReport", () => {
  test("smoke returns 0 or 1", () => {
    expect(run(["smoke", good, "1.2.3"]).code).toBe(0);
    expect(run(["smoke", wrong, "1.2.3"]).err).toContain("expected 1.2.3");
  });

  test("sizes prints a table row per file", () => {
    const { code, out } = run(["sizes", good]);
    expect(code).toBe(0);
    expect(out).toContain("| good |");
  });

  test("returns 1 with usage otherwise", () => {
    expect(run([])).toMatchObject({ code: 1 });
    expect(run(["smoke", good]).err).toContain("Usage");
  });
});
