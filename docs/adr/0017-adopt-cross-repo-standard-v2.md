# Adopt the cross-repo standard v2

Status: Accepted
Date: 2026-11-16

jobship adopts the cross-repo standard v2 on top of v1, with the not-applicable rules listed below.

## Context

On 2026-11-15 the six repository sessions (aokit, emet, jobship, snug, animated-fluent-emojis, andryore-web) audited one another and voted on 45 candidate rules, V01 to V45. All 45 passed. aokit holds the canonical text in its [standards pages](https://github.com/andryorelabs/aokit/tree/main/docs/standards), including the label set, the import order and the toolchain version table. Each repository adopts the standard in its own repository and lists its not-applicable rules in an ADR. The aokit page links those ADRs instead of copying the lists.

jobship already met part of v2: the env-var documentation test, the Keep a Changelog file, TypeScript hooks with tests, and the whole-range commitlint check. The gaps were repository settings, labels, the shared Oxlint baseline, the CLI contract, plugin contract tests, CI and release hardening, and per-file coverage.

## Decision

- jobship adopts standard v2 as written in the aokit standards pages. Spec #201 lists the concrete requirements. [ADR-0007](0007-adopt-cross-repo-standard-v1.md) still applies; this ADR adds to it.
- The Oxlint baseline, the project skills `add-adr` and `cut-release`, the label set, the import order and the toolchain pins are copied from aokit, not restated, so a drift test can compare them.
- The CLI prints readable output when stdout is a TTY and the JSON envelope otherwise; `--json` forces JSON. The skills keep calling the CLI through Bash and keep receiving JSON. The Guard's hook output is unchanged, and the Guard still fails closed ([ADR-0002](0002-the-guard-fails-closed.md)).
- In readable mode only, the CLI checks GitHub Releases at most once a day, in a detached process, and prints one line when a newer version exists. `JOBSHIP_NO_UPDATE_CHECK=1` or a set `CI` turns the check off.
- Every source file meets 97% line and 98% function coverage. A file below the floor needs an entry in the coverage exceptions list, with a reason and its measured floor.
- Dependabot alerts and Dependabot security updates both stay on beside Renovate.
- Rules that do not apply to jobship, with reasons:
  - V08 `llms.txt` for packages and sites: jobship is neither. Its `llms.txt` already exists under the v1 CLI and plugin rule.
  - V09 `ACCESSIBILITY.md` and `DESIGN.md`, V34 site build checks, V41 site security headers: jobship has no site yet. The site is deferred, as in ADR-0007.
  - V17 lint parity and V18 the shared lint-policy module: jobship runs Oxlint only, with no ESLint companion.
  - V26 per-workspace coverage floors: jobship is not a monorepo.
  - V27 flaky-test summary: jobship has no browser end-to-end suite.
  - V38 `publint` and `attw`: jobship is not published to npm.
  - V42 i18n parity: jobship is English only.
  - V44 encrypted `.env`: jobship keeps no `.env` file.
  - The `typescript` 6 alias from the toolchain table: nothing in jobship imports the TypeScript compiler API.

## Consequences

- The drift tests fail the build when jobship's Oxlint baseline, skills, labels or toolchain pins differ from aokit's, so updating the standard means updating aokit first and then copying.
- Scripts that pipe `jobship` output keep getting JSON. A person at a terminal gets readable output and may see one update line on stderr.
- The coverage floor makes new code ship with tests. Unreachable code needs an exception with a reason instead of a lower global threshold.
- Adding a site later brings V09, V34 and V41 into scope; that needs a new ADR that amends this one.
