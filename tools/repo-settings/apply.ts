import { readExpectedSettings } from "./check.ts";
import type { JsonValue, RepoSettings } from "./compare.ts";
import type { GhResult } from "./live.ts";
import {
  assertExpectedRepository,
  readPackageRepository,
  consoleOutput,
  resolveRepository,
  spawnGhApi,
} from "./repository.ts";

export type HttpMethod = "PATCH" | "PUT" | "POST" | "DELETE";

/** One `gh api` call that applies part of the settings. */
export interface ApiCall {
  method: HttpMethod;
  endpoint: string;
  body?: JsonValue;
}

/** A ruleset that exists live, as the ruleset list returns it. */
export interface LiveRulesetRef {
  id: number;
  name: string;
}

/** The repository settings that `PATCH /repos/{o}/{r}` accepts directly. */
function repositoryPatchBody(settings: RepoSettings["repository"]): JsonValue {
  return {
    description: settings.description,
    homepage: settings.homepage,
    default_branch: settings.default_branch,
    allow_squash_merge: settings.allow_squash_merge,
    allow_merge_commit: settings.allow_merge_commit,
    allow_rebase_merge: settings.allow_rebase_merge,
    squash_merge_commit_title: settings.squash_merge_commit_title,
    squash_merge_commit_message: settings.squash_merge_commit_message,
    merge_commit_title: settings.merge_commit_title,
    merge_commit_message: settings.merge_commit_message,
    delete_branch_on_merge: settings.delete_branch_on_merge,
    allow_auto_merge: settings.allow_auto_merge,
    allow_update_branch: settings.allow_update_branch,
    has_wiki: settings.has_wiki,
    has_projects: settings.has_projects,
    has_discussions: settings.has_discussions,
    security_and_analysis: {
      secret_scanning: { status: settings.secret_scanning },
      secret_scanning_push_protection: { status: settings.secret_scanning_push_protection },
      dependabot_security_updates: { status: settings.dependabot_security_updates },
    },
  };
}

/**
 * Plans the calls that make live settings match the files. Dependabot alerts
 * come first because Dependabot security updates, set by the repository PATCH,
 * require them. A ruleset is created when no live ruleset has its name and
 * updated in place when one does.
 */
export function planApply(
  repository: string,
  expected: RepoSettings,
  liveRulesets: LiveRulesetRef[],
): ApiCall[] {
  const base = `repos/${repository}`;
  const settings = expected.repository;
  const calls: ApiCall[] = [
    {
      method: settings.dependabot_alerts ? "PUT" : "DELETE",
      endpoint: `${base}/vulnerability-alerts`,
    },
    {
      method: settings.private_vulnerability_reporting ? "PUT" : "DELETE",
      endpoint: `${base}/private-vulnerability-reporting`,
    },
    {
      method: "PUT",
      endpoint: `${base}/actions/permissions/workflow`,
      body: {
        default_workflow_permissions: settings.default_workflow_permissions,
        can_approve_pull_request_reviews: settings.can_approve_pull_request_reviews,
      },
    },
    {
      method: "PUT",
      endpoint: `${base}/actions/permissions/fork-pr-contributor-approval`,
      body: { approval_policy: settings.fork_pr_contributor_approval },
    },
    {
      method: "PATCH",
      endpoint: `${base}/code-scanning/default-setup`,
      body: { state: settings.code_scanning_default_setup },
    },
    { method: "PUT", endpoint: `${base}/topics`, body: { names: settings.topics } },
    { method: "PATCH", endpoint: base, body: repositoryPatchBody(settings) },
  ];
  for (const [name, ruleset] of Object.entries(expected.rulesets)) {
    const live = liveRulesets.find((candidate) => candidate.name === name);
    calls.push(
      live === undefined
        ? { method: "POST", endpoint: `${base}/rulesets`, body: ruleset }
        : { method: "PUT", endpoint: `${base}/rulesets/${live.id}`, body: ruleset },
    );
  }
  return calls;
}

/** Renders a call as one line for the terminal. */
export function formatCall(call: ApiCall): string {
  const body = call.body === undefined ? "" : ` ${JSON.stringify(call.body)}`;
  return `${call.method} ${call.endpoint}${body}`;
}

/** Whether `value` is a ruleset list entry. */
function isLiveRulesetRef(value: unknown): value is LiveRulesetRef {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "number" &&
    "name" in value &&
    typeof value.name === "string"
  );
}

/** What `runApply` reads and writes through; injected so tests never touch the network. */
export interface ApplyDependencies {
  runGh: (args: string[], input?: string) => GhResult;
  resolveRepository: () => string;
  packageRepository: () => string;
  readExpected: () => RepoSettings;
  log: (line: string) => void;
  logError: (line: string) => void;
}

const defaultDependencies: ApplyDependencies = {
  runGh: spawnGhApi,
  resolveRepository,
  packageRepository: () => readPackageRepository(),
  readExpected: () => readExpectedSettings(),
  ...consoleOutput,
};

/** Reads the live ruleset list; a read, never a write. */
function readLiveRulesets(dependencies: ApplyDependencies, repository: string): LiveRulesetRef[] {
  const endpoint = `repos/${repository}/rulesets`;
  const result = dependencies.runGh(["api", endpoint]);
  if (!result.ok) {
    throw new Error(`gh api ${endpoint} failed: ${result.stderr.trim() || "no output"}`);
  }
  const parsed: unknown = JSON.parse(result.stdout);
  if (!Array.isArray(parsed) || !parsed.every(isLiveRulesetRef)) {
    throw new Error(`gh api ${endpoint} did not return a ruleset list`);
  }
  return parsed;
}

/** Executes one call with `gh api`, sending the body on stdin. */
function executeCall(dependencies: ApplyDependencies, call: ApiCall): void {
  const args = ["api", "--method", call.method, call.endpoint];
  const input = call.body === undefined ? undefined : JSON.stringify(call.body);
  const result =
    input === undefined
      ? dependencies.runGh(args)
      : dependencies.runGh([...args, "--input", "-"], input);
  if (!result.ok) {
    throw new Error(`${call.method} ${call.endpoint} failed: ${result.stderr.trim()}`);
  }
}

/** Plans and, unless `--dry-run`, applies the settings; exit 0 on success, 1 on any failure. */
export function runApply(
  argv: string[],
  dependencies: ApplyDependencies = defaultDependencies,
): number {
  const dryRun = argv.includes("--dry-run");
  try {
    const repository = dependencies.resolveRepository();
    assertExpectedRepository(repository, dependencies.packageRepository());
    const calls = planApply(
      repository,
      dependencies.readExpected(),
      readLiveRulesets(dependencies, repository),
    );
    for (const call of calls) {
      dependencies.log(formatCall(call));
      if (!dryRun) {
        executeCall(dependencies, call);
      }
    }
    return 0;
  } catch (error) {
    dependencies.logError(
      `apply failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
}

if (import.meta.main) {
  process.exit(runApply(process.argv.slice(2)));
}
