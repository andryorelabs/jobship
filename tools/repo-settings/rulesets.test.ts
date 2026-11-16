import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { readExpectedSettings } from "./check.ts";

const REPO_ROOT = path.join(import.meta.dir, "..", "..");
const RULESETS_DIRECTORY = path.join(REPO_ROOT, ".github", "rulesets");
const WORKFLOWS_DIRECTORY = path.join(REPO_ROOT, ".github", "workflows");

interface Rule {
  type: string;
  parameters?: {
    allowed_merge_methods?: string[];
    required_review_thread_resolution?: boolean;
    strict_required_status_checks_policy?: boolean;
    required_status_checks?: { context: string }[];
  };
}

interface Ruleset {
  name: string;
  target: string;
  enforcement: string;
  conditions: { ref_name: { include: string[] } };
  bypass_actors: unknown[];
  rules: Rule[];
}

/** Whether `value` is a parsed ruleset with rules and conditions. */
function isRuleset(value: unknown): value is Ruleset {
  return (
    typeof value === "object" &&
    value !== null &&
    "rules" in value &&
    Array.isArray(value.rules) &&
    "conditions" in value &&
    "bypass_actors" in value
  );
}

/** Parses `.github/rulesets/<name>.json`, failing when it is not a ruleset. */
function readRuleset(name: string): Ruleset {
  const parsed: unknown = JSON.parse(
    readFileSync(path.join(RULESETS_DIRECTORY, `${name}.json`), "utf8"),
  );
  if (!isRuleset(parsed)) {
    throw new Error(`${name}.json is not a ruleset`);
  }
  return parsed;
}

/** Every job `name:` declared in `.github/workflows`. */
function readJobNames(): Set<string> {
  const names = new Set<string>();
  for (const file of readdirSync(WORKFLOWS_DIRECTORY).filter((entry) => entry.endsWith(".yml"))) {
    const content = readFileSync(path.join(WORKFLOWS_DIRECTORY, file), "utf8");
    for (const match of content.matchAll(/^ {4}name: (.+)$/gm)) {
      names.add((match[1] ?? "").trim().replace(/^["']|["']$/g, ""));
    }
  }
  return names;
}

/** The rule of `type` in `ruleset`, if present. */
function findRule(ruleset: Ruleset, type: string): Rule | undefined {
  return ruleset.rules.find((rule) => rule.type === type);
}

/** Required status check contexts of `ruleset`. */
function requiredContexts(ruleset: Ruleset): string[] {
  const rule = findRule(ruleset, "required_status_checks");
  return (rule?.parameters?.required_status_checks ?? []).map((check) => check.context);
}

describe("rulesets", () => {
  test("every required check context is a job name in .github/workflows", () => {
    const jobNames = readJobNames();
    for (const name of ["main", "develop"]) {
      const contexts = requiredContexts(readRuleset(name));
      expect(contexts).toEqual(["CI passed", "Validate PR title"]);
      expect(contexts.filter((context) => !jobNames.has(context))).toEqual([]);
    }
  });

  test("a required check missing from the workflows is detected", () => {
    const jobNames = readJobNames();
    expect(jobNames.has("No such job")).toBe(false);
  });

  test("main takes merge commits only, signed and without bypass", () => {
    const ruleset = readRuleset("main");
    expect(ruleset.target).toBe("branch");
    expect(ruleset.enforcement).toBe("active");
    expect(ruleset.conditions.ref_name.include).toEqual(["~DEFAULT_BRANCH"]);
    expect(ruleset.bypass_actors).toEqual([]);
    for (const type of ["deletion", "non_fast_forward", "required_signatures"]) {
      expect(findRule(ruleset, type)).toBeDefined();
    }
    expect(findRule(ruleset, "required_linear_history")).toBeUndefined();
    const pullRequest = findRule(ruleset, "pull_request")?.parameters;
    expect(pullRequest?.allowed_merge_methods).toEqual(["merge"]);
    expect(pullRequest?.required_review_thread_resolution).toBe(true);
  });

  test("develop is squash only, signed, linear, up to date and without bypass", () => {
    const ruleset = readRuleset("develop");
    expect(ruleset.target).toBe("branch");
    expect(ruleset.enforcement).toBe("active");
    expect(ruleset.conditions.ref_name.include).toEqual(["refs/heads/develop"]);
    expect(ruleset.bypass_actors).toEqual([]);
    for (const type of [
      "deletion",
      "non_fast_forward",
      "required_linear_history",
      "required_signatures",
    ]) {
      expect(findRule(ruleset, type)).toBeDefined();
    }
    const pullRequest = findRule(ruleset, "pull_request")?.parameters;
    expect(pullRequest?.allowed_merge_methods).toEqual(["squash"]);
    expect(pullRequest?.required_review_thread_resolution).toBe(true);
    expect(
      findRule(ruleset, "required_status_checks")?.parameters?.strict_required_status_checks_policy,
    ).toBe(true);
  });

  test("promotion invariants: rulesets agree with repo-settings.json", () => {
    const settings = readExpectedSettings().repository;
    const developMethods = findRule(readRuleset("develop"), "pull_request")?.parameters
      ?.allowed_merge_methods;
    const mainMethods = findRule(readRuleset("main"), "pull_request")?.parameters
      ?.allowed_merge_methods;
    const allowed = new Set([...(developMethods ?? []), ...(mainMethods ?? [])]);
    expect(settings.allow_squash_merge).toBe(allowed.has("squash"));
    expect(settings.allow_merge_commit).toBe(allowed.has("merge"));
    expect(settings.allow_rebase_merge).toBe(allowed.has("rebase"));
    expect(readRuleset("main").conditions.ref_name.include).toEqual(["~DEFAULT_BRANCH"]);
    expect(settings.default_branch).toBe("main");
    expect([
      settings.squash_merge_commit_title,
      settings.squash_merge_commit_message,
      settings.merge_commit_title,
      settings.merge_commit_message,
    ]).toEqual(["PR_TITLE", "PR_BODY", "PR_TITLE", "PR_BODY"]);
  });

  test("promotion invariants: docs describe the rulesets and the settings file", () => {
    const docs = readFileSync(path.join(REPO_ROOT, "docs", "development.md"), "utf8");
    for (const file of ["develop.json", "main.json", "tags.json", "repo-settings.json"]) {
      expect(docs).toContain(`.github/${file.includes("settings") ? "" : "rulesets/"}${file}`);
    }
    for (const context of requiredContexts(readRuleset("develop"))) {
      expect(docs).toContain(`"${context}"`);
    }
  });

  test("tags protects refs/tags/v* from deletion, update and force push", () => {
    const ruleset = readRuleset("tags");
    expect(ruleset.target).toBe("tag");
    expect(ruleset.enforcement).toBe("active");
    expect(ruleset.conditions.ref_name.include).toEqual(["refs/tags/v*"]);
    expect(ruleset.bypass_actors).toEqual([]);
    for (const type of ["deletion", "update", "non_fast_forward"]) {
      expect(findRule(ruleset, type)).toBeDefined();
    }
  });
});
