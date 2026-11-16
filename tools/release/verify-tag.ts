import { readFileSync } from "node:fs";
import path from "node:path";

import { extractChangelogSection } from "./changelog-section.ts";

const REPO_ROOT = path.join(import.meta.dir, "..", "..");
const PLUGIN_PATH = path.join(REPO_ROOT, ".claude-plugin", "plugin.json");
const CHANGELOG_PATH = path.join(REPO_ROOT, "CHANGELOG.md");
const API_ROOT = "https://api.github.com";

/** What the GitHub API says about a tag ref. */
export interface TagFacts {
  /** `tag` for an annotated tag object, `commit` for a lightweight tag. */
  objectType: string;
  /** Whether GitHub verified the tag's signature. */
  verified: boolean;
  /** GitHub's reason for the verification result, such as `valid` or `unsigned`. */
  reason: string;
}

/** Everything the release gate compares. */
export interface TagCheckInput {
  tag: string;
  facts: TagFacts;
  pluginVersion: string;
  changelog: string;
}

/** The subset of `fetch` the gate uses, so tests inject a fake instead of reaching the network. */
export type FetchLike = (
  url: string,
  init: { headers: Record<string, string> },
) => Promise<Response>;

/**
 * Returns every reason the tag may not be released: not annotated, not signed, not equal to
 * `v<plugin.json version>`, or without a non-empty CHANGELOG section. An empty list means go.
 */
export function checkTag(input: TagCheckInput): string[] {
  const problems: string[] = [];
  if (input.facts.objectType !== "tag") {
    problems.push(`${input.tag} is not an annotated tag; create it with git tag -s -a`);
  } else if (!input.facts.verified) {
    problems.push(`${input.tag} is not signed with a verified signature (${input.facts.reason})`);
  }
  if (input.tag !== `v${input.pluginVersion}`) {
    problems.push(`${input.tag} does not match plugin.json version v${input.pluginVersion}`);
  }
  try {
    extractChangelogSection(input.changelog, input.tag);
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }
  return problems;
}

/** Reads a JSON object from the GitHub API, failing with the status when the call is refused. */
async function getJson(fetchFn: FetchLike, url: string, token: string): Promise<unknown> {
  const response = await fetchFn(url, {
    headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new Error(`GitHub API ${url} answered ${response.status}`);
  }
  return response.json();
}

/** Narrows a parsed JSON value to a plain object. */
function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new Error(`GitHub API returned an unexpected ${what}`);
  }
  return Object.fromEntries(Object.entries(value));
}

/** Looks up whether the tag is annotated and whether GitHub verified its signature. */
export async function fetchTagFacts(
  fetchFn: FetchLike,
  repository: string,
  tag: string,
  token: string,
): Promise<TagFacts> {
  const ref = asRecord(
    await getJson(fetchFn, `${API_ROOT}/repos/${repository}/git/ref/tags/${tag}`, token),
    "ref",
  );
  const object = asRecord(ref.object, "ref object");
  const objectType = String(object.type);
  if (objectType !== "tag") {
    return { objectType, verified: false, reason: "lightweight tag" };
  }
  const annotated = asRecord(
    await getJson(fetchFn, `${API_ROOT}/repos/${repository}/git/tags/${String(object.sha)}`, token),
    "tag",
  );
  const verification = asRecord(annotated.verification, "verification");
  return {
    objectType,
    verified: verification.verified === true,
    reason: String(verification.reason),
  };
}

/** Reads `version` from the plugin manifest text. */
export function readManifestVersion(manifest: string): string {
  const parsed = asRecord(JSON.parse(manifest), "manifest");
  const version = parsed.version;
  if (typeof version !== "string") {
    throw new Error("plugin.json has no version");
  }
  return version;
}

/** The environment the release workflow provides. */
export interface GateEnvironment {
  repository: string | undefined;
  tag: string | undefined;
  token: string | undefined;
}

/** Runs the gate and returns the exit code, printing each problem to stderr. */
export async function runVerifyTag(
  environment: GateEnvironment,
  fetchFn: FetchLike,
  readFile: (filePath: string) => string,
  stderr: (text: string) => void,
): Promise<number> {
  const { repository, tag, token } = environment;
  if (repository === undefined || tag === undefined || token === undefined) {
    stderr("GITHUB_REPOSITORY, GITHUB_REF_NAME and GITHUB_TOKEN must be set\n");
    return 1;
  }
  try {
    const problems = checkTag({
      tag,
      facts: await fetchTagFacts(fetchFn, repository, tag, token),
      pluginVersion: readManifestVersion(readFile(PLUGIN_PATH)),
      changelog: readFile(CHANGELOG_PATH),
    });
    for (const problem of problems) {
      stderr(`${problem}\n`);
    }
    return problems.length === 0 ? 0 : 1;
  } catch (error) {
    stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await runVerifyTag(
    {
      repository: process.env.GITHUB_REPOSITORY,
      tag: process.env.GITHUB_REF_NAME,
      token: process.env.GITHUB_TOKEN,
    },
    fetch,
    (filePath) => readFileSync(filePath, "utf8"),
    (text) => process.stderr.write(text),
  );
}
