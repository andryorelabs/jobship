import { describe, expect, test } from "bun:test";
import path from "node:path";

import { formatCall, planApply, runApply } from "./apply.ts";
import type { ApplyDependencies } from "./apply.ts";
import { readExpectedSettings } from "./check.ts";

const REPOSITORY = "andryorelabs/jobship";
const BASE = `repos/${REPOSITORY}`;

describe("planApply", () => {
  const expected = readExpectedSettings();

  test("creates every ruleset when none exists live", () => {
    const calls = planApply(REPOSITORY, expected, []);
    const posts = calls.filter((call) => call.method === "POST");
    expect(posts.map((call) => call.endpoint)).toEqual([
      `${BASE}/rulesets`,
      `${BASE}/rulesets`,
      `${BASE}/rulesets`,
    ]);
  });

  test("updates a ruleset in place when a live one has its name", () => {
    const calls = planApply(REPOSITORY, expected, [{ id: 7, name: "main" }]);
    expect(calls.map((call) => `${call.method} ${call.endpoint}`)).toContain(
      `PUT ${BASE}/rulesets/7`,
    );
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(2);
  });

  test("turns Dependabot alerts on before the PATCH that sets security updates", () => {
    const calls = planApply(REPOSITORY, expected, []);
    const alerts = calls.findIndex((call) => call.endpoint === `${BASE}/vulnerability-alerts`);
    const patch = calls.findIndex((call) => call.method === "PATCH");
    expect(calls[alerts]?.method).toBe("PUT");
    expect(alerts).toBeLessThan(patch);
  });

  test("uses DELETE when the file turns alerts and private reporting off", () => {
    const off = structuredClone(expected);
    off.repository.dependabot_alerts = false;
    off.repository.private_vulnerability_reporting = false;
    const methods = planApply(REPOSITORY, off, [])
      .filter((call) => call.endpoint.endsWith("-alerts") || call.endpoint.endsWith("-reporting"))
      .map((call) => call.method);
    expect(methods).toEqual(["DELETE", "DELETE"]);
  });

  test("sets topics through PUT topics", () => {
    const topics = planApply(REPOSITORY, expected, []).find(
      (call) => call.endpoint === `${BASE}/topics`,
    );
    expect(topics).toEqual({
      method: "PUT",
      endpoint: `${BASE}/topics`,
      body: { names: expected.repository.topics },
    });
  });

  test("nests the three security features under security_and_analysis", () => {
    const patch = planApply(REPOSITORY, expected, []).find(
      (call) => call.method === "PATCH" && call.endpoint === BASE,
    );
    expect(patch?.endpoint).toBe(BASE);
    expect(patch?.body).toMatchObject({
      allow_squash_merge: true,
      squash_merge_commit_title: "PR_TITLE",
      security_and_analysis: {
        secret_scanning: { status: "enabled" },
        secret_scanning_push_protection: { status: "enabled" },
        dependabot_security_updates: { status: "enabled" },
      },
    });
  });

  test("covers every key the settings file holds", () => {
    const patch = planApply(REPOSITORY, expected, []).find(
      (call) => call.method === "PATCH" && call.endpoint === BASE,
    );
    const sent = JSON.stringify(patch?.body);
    const handledElsewhere = new Set([
      "topics",
      "dependabot_alerts",
      "private_vulnerability_reporting",
      "secret_scanning",
      "secret_scanning_push_protection",
      "dependabot_security_updates",
      "default_workflow_permissions",
      "can_approve_pull_request_reviews",
      "fork_pr_contributor_approval",
      "code_scanning_default_setup",
    ]);
    for (const key of Object.keys(expected.repository)) {
      expect({ key, covered: handledElsewhere.has(key) || sent.includes(`"${key}"`) }).toEqual({
        key,
        covered: true,
      });
    }
  });

  test("sets the Actions token, fork approval and code scanning setup", () => {
    const calls = planApply(REPOSITORY, expected, []);
    expect(calls).toContainEqual({
      method: "PUT",
      endpoint: `${BASE}/actions/permissions/workflow`,
      body: { default_workflow_permissions: "read", can_approve_pull_request_reviews: false },
    });
    expect(calls).toContainEqual({
      method: "PUT",
      endpoint: `${BASE}/actions/permissions/fork-pr-contributor-approval`,
      body: { approval_policy: "first_time_contributors" },
    });
    expect(calls).toContainEqual({
      method: "PATCH",
      endpoint: `${BASE}/code-scanning/default-setup`,
      body: { state: "not-configured" },
    });
  });

  test("sends merge commit titles, description and default branch in the PATCH", () => {
    const patch = planApply(REPOSITORY, expected, []).find(
      (call) => call.method === "PATCH" && call.endpoint === BASE,
    );
    expect(patch?.body).toMatchObject({
      merge_commit_title: "PR_TITLE",
      merge_commit_message: "PR_BODY",
      default_branch: "main",
      description: expected.repository.description,
    });
  });

  test("never plans a call outside the repository", () => {
    for (const call of planApply(REPOSITORY, expected, [{ id: 1, name: "tags" }])) {
      expect(call.endpoint.startsWith(BASE)).toBe(true);
    }
  });

  test("formats a call on one line", () => {
    expect(formatCall({ method: "DELETE", endpoint: `${BASE}/vulnerability-alerts` })).toBe(
      `DELETE ${BASE}/vulnerability-alerts`,
    );
  });
});

describe("runApply", () => {
  const expected = readExpectedSettings();

  /** Dependencies that record every gh call and serve an empty live ruleset list. */
  function harness(overrides: Partial<ApplyDependencies> = {}): {
    dependencies: ApplyDependencies;
    calls: { args: string[]; input: string | undefined }[];
    out: string[];
    errors: string[];
  } {
    const calls: { args: string[]; input: string | undefined }[] = [];
    const out: string[] = [];
    const errors: string[] = [];
    const dependencies: ApplyDependencies = {
      runGh: (args, input) => {
        calls.push({ args, input });
        return { ok: true, stdout: args.length === 2 ? "[]" : "", stderr: "" };
      },
      resolveRepository: () => REPOSITORY,
      packageRepository: () => REPOSITORY,
      readExpected: () => expected,
      log: (line) => out.push(line),
      logError: (line) => errors.push(line),
      ...overrides,
    };
    return { dependencies, calls, out, errors };
  }

  test("a dry run prints every call and writes nothing", () => {
    const { dependencies, calls, out } = harness();
    expect(runApply(["--dry-run"], dependencies)).toBe(0);
    expect(out.length).toBeGreaterThan(5);
    expect(calls).toHaveLength(1);
  });

  test("a real run sends each body on stdin", () => {
    const { dependencies, calls } = harness();
    expect(runApply([], dependencies)).toBe(0);
    const writes = calls.slice(1);
    expect(writes.length).toBeGreaterThan(5);
    expect(writes.some((call) => call.input?.includes("PR_TITLE") === true)).toBe(true);
    expect(writes[0]?.args).toEqual(["api", "--method", "PUT", `${BASE}/vulnerability-alerts`]);
  });

  test("fails when a write fails", () => {
    const { dependencies, errors } = harness({
      runGh: (args) =>
        args.includes("--method")
          ? { ok: false, stdout: "", stderr: "HTTP 403" }
          : { ok: true, stdout: "[]", stderr: "" },
    });
    expect(runApply([], dependencies)).toBe(1);
    expect(errors[0]).toContain("HTTP 403");
  });

  test("refuses a repository package.json does not name", () => {
    const { dependencies, calls, errors } = harness({ packageRepository: () => "someone/else" });
    expect(runApply([], dependencies)).toBe(1);
    expect(errors[0]).toContain("refusing to apply");
    expect(calls).toHaveLength(0);
  });

  test("fails when the ruleset list cannot be read or is malformed", () => {
    const failing = harness({ runGh: () => ({ ok: false, stdout: "", stderr: "" }) });
    expect(runApply([], failing.dependencies)).toBe(1);
    expect(failing.errors[0]).toContain("no output");
    const malformed = harness({ runGh: () => ({ ok: true, stdout: '[{"id":"x"}]', stderr: "" }) });
    expect(runApply([], malformed.dependencies)).toBe(1);
    expect(malformed.errors[0]).toContain("did not return a ruleset list");
  });

  test("the script exits 1 without gh on PATH", () => {
    const result = Bun.spawnSync([process.execPath, path.join(import.meta.dir, "apply.ts")], {
      env: { PATH: "", HOME: process.env.HOME ?? "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("apply failed");
  });
});
