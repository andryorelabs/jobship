import { describe, expect, test } from "bun:test";

import {
  checkTag,
  fetchTagFacts,
  readManifestVersion,
  runVerifyTag,
  type FetchLike,
  type TagFacts,
} from "./verify-tag.ts";

const CHANGELOG = "## [Unreleased]\n\n## [1.2.3] - 2026-01-01\n\n- A thing.\n";
const GOOD: TagFacts = { objectType: "tag", verified: true, reason: "valid" };

/** Answers each API path with a canned JSON body, or 404 for unknown paths. */
function fakeFetch(routes: Record<string, unknown>): FetchLike {
  return (url) => {
    const route = Object.entries(routes).find(([suffix]) => url.endsWith(suffix));
    return Promise.resolve(
      route === undefined
        ? new Response("{}", { status: 404 })
        : new Response(JSON.stringify(route[1]), { status: 200 }),
    );
  };
}

/** Awaits a promise that must reject and returns its message. */
async function failureOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "";
}

/** Serves the plugin manifest and changelog the gate reads. */
function readFile(filePath: string): string {
  return filePath.endsWith("plugin.json") ? '{"version":"1.2.3"}' : CHANGELOG;
}

describe("checkTag", () => {
  test("passes a signed annotated tag matching plugin.json with a changelog section", () => {
    expect(
      checkTag({ tag: "v1.2.3", facts: GOOD, pluginVersion: "1.2.3", changelog: CHANGELOG }),
    ).toEqual([]);
  });

  test("rejects a lightweight tag", () => {
    const problems = checkTag({
      tag: "v1.2.3",
      facts: { objectType: "commit", verified: false, reason: "lightweight tag" },
      pluginVersion: "1.2.3",
      changelog: CHANGELOG,
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("not an annotated tag");
  });

  test("rejects an unsigned annotated tag", () => {
    const problems = checkTag({
      tag: "v1.2.3",
      facts: { objectType: "tag", verified: false, reason: "unsigned" },
      pluginVersion: "1.2.3",
      changelog: CHANGELOG,
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("not signed");
  });

  test("rejects a tag that differs from plugin.json and has no changelog section", () => {
    const problems = checkTag({
      tag: "v2.0.0",
      facts: GOOD,
      pluginVersion: "1.2.3",
      changelog: CHANGELOG,
    });
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain("does not match plugin.json");
    expect(problems[1]).toContain("no section for v2.0.0");
  });
});

describe("fetchTagFacts", () => {
  const ref = { object: { type: "tag", sha: "abc" } };

  test("reads the verification of an annotated tag", async () => {
    const facts = await fetchTagFacts(
      fakeFetch({
        "/git/ref/tags/v1.2.3": ref,
        "/git/tags/abc": { verification: { verified: true, reason: "valid" } },
      }),
      "o/r",
      "v1.2.3",
      "t",
    );
    expect(facts).toEqual(GOOD);
  });

  test("reports a lightweight tag without a second call", async () => {
    const facts = await fetchTagFacts(
      fakeFetch({ "/git/ref/tags/v1.2.3": { object: { type: "commit", sha: "abc" } } }),
      "o/r",
      "v1.2.3",
      "t",
    );
    expect(facts.objectType).toBe("commit");
    expect(facts.verified).toBe(false);
  });

  test("fails when the API refuses or answers oddly", async () => {
    expect(await failureOf(fetchTagFacts(fakeFetch({}), "o/r", "v1", "t"))).toContain("404");
    expect(
      await failureOf(fetchTagFacts(fakeFetch({ "/git/ref/tags/v1": null }), "o/r", "v1", "t")),
    ).toContain("unexpected ref");
  });
});

describe("readManifestVersion", () => {
  test("returns the version or fails without one", () => {
    expect(readManifestVersion('{"version":"1.2.3"}')).toBe("1.2.3");
    expect(() => readManifestVersion("{}")).toThrow("no version");
  });
});

describe("runVerifyTag", () => {
  const routes = {
    "/git/ref/tags/v1.2.3": { object: { type: "tag", sha: "abc" } },
    "/git/tags/abc": { verification: { verified: true, reason: "valid" } },
  };

  test("returns 0 for a releasable tag", async () => {
    const errors: string[] = [];
    const code = await runVerifyTag(
      { repository: "o/r", tag: "v1.2.3", token: "t" },
      fakeFetch(routes),
      readFile,
      (text) => errors.push(text),
    );
    expect(code).toBe(0);
    expect(errors).toEqual([]);
  });

  test("returns 1 and prints each problem", async () => {
    const errors: string[] = [];
    const code = await runVerifyTag(
      { repository: "o/r", tag: "v1.2.4", token: "t" },
      fakeFetch({
        "/git/ref/tags/v1.2.4": { object: { type: "commit", sha: "abc" } },
      }),
      readFile,
      (text) => errors.push(text),
    );
    expect(code).toBe(1);
    expect(errors.join("")).toContain("not an annotated tag");
  });

  test("returns 1 when the environment is incomplete or the API fails", async () => {
    const errors: string[] = [];
    const write = (text: string): void => {
      errors.push(text);
    };
    expect(
      await runVerifyTag(
        { repository: undefined, tag: "v1", token: "t" },
        fakeFetch({}),
        readFile,
        write,
      ),
    ).toBe(1);
    expect(
      await runVerifyTag(
        { repository: "o/r", tag: "v1", token: "t" },
        fakeFetch({}),
        readFile,
        write,
      ),
    ).toBe(1);
    expect(errors.join("")).toContain("must be set");
    expect(errors.join("")).toContain("404");
  });
});
