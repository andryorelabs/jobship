/**
 * A file allowed to stay under the per-file floor: why, and the measured floor it must not drop
 * below, as whole percents rounded down.
 */
export interface CoverageException {
  readonly reason: string;
  readonly lines: number;
  readonly functions: number;
}

const mainGuard =
  "the uncovered lines are the import.meta.main entry guard and its process wiring, which a test import never runs";

/**
 * Files below the per-file floor, each with a reason and its measured floor. Add a test instead of
 * adding an entry; delete an entry as soon as its file meets the floor or is removed.
 */
export const coverageExceptions: Readonly<Record<string, CoverageException>> = {
  "src/cli.ts": {
    reason:
      "the uncovered code is the import.meta.main block, the refreshCommand helper and the spawnRefresh closure it wires, which run only when the launcher starts the process, plus the unreachable defensive 'no loader registered' failure",
    lines: 87,
    functions: 44,
  },
  "src/sources/catalog.ts": {
    reason:
      "defaultFetchText is the real network fetch that offline tests must never call; every other line is covered through injected fetch",
    lines: 98,
    functions: 97,
  },
  "tools/release/binary-report.ts": { reason: mainGuard, lines: 89, functions: 75 },
  "tools/release/changelog-section.ts": { reason: mainGuard, lines: 88, functions: 70 },
  "tools/release/prepare-release.ts": { reason: mainGuard, lines: 85, functions: 30 },
  "tools/release/verify-tag.ts": { reason: mainGuard, lines: 89, functions: 75 },
  "tools/repo-settings/apply.ts": {
    reason: "the live GitHub API entry point and one guard that tests never reach offline",
    lines: 97,
    functions: 80,
  },
  "tools/repo-settings/check.ts": {
    reason: mainGuard,
    lines: 98,
    functions: 83,
  },
};
