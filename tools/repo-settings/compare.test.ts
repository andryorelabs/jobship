import { describe, expect, test } from "bun:test";

import { readExpectedSettings } from "./check.ts";
import { compareSettings, formatDifference, isJsonValue, isRepositorySettings } from "./compare.ts";
import type { JsonValue, RepoSettings } from "./compare.ts";

type JsonObject = Record<string, JsonValue>;

/** Whether `value` is a plain JSON object. */
function isObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A deep copy of the settings kept as code, safe to mutate. */
function freshSettings(): RepoSettings {
  return structuredClone(readExpectedSettings());
}

/** Rewrites the `develop` ruleset of `settings` through `change`. */
function changeDevelop(settings: RepoSettings, change: (main: JsonObject) => JsonObject): void {
  const main = settings.rulesets.develop;
  if (!isObject(main)) {
    throw new Error("missing develop ruleset");
  }
  settings.rulesets.develop = change(main);
}

/** Maps every rule of `main`. */
function mapRules(main: JsonObject, change: (rule: JsonObject) => JsonObject): JsonObject {
  const rules = main.rules;
  if (!Array.isArray(rules)) {
    throw new Error("main has no rules");
  }
  return { ...main, rules: rules.map((rule) => (isObject(rule) ? change(rule) : rule)) };
}

describe("compareSettings", () => {
  test("reports no difference for identical settings", () => {
    expect(compareSettings(freshSettings(), freshSettings())).toEqual([]);
  });

  test("ignores topic order, rule order and volatile ruleset fields", () => {
    const live = freshSettings();
    live.repository.topics.reverse();
    changeDevelop(live, (main) => {
      const rules = main.rules;
      return {
        ...main,
        id: 42,
        source: "andryorelabs/jobship",
        updated_at: "2026-01-01",
        rules: Array.isArray(rules) ? rules.toReversed() : [],
      };
    });
    expect(compareSettings(freshSettings(), live)).toEqual([]);
  });

  test("ignores parameters GitHub adds that the files do not name", () => {
    const live = freshSettings();
    changeDevelop(live, (main) =>
      mapRules(main, (rule) =>
        isObject(rule.parameters)
          ? { ...rule, parameters: { ...rule.parameters, required_reviewers: [] } }
          : rule,
      ),
    );
    expect(compareSettings(freshSettings(), live)).toEqual([]);
  });

  test("reports a drifted repository setting with its path", () => {
    const live = freshSettings();
    live.repository.allow_merge_commit = false;
    expect(compareSettings(freshSettings(), live)).toEqual([
      { path: "repository.allow_merge_commit", expected: true, live: false },
    ]);
  });

  test("reports a changed topic list", () => {
    const live = freshSettings();
    live.repository.topics = ["bun"];
    const paths = compareSettings(freshSettings(), live).map((difference) => difference.path);
    expect(paths).toContain("repository.topics[1]");
  });

  test("reports a changed rule parameter", () => {
    const live = freshSettings();
    changeDevelop(live, (main) =>
      mapRules(main, (rule) =>
        isObject(rule.parameters)
          ? {
              ...rule,
              parameters: { ...rule.parameters, strict_required_status_checks_policy: false },
            }
          : rule,
      ),
    );
    const differences = compareSettings(freshSettings(), live);
    expect(differences.map((difference) => difference.path)).toEqual([
      "rulesets.develop.rules[5].parameters.strict_required_status_checks_policy",
    ]);
  });

  test("reports a dropped rule", () => {
    const live = freshSettings();
    changeDevelop(live, (main) => {
      const rules = main.rules;
      return {
        ...main,
        rules: Array.isArray(rules)
          ? rules.filter((rule) => !isObject(rule) || rule.type !== "required_signatures")
          : [],
      };
    });
    const differences = compareSettings(freshSettings(), live);
    expect(differences.length).toBeGreaterThan(0);
    expect(
      differences.every((difference) => difference.path.startsWith("rulesets.develop.rules")),
    ).toBe(true);
  });

  test("reports a missing and an unexpected ruleset", () => {
    const live = freshSettings();
    delete live.rulesets.tags;
    live.rulesets.extra = { name: "extra" };
    const paths = compareSettings(freshSettings(), live).map((difference) => difference.path);
    expect(paths).toEqual(["rulesets.extra", "rulesets.tags"]);
  });

  test("formats a difference on one line", () => {
    expect(
      formatDifference({ path: "repository.has_wiki", expected: false, live: undefined }),
    ).toBe("repository.has_wiki: expected false, live (missing)");
  });
});

describe("every setting is compared", () => {
  const drifted: Record<string, string | boolean> = {
    description: "other",
    homepage: "https://example.com",
    default_branch: "develop",
    allow_squash_merge: false,
    allow_merge_commit: false,
    allow_rebase_merge: true,
    squash_merge_commit_title: "COMMIT_OR_PR_TITLE",
    squash_merge_commit_message: "COMMIT_MESSAGES",
    merge_commit_title: "MERGE_MESSAGE",
    merge_commit_message: "PR_TITLE",
    delete_branch_on_merge: false,
    allow_auto_merge: false,
    allow_update_branch: false,
    has_wiki: true,
    has_projects: true,
    has_discussions: true,
    secret_scanning: "disabled",
    secret_scanning_push_protection: "disabled",
    dependabot_alerts: false,
    dependabot_security_updates: "disabled",
    private_vulnerability_reporting: false,
    default_workflow_permissions: "write",
    can_approve_pull_request_reviews: true,
    fork_pr_contributor_approval: "all_external_contributors",
    code_scanning_default_setup: "configured",
  };

  test("the table names every key of repo-settings.json", () => {
    const keys = Object.keys(readExpectedSettings().repository).filter((key) => key !== "topics");
    expect(Object.keys(drifted).toSorted()).toEqual(keys.toSorted());
  });

  for (const [key, value] of Object.entries(drifted)) {
    test(`reports drift in ${key}`, () => {
      const live = freshSettings();
      Object.assign(live.repository, { [key]: value });
      expect(compareSettings(freshSettings(), live).map((difference) => difference.path)).toEqual([
        `repository.${key}`,
      ]);
    });
  }

  test("reports live merge_commit_title MERGE_MESSAGE with both values", () => {
    const live = freshSettings();
    live.repository.merge_commit_title = "MERGE_MESSAGE";
    expect(compareSettings(freshSettings(), live)).toEqual([
      { path: "repository.merge_commit_title", expected: "PR_TITLE", live: "MERGE_MESSAGE" },
    ]);
  });
});

describe("isRepositorySettings", () => {
  const valid = readExpectedSettings().repository;

  test("accepts the settings file", () => {
    expect(isRepositorySettings(valid)).toBe(true);
  });

  test("rejects a missing, mistyped or out-of-range setting", () => {
    expect(isRepositorySettings(null)).toBe(false);
    expect(isRepositorySettings({ ...valid, topics: [1] })).toBe(false);
    expect(isRepositorySettings({ ...valid, description: undefined })).toBe(false);
    expect(isRepositorySettings({ ...valid, has_wiki: "no" })).toBe(false);
    expect(isRepositorySettings({ ...valid, secret_scanning: "on" })).toBe(false);
    expect(isRepositorySettings({ ...valid, default_workflow_permissions: "admin" })).toBe(false);
    expect(isRepositorySettings({ ...valid, code_scanning_default_setup: "maybe" })).toBe(false);
  });
});

describe("isJsonValue", () => {
  test("accepts JSON data and rejects anything else", () => {
    expect(isJsonValue({ a: [1, "b", null, true] })).toBe(true);
    expect(isJsonValue([undefined])).toBe(false);
    expect(isJsonValue({ a: () => 1 })).toBe(false);
  });
});
