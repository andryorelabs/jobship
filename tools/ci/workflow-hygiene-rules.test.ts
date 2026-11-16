import { describe, expect, test } from "bun:test";

import {
  isNonBlocking,
  jobsWithoutHardenRunner,
  lacksConcurrency,
  lacksManualTrigger,
  lacksPushTo,
  latestBunJobs,
  missingPins,
  parseWorkflow,
  skipsPromotionPullRequest,
  uploadsWithoutFailureGuard,
} from "./workflow-rules.ts";

const HARDEN = "step-security/harden-runner@1d88384fd173af6ecb012dfd0264a306b711241a # v2.22.4";
const UPLOAD = "actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2";
const SETUP_BUN = "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2.2.0";

/** Builds a one-job workflow whose job body is the given indented YAML lines. */
function workflowWithJob(jobLines: readonly string[], head: readonly string[] = []): string {
  return [
    "on:",
    "  pull_request:",
    ...head,
    "jobs:",
    "  build:",
    ...jobLines.map((line) => `    ${line}`),
    "",
  ].join("\n");
}

describe("lacksConcurrency", () => {
  test("flags a workflow without a concurrency group, whatever triggers it", () => {
    expect(lacksConcurrency(parseWorkflow(workflowWithJob(["steps: []"])))).toBe(true);
    expect(lacksConcurrency(parseWorkflow("on:\n  schedule: []\njobs: {}\n"))).toBe(true);
    const emptyGroup = workflowWithJob(
      ["steps: []"],
      ["concurrency:", "  cancel-in-progress: true"],
    );
    expect(lacksConcurrency(parseWorkflow(emptyGroup))).toBe(true);
  });

  test("accepts a group, as a mapping or as a string", () => {
    const mapping = workflowWithJob(
      ["steps: []"],
      ["concurrency:", "  group: ci-${{ github.ref }}"],
    );
    const short = workflowWithJob(["steps: []"], ["concurrency: ci-${{ github.ref }}"]);
    expect(lacksConcurrency(parseWorkflow(mapping))).toBe(false);
    expect(lacksConcurrency(parseWorkflow(short))).toBe(false);
  });

  test("rejects an empty group string", () => {
    expect(lacksConcurrency(parseWorkflow("concurrency: ''\njobs: {}\n"))).toBe(true);
  });
});

describe("lacksManualTrigger", () => {
  test("flags a workflow without workflow_dispatch", () => {
    expect(lacksManualTrigger(parseWorkflow(workflowWithJob(["steps: []"])))).toBe(true);
  });

  test("accepts one that has it", () => {
    const withDispatch = "on:\n  push:\n  workflow_dispatch:\njobs: {}\n";
    expect(lacksManualTrigger(parseWorkflow(withDispatch))).toBe(false);
  });
});

describe("lacksPushTo", () => {
  test("flags a workflow that does not push-trigger on the branch", () => {
    expect(lacksPushTo(parseWorkflow("on:\n  pull_request:\njobs: {}\n"), "develop")).toBe(true);
    expect(lacksPushTo(parseWorkflow("on: [push]\njobs: {}\n"), "develop")).toBe(true);
    const mainOnly = "on:\n  push:\n    branches: [main]\njobs: {}\n";
    expect(lacksPushTo(parseWorkflow(mainOnly), "develop")).toBe(true);
  });

  test("accepts a push trigger that lists the branch", () => {
    const both = "on:\n  push:\n    branches: [main, develop]\njobs: {}\n";
    expect(lacksPushTo(parseWorkflow(both), "develop")).toBe(false);
  });
});

describe("jobsWithoutHardenRunner", () => {
  test("flags a job whose first step is something else", () => {
    const workflow = parseWorkflow(
      workflowWithJob([
        "steps:",
        "  - run: echo hi",
        `  - uses: ${HARDEN}`,
        "    with:",
        "      egress-policy: audit",
      ]),
    );
    expect(jobsWithoutHardenRunner(workflow)).toEqual(["build"]);
  });

  test("flags harden-runner that is not in audit mode", () => {
    const workflow = parseWorkflow(
      workflowWithJob(["steps:", `  - uses: ${HARDEN}`, "    with:", "      egress-policy: block"]),
    );
    expect(jobsWithoutHardenRunner(workflow)).toEqual(["build"]);
  });

  test("accepts harden-runner in audit mode as the first step", () => {
    const workflow = parseWorkflow(
      workflowWithJob(["steps:", `  - uses: ${HARDEN}`, "    with:", "      egress-policy: audit"]),
    );
    expect(jobsWithoutHardenRunner(workflow)).toEqual([]);
  });

  test("ignores reusable-workflow jobs, which have no steps", () => {
    const workflow = parseWorkflow(workflowWithJob(["uses: ./.github/workflows/other.yml"]));
    expect(jobsWithoutHardenRunner(workflow)).toEqual([]);
  });
});

describe("uploadsWithoutFailureGuard", () => {
  test("flags an upload that runs on success too", () => {
    const workflow = parseWorkflow(workflowWithJob(["steps:", `  - uses: ${UPLOAD}`]));
    expect(uploadsWithoutFailureGuard(workflow)).toHaveLength(1);
  });

  test("accepts an upload guarded by if: failure()", () => {
    const workflow = parseWorkflow(
      workflowWithJob(["steps:", `  - uses: ${UPLOAD}`, "    if: failure()"]),
    );
    expect(uploadsWithoutFailureGuard(workflow)).toEqual([]);
  });
});

describe("skipsPromotionPullRequest", () => {
  test("accepts a condition that excludes develop into main", () => {
    const condition =
      "github.event_name == 'pull_request' && !(github.base_ref == 'main' && github.head_ref == 'develop')";
    const job = parseWorkflow(workflowWithJob([`if: ${condition}`])).jobs.build;
    expect(skipsPromotionPullRequest(job)).toBe(true);
  });

  test("rejects a plain pull-request condition and a missing job", () => {
    const job = parseWorkflow(workflowWithJob(["if: github.event_name == 'pull_request'"])).jobs
      .build;
    expect(skipsPromotionPullRequest(job)).toBe(false);
    expect(skipsPromotionPullRequest(undefined)).toBe(false);
  });
});

describe("latestBunJobs and isNonBlocking", () => {
  test("finds a job that installs the latest Bun", () => {
    const workflow = parseWorkflow(
      workflowWithJob([
        "steps:",
        `  - uses: ${SETUP_BUN}`,
        "    with:",
        "      bun-version: latest",
      ]),
    );
    expect(latestBunJobs(workflow)).toEqual(["build"]);
  });

  test("ignores a job on the pinned Bun", () => {
    const workflow = parseWorkflow(
      workflowWithJob([
        "steps:",
        `  - uses: ${SETUP_BUN}`,
        "    with:",
        "      bun-version-file: package.json",
      ]),
    );
    expect(latestBunJobs(workflow)).toEqual([]);
  });

  test("a job is non-blocking only with continue-on-error: true", () => {
    const blocking = parseWorkflow(workflowWithJob(["steps: []"])).jobs.build;
    const lenient = parseWorkflow(workflowWithJob(["continue-on-error: true", "steps: []"])).jobs
      .build;
    expect(isNonBlocking(blocking)).toBe(false);
    expect(isNonBlocking(lenient)).toBe(true);
    expect(isNonBlocking(undefined)).toBe(false);
  });
});

describe("missingPins", () => {
  test("names the pins whose exact text is absent", () => {
    const pins = { actionlint: "ACTIONLINT_VERSION: 1.7.12", zizmor: "version: v1.32.0" };
    expect(missingPins("ACTIONLINT_VERSION: 1.7.12\n", pins)).toEqual(["zizmor"]);
  });
});
