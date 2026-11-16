import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { readExpectedSettings } from "./check.ts";
import { compareSettings } from "./compare.ts";
import { readLiveSettings } from "./live.ts";
import type { GhApi, GhResult } from "./live.ts";

const FIXTURES = path.join(import.meta.dir, "fixtures");
const RULESET_FILES = path.join(import.meta.dir, "..", "..", ".github", "rulesets");
const BASE = "repos/andryorelabs/jobship";

/** Reads a recorded `gh api` payload. */
function fixture(name: string): string {
  return readFileSync(path.join(FIXTURES, name), "utf8");
}

/** A successful call. */
function ok(stdout: string): GhResult {
  return { ok: true, stdout, stderr: "" };
}

/** Wraps a ruleset file the way the live API returns it, with volatile fields added. */
function liveRuleset(id: number, name: string): string {
  const source = readFileSync(path.join(RULESET_FILES, `${name}.json`), "utf8");
  return JSON.stringify({
    ...JSON.parse(source),
    id,
    source_type: "Repository",
    updated_at: "2026-01-01",
  });
}

/** A fake `gh api` serving the recorded fixtures, with per-endpoint overrides. */
function fakeGh(overrides: Record<string, GhResult> = {}): GhApi {
  const responses: Record<string, GhResult> = {
    [BASE]: ok(fixture("repo.json")),
    [`${BASE}/vulnerability-alerts`]: ok(""),
    [`${BASE}/private-vulnerability-reporting`]: ok('{"enabled":true}'),
    [`${BASE}/actions/permissions/workflow`]: ok(fixture("actions-workflow.json")),
    [`${BASE}/actions/permissions/fork-pr-contributor-approval`]: ok(
      fixture("actions-fork-approval.json"),
    ),
    [`${BASE}/code-scanning/default-setup`]: ok(fixture("code-scanning-default-setup.json")),
    [`${BASE}/rulesets`]: ok(
      JSON.stringify([
        { id: 1, name: "main" },
        { id: 2, name: "tags" },
        { id: 3, name: "develop" },
      ]),
    ),
    [`${BASE}/rulesets/1`]: ok(liveRuleset(1, "main")),
    [`${BASE}/rulesets/2`]: ok(liveRuleset(2, "tags")),
    [`${BASE}/rulesets/3`]: ok(liveRuleset(3, "develop")),
    ...overrides,
  };
  return (endpoint) => responses[endpoint] ?? { ok: false, stdout: "", stderr: "HTTP 404" };
}

describe("readLiveSettings", () => {
  test("recorded live state matches the files", () => {
    const live = readLiveSettings(fakeGh(), "andryorelabs/jobship");
    expect(compareSettings(readExpectedSettings(), live)).toEqual([]);
  });

  test("treats a 404 from vulnerability-alerts as Dependabot alerts off", () => {
    const gh = fakeGh({
      [`${BASE}/vulnerability-alerts`]: {
        ok: false,
        stdout: "",
        stderr: "gh: Not Found (HTTP 404)",
      },
    });
    const live = readLiveSettings(gh, "andryorelabs/jobship");
    expect(compareSettings(readExpectedSettings(), live)).toEqual([
      { path: "repository.dependabot_alerts", expected: true, live: false },
    ]);
  });

  test("reads a missing security feature as disabled", () => {
    const live = readLiveSettings(
      fakeGh({ [BASE]: ok(fixture("repo-without-security.json")) }),
      "andryorelabs/jobship",
    );
    expect(live.repository.homepage).toBe("");
    expect(live.repository.secret_scanning).toBe("disabled");
    expect(live.repository.dependabot_security_updates).toBe("disabled");
  });

  test("throws when a call fails for a reason other than 404", () => {
    const gh = fakeGh({
      [`${BASE}/vulnerability-alerts`]: { ok: false, stdout: "", stderr: "HTTP 500" },
    });
    expect(() => readLiveSettings(gh, "andryorelabs/jobship")).toThrow("vulnerability-alerts");
  });

  test("throws when private-vulnerability-reporting answers 403", () => {
    const gh = fakeGh({
      [`${BASE}/private-vulnerability-reporting`]: {
        ok: false,
        stdout: "",
        stderr: "gh: Resource not accessible (HTTP 403)",
      },
    });
    expect(() => readLiveSettings(gh, "andryorelabs/jobship")).toThrow(
      "private-vulnerability-reporting",
    );
  });

  test("throws when the repository payload is not JSON", () => {
    expect(() =>
      readLiveSettings(fakeGh({ [BASE]: ok("not json") }), "andryorelabs/jobship"),
    ).toThrow("did not return JSON");
  });

  test("reads the Actions token, fork approval and code scanning setup", () => {
    const live = readLiveSettings(
      fakeGh({
        [`${BASE}/actions/permissions/workflow`]: ok(
          '{"default_workflow_permissions":"write","can_approve_pull_request_reviews":true}',
        ),
        [`${BASE}/actions/permissions/fork-pr-contributor-approval`]: ok(
          '{"approval_policy":"all_external_contributors"}',
        ),
        [`${BASE}/code-scanning/default-setup`]: ok('{"state":"configured"}'),
      }),
      "andryorelabs/jobship",
    );
    expect(live.repository.default_workflow_permissions).toBe("write");
    expect(live.repository.can_approve_pull_request_reviews).toBe(true);
    expect(live.repository.fork_pr_contributor_approval).toBe("all_external_contributors");
    expect(live.repository.code_scanning_default_setup).toBe("configured");
  });

  test("reads merge commit title, description and default branch", () => {
    const live = readLiveSettings(fakeGh(), "andryorelabs/jobship");
    expect(live.repository.merge_commit_title).toBe("PR_TITLE");
    expect(live.repository.merge_commit_message).toBe("PR_BODY");
    expect(live.repository.default_branch).toBe("main");
    expect(live.repository.description).toBe(readExpectedSettings().repository.description);
  });

  test("treats a 404 from code scanning default setup as not configured", () => {
    const live = readLiveSettings(
      fakeGh({
        [`${BASE}/code-scanning/default-setup`]: {
          ok: false,
          stdout: "",
          stderr: "gh: Not Found (HTTP 404)",
        },
      }),
      "andryorelabs/jobship",
    );
    expect(live.repository.code_scanning_default_setup).toBe("not-configured");
  });

  test("throws when code scanning default setup fails for another reason", () => {
    const gh = fakeGh({
      [`${BASE}/code-scanning/default-setup`]: { ok: false, stdout: "", stderr: "HTTP 500" },
    });
    expect(() => readLiveSettings(gh, "andryorelabs/jobship")).toThrow("default-setup");
  });

  test("throws when the ruleset list is not a list or an entry has no id or name", () => {
    expect(() =>
      readLiveSettings(fakeGh({ [`${BASE}/rulesets`]: ok("{}") }), "andryorelabs/jobship"),
    ).toThrow("did not return a list");
    expect(() =>
      readLiveSettings(fakeGh({ [`${BASE}/rulesets`]: ok('["x"]') }), "andryorelabs/jobship"),
    ).toThrow("without an id");
    expect(() =>
      readLiveSettings(
        fakeGh({ [`${BASE}/rulesets`]: ok('[{"id":9}]'), [`${BASE}/rulesets/9`]: ok("{}") }),
        "andryorelabs/jobship",
      ),
    ).toThrow("has no name");
  });

  test("throws when an endpoint answers a non-object", () => {
    expect(() => readLiveSettings(fakeGh({ [BASE]: ok("[]") }), "andryorelabs/jobship")).toThrow(
      "did not return an object",
    );
  });

  test("reads a write default permission only when the API says write", () => {
    const live = readLiveSettings(
      fakeGh({ [`${BASE}/actions/permissions/workflow`]: ok("{}") }),
      "andryorelabs/jobship",
    );
    expect(live.repository.default_workflow_permissions).toBe("read");
    expect(live.repository.can_approve_pull_request_reviews).toBe(false);
  });
});
