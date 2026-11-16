import { existsSync } from "node:fs";
import { resolve } from "node:path";

import type { CoverageException } from "./coverage-exceptions.ts";

/**
 * Minimum coverage every file must reach, as whole percents, unless it has an exception.
 */
export const PER_FILE_FLOOR = { lines: 97, functions: 98 } as const;

/**
 * One file row of Bun's text coverage table.
 */
export interface FileCoverage {
  readonly path: string;
  readonly functions: number;
  readonly lines: number;
}

/**
 * Outcome of comparing every file row with the per-file floor and the recorded exceptions.
 */
export interface PerFileResult {
  readonly ok: boolean;
  readonly failures: readonly string[];
}

const fileRow = /^\s*(\S+)\s*\|\s*(\d+(?:\.\d+)?)\s*\|\s*(\d+(?:\.\d+)?)\s*\|/;

/**
 * Parses the file rows of Bun's text coverage table (functions first, then lines), skipping the
 * header, the separators and the "All files" row.
 */
export function parseFileCoverage(table: string): FileCoverage[] {
  const rows: FileCoverage[] = [];
  for (const line of table.split("\n")) {
    const match = fileRow.exec(line);
    if (match === null) continue;
    rows.push({ path: match[1] ?? "", functions: Number(match[2]), lines: Number(match[3]) });
  }
  return rows;
}

function isUnderFloor(row: FileCoverage): boolean {
  return row.lines < PER_FILE_FLOOR.lines || row.functions < PER_FILE_FLOOR.functions;
}

function checkException(
  path: string,
  exception: CoverageException,
  row: FileCoverage | undefined,
  fileExists: boolean,
): string[] {
  if (!fileExists) return [`exception for ${path} is stale: the file does not exist`];
  const problems: string[] = [];
  if (exception.reason.trim() === "") problems.push(`exception for ${path} has an empty reason`);
  if (row === undefined) {
    problems.push(`exception for ${path} is stale: the file is not in the coverage table`);
  } else if (!isUnderFloor(row)) {
    problems.push(
      `exception for ${path} is stale: it now meets the ${PER_FILE_FLOOR.lines}% lines and ${PER_FILE_FLOOR.functions}% functions floor`,
    );
  } else {
    if (row.lines < exception.lines) {
      problems.push(
        `${path} line coverage ${row.lines}% is below its exception floor of ${exception.lines}%`,
      );
    }
    if (row.functions < exception.functions) {
      problems.push(
        `${path} function coverage ${row.functions}% is below its exception floor of ${exception.functions}%`,
      );
    }
  }
  return problems;
}

/**
 * Fails for each file under the per-file floor without an exception, and for each exception that
 * is stale, reasonless, for a deleted file, or above the file's measured coverage.
 */
export function checkPerFile(
  table: string,
  exceptions: Readonly<Record<string, CoverageException>>,
  fileExists: (path: string) => boolean = (path) => existsSync(resolve(process.cwd(), path)),
): PerFileResult {
  const rows = parseFileCoverage(table);
  const byPath = new Map(rows.map((row) => [row.path, row]));
  const failures: string[] = [];
  for (const row of rows) {
    if (isUnderFloor(row) && !Object.hasOwn(exceptions, row.path)) {
      failures.push(
        `${row.path} has ${row.lines}% lines and ${row.functions}% functions, under the ${PER_FILE_FLOOR.lines}% lines and ${PER_FILE_FLOOR.functions}% functions floor, and has no exception`,
      );
    }
  }
  for (const [path, exception] of Object.entries(exceptions)) {
    failures.push(...checkException(path, exception, byPath.get(path), fileExists(path)));
  }
  return { ok: failures.length === 0, failures };
}
