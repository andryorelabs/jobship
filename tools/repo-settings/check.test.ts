import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { readExpectedSettings, runCheck } from "./check.ts";
import type { CheckDependencies } from "./check.ts";
import type { RepoSettings } from "./compare.ts";
import { REPO_ROOT } from "./repository.ts";

const CHECK_SCRIPT = path.join(import.meta.dir, "check.ts");
const FIXTURES = path.join(import.meta.dir, "fixtures");
const BASE = "repos/andryorelabs/jobship";
const RULESET_NAMES = ["main", "tags", "develop"];

const temporaryRoots: string[] = [];

/** Copies `.github/rulesets` and `repo-settings.json` into a fresh root that tests may damage. */
function copyRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "repo-settings-"));
  temporaryRoots.push(root);
  mkdirSync(path.join(root, ".github"));
  cpSync(path.join(REPO_ROOT, ".github", "rulesets"), path.join(root, ".github", "rulesets"), {
    recursive: true,
  });
  cpSync(
    path.join(REPO_ROOT, ".github", "repo-settings.json"),
    path.join(root, ".github", "repo-settings.json"),
  );
  return root;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

/** The live payload for `endpoint` when live state matches the files. */
function matchingLive(endpoint: string): string {
  const rulesetIndex = RULESET_NAMES.findIndex(
    (_name, index) => endpoint === `${BASE}/rulesets/${index + 1}`,
  );
  const fixed: Record<string, string> = {
    [BASE]: readFileSync(path.join(FIXTURES, "repo.json"), "utf8"),
    [`${BASE}/vulnerability-alerts`]: "",
    [`${BASE}/private-vulnerability-reporting`]: '{"enabled":true}',
    [`${BASE}/actions/permissions/workflow`]: readFileSync(
      path.join(FIXTURES, "actions-workflow.json"),
      "utf8",
    ),
    [`${BASE}/actions/permissions/fork-pr-contributor-approval`]:
      '{"approval_policy":"first_time_contributors"}',
    [`${BASE}/code-scanning/default-setup`]: '{"state":"not-configured"}',
    [`${BASE}/rulesets`]: JSON.stringify(
      RULESET_NAMES.map((name, index) => ({ id: index + 1, name })),
    ),
  };
  if (rulesetIndex >= 0) {
    const name = RULESET_NAMES[rulesetIndex] ?? "";
    return readFileSync(path.join(REPO_ROOT, ".github", "rulesets", `${name}.json`), "utf8");
  }
  return fixed[endpoint] ?? "{}";
}

/** Dependencies serving the matching live state for `expected`, recording output. */
function harness(expected: RepoSettings): {
  dependencies: CheckDependencies;
  out: string[];
  errors: string[];
} {
  const out: string[] = [];
  const errors: string[] = [];
  return {
    out,
    errors,
    dependencies: {
      callGh: (endpoint) => ({ ok: true, stdout: matchingLive(endpoint), stderr: "" }),
      resolveRepository: () => "andryorelabs/jobship",
      readExpected: () => expected,
      log: (line) => out.push(line),
      logError: (line) => errors.push(line),
    },
  };
}

describe("check.ts", () => {
  test("exits 1 and says unreadable when gh is missing from PATH", () => {
    const result = Bun.spawnSync([process.execPath, CHECK_SCRIPT], {
      env: { PATH: "", HOME: process.env.HOME ?? "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("repo settings unreadable");
  });
});

describe("runCheck", () => {
  test("reports no drift when live matches the files", () => {
    const { dependencies, out } = harness(readExpectedSettings());
    expect(runCheck(dependencies)).toBe(0);
    expect(out).toEqual(["repo settings match the files"]);
  });

  test("reports drift when live merge_commit_title is MERGE_MESSAGE", () => {
    const live = readExpectedSettings();
    const { dependencies, errors } = harness(live);
    dependencies.callGh = (endpoint) => ({
      ok: true,
      stdout:
        endpoint === BASE
          ? JSON.stringify({
              ...JSON.parse(matchingLive(BASE)),
              merge_commit_title: "MERGE_MESSAGE",
            })
          : matchingLive(endpoint),
      stderr: "",
    });
    expect(runCheck(dependencies)).toBe(1);
    expect(errors[0]).toContain("1 difference(s)");
    expect(errors.join("\n")).toContain(
      'repository.merge_commit_title: expected "PR_TITLE", live "MERGE_MESSAGE"',
    );
  });

  test("reports unreadable when a live endpoint fails", () => {
    const { dependencies, errors } = harness(readExpectedSettings());
    dependencies.callGh = () => ({ ok: false, stdout: "", stderr: "HTTP 500" });
    expect(runCheck(dependencies)).toBe(1);
    expect(errors[0]).toContain("repo settings unreadable");
  });
});

describe("readExpectedSettings", () => {
  test("reads the repository settings and every ruleset by name", () => {
    const settings = readExpectedSettings();
    expect(Object.keys(settings.rulesets).toSorted()).toEqual(["develop", "main", "tags"]);
    expect(settings.repository.merge_commit_title).toBe("PR_TITLE");
  });

  test("rejects a ruleset file without a name", () => {
    const root = copyRoot();
    writeFileSync(path.join(root, ".github", "rulesets", "bad.json"), '{"target":"branch"}');
    expect(() => readExpectedSettings(root)).toThrow("bad.json is not a named ruleset");
  });

  test("rejects a ruleset file that is not an object", () => {
    const root = copyRoot();
    writeFileSync(path.join(root, ".github", "rulesets", "bad.json"), "[1]");
    expect(() => readExpectedSettings(root)).toThrow("not a named ruleset");
  });

  test("rejects a settings file missing a setting", () => {
    const root = copyRoot();
    writeFileSync(path.join(root, ".github", "repo-settings.json"), '{"topics":[]}');
    expect(() => readExpectedSettings(root)).toThrow("missing a setting or has the wrong type");
  });
});
