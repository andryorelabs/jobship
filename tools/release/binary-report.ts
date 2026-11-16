import { statSync } from "node:fs";
import path from "node:path";

/** One built binary and its size in bytes. */
export interface BinarySize {
  name: string;
  bytes: number;
}

/** Renders sizes as a Markdown table for the workflow step summary. */
export function formatSizeSummary(sizes: readonly BinarySize[]): string {
  const rows = sizes.map(
    (size) => `| ${size.name} | ${(size.bytes / (1024 * 1024)).toFixed(1)} MiB | ${size.bytes} |`,
  );
  return ["| Binary | Size | Bytes |", "| --- | --- | --- |", ...rows, ""].join("\n");
}

/** Whether a binary's `--version` output names the expected version. */
export function reportsVersion(output: string, version: string): boolean {
  return output.includes(version);
}

/** Runs the binary with `--version` and returns an error message, or `undefined` when it passes. */
export function smokeRun(binary: string, version: string): string | undefined {
  const result = Bun.spawnSync([binary, "--version"]);
  if (result.exitCode !== 0) {
    return `${binary} --version exited ${result.exitCode}: ${result.stderr.toString().trim()}`;
  }
  const output = result.stdout.toString();
  return reportsVersion(output, version)
    ? undefined
    : `${binary} --version printed "${output.trim()}", expected ${version}`;
}

/** Runs `smoke <binary> <version>` or `sizes <binary>...` and returns the exit code. */
export function runBinaryReport(
  args: readonly string[],
  stdout: (text: string) => void,
  stderr: (text: string) => void,
): number {
  const [command, ...rest] = args;
  if (command === "smoke" && rest.length === 2) {
    const [binary = "", version = ""] = rest;
    const problem = smokeRun(binary, version);
    if (problem === undefined) {
      stdout(`${binary} reports ${version}\n`);
      return 0;
    }
    stderr(`${problem}\n`);
    return 1;
  }
  if (command === "sizes" && rest.length > 0) {
    stdout(
      formatSizeSummary(
        rest.map((file) => ({ name: path.basename(file), bytes: statSync(file).size })),
      ),
    );
    return 0;
  }
  stderr(
    "Usage: bun tools/release/binary-report.ts smoke <binary> <version> | sizes <binary>...\n",
  );
  return 1;
}

if (import.meta.main) {
  process.exitCode = runBinaryReport(
    process.argv.slice(2),
    (text) => process.stdout.write(text),
    (text) => process.stderr.write(text),
  );
}
