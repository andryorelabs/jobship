import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { readCompanies } from "../companies.ts";
import type { AtsRef } from "../detect.ts";
import { run } from "./command.ts";
import { runDiscover, type FindCandidates } from "./discover.ts";

const NOW = new Date("2026-11-14T00:00:00.000Z");

let root = "";

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "jobship-discover-"));
  writeFileSync(
    path.join(root, "profile.yaml"),
    [
      "regions: [LATAM]",
      "contractTypes: [full-time]",
      "remote: remote-only",
      "stack: { include: [], exclude: [] }",
      "salaryFloor: null",
      "excludedCompanies: []",
      "outreachDailyCap: 5",
      "sources: []",
      "tracker: { kind: local, directory: tracker }",
      "",
    ].join("\n"),
  );
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function cacheEnv(): Record<string, string> {
  return { JOBSHIP_CACHE_DIR: path.join(root, "cache") };
}

function finder(candidates: AtsRef[]): FindCandidates {
  return () => Promise.resolve({ candidates, errors: [] });
}

function greenhouseJobs(title: string | null) {
  const jobs =
    title === null
      ? []
      : [
          {
            id: 1,
            title,
            absolute_url: "https://boards.greenhouse.io/x/jobs/1",
            location: { name: "Remote" },
            content: "Work with typescript",
          },
        ];
  return new Response(JSON.stringify({ jobs }), {
    headers: { "content-type": "application/json" },
  });
}

function fakeFetch(titles: Record<string, string | null>, seen: string[] = []) {
  return (input: string): Promise<Response> => {
    seen.push(input);
    const slug = /boards\/([^/]+)\/jobs/.exec(input)?.[1] ?? "";
    return Promise.resolve(greenhouseJobs(titles[slug] ?? null));
  };
}

function writeCompanies(companies: unknown[]): void {
  writeFileSync(path.join(root, "companies.json"), JSON.stringify({ companies }));
}

function explodingFetch(): Promise<Response> {
  const response = new Response("{}");
  Object.defineProperty(response, "ok", {
    get(): boolean {
      throw new Error("response exploded");
    },
  });
  return Promise.resolve(response);
}

function emptyCandidateDeps() {
  return {
    findCandidates: finder([{ ats: "greenhouse", slug: "empty" }]),
    fetch: fakeFetch({ empty: null }),
    now: NOW,
    env: cacheEnv(),
  };
}

describe("runDiscover", () => {
  test("saves only the candidate with a passing Posting as discovered", async () => {
    const result = await runDiscover(
      { path: root },
      {
        findCandidates: finder([
          { ats: "greenhouse", slug: "good" },
          { ats: "greenhouse", slug: "empty" },
        ]),
        fetch: fakeFetch({ good: "Backend Engineer", empty: null }),
        now: NOW,
        env: cacheEnv(),
      },
    );
    expect(result).toEqual({
      ok: true,
      value: { candidates: 2, checked: 2, kept: 1, removed: 0, errors: [] },
    });
    const saved = readCompanies({ path: root });
    expect(saved).toEqual({
      ok: true,
      value: [
        { ats: "greenhouse", slug: "good", origin: "discovered", checkedAt: NOW.toISOString() },
      ],
    });
  });

  test("respects the limit and the keyword", async () => {
    const seen: string[] = [];
    const result = await runDiscover(
      { path: root },
      {
        findCandidates: finder([
          { ats: "greenhouse", slug: "a" },
          { ats: "greenhouse", slug: "b" },
        ]),
        fetch: fakeFetch({ a: "Designer", b: "Designer" }, seen),
        now: NOW,
        env: cacheEnv(),
      },
      { limit: 1, keyword: "rust" },
    );
    expect(result.ok && result.value.checked).toBe(1);
    expect(result.ok && result.value.kept).toBe(0);
    expect(seen).toHaveLength(1);
  });

  test("skips saved companies and removes stale discovered ones with no passing Posting", async () => {
    writeCompanies([
      { ats: "greenhouse", slug: "manual-one" },
      { ats: "greenhouse", slug: "fresh", origin: "discovered", checkedAt: NOW.toISOString() },
      {
        ats: "greenhouse",
        slug: "stale-gone",
        origin: "discovered",
        checkedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        ats: "greenhouse",
        slug: "stale-ok",
        origin: "discovered",
        checkedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    const seen: string[] = [];
    const result = await runDiscover(
      { path: root },
      {
        findCandidates: finder([{ ats: "greenhouse", slug: "manual-one" }]),
        fetch: fakeFetch({ "stale-ok": "Engineer", "stale-gone": null }, seen),
        now: NOW,
        env: cacheEnv(),
      },
    );
    expect(result).toEqual({
      ok: true,
      value: { candidates: 1, checked: 2, kept: 1, removed: 1, errors: [] },
    });
    expect(seen.toSorted()).toEqual([
      "https://boards-api.greenhouse.io/v1/boards/stale-gone/jobs?content=true",
      "https://boards-api.greenhouse.io/v1/boards/stale-ok/jobs?content=true",
    ]);
    const saved = readCompanies({ path: root });
    expect(saved.ok && saved.value.map((entry) => entry.slug)).toEqual([
      "manual-one",
      "fresh",
      "stale-ok",
    ]);
  });

  test("keeps a company whose check failed and reports the error", async () => {
    writeCompanies([
      { ats: "greenhouse", slug: "flaky", origin: "discovered", checkedAt: "2026-01-01T00:00:00Z" },
    ]);
    const result = await runDiscover(
      { path: root },
      {
        findCandidates: finder([]),
        fetch: () => Promise.resolve(new Response("nope", { status: 500 })),
        now: NOW,
        env: cacheEnv(),
      },
    );
    expect(result.ok && result.value.removed).toBe(0);
    expect(result.ok && result.value.errors).toHaveLength(1);
    const saved = readCompanies({ path: root });
    expect(saved.ok && saved.value).toHaveLength(1);
  });

  test("does not verify a rejected candidate again within 30 days", async () => {
    const candidates = [{ ats: "greenhouse", slug: "empty" }];
    const seen: string[] = [];
    const first = await runDiscover(
      { path: root },
      {
        findCandidates: finder(candidates),
        fetch: fakeFetch({ empty: null }, seen),
        now: NOW,
        env: cacheEnv(),
      },
    );
    expect(first.ok && first.value.checked).toBe(1);
    const soon = new Date(NOW.getTime() + 29 * 86_400_000);
    const second = await runDiscover(
      { path: root },
      {
        findCandidates: finder(candidates),
        fetch: fakeFetch({ empty: null }, seen),
        now: soon,
        env: cacheEnv(),
      },
    );
    expect(second.ok && second.value.checked).toBe(0);
    const later = new Date(NOW.getTime() + 31 * 86_400_000);
    const third = await runDiscover(
      { path: root },
      {
        findCandidates: finder(candidates),
        fetch: fakeFetch({ empty: null }, seen),
        now: later,
        env: cacheEnv(),
      },
    );
    expect(third.ok && third.value.checked).toBe(1);
    expect(seen).toHaveLength(2);
  });

  test("retries a verification answered with 503 before counting it as checked", async () => {
    let calls = 0;
    const flaky = (input: string): Promise<Response> => {
      calls += 1;
      if (calls <= 2) return Promise.resolve(new Response("busy", { status: 503 }));
      return fakeFetch({ good: "Backend Engineer" })(input);
    };
    const delays: number[] = [];
    const result = await runDiscover(
      { path: root },
      {
        findCandidates: finder([{ ats: "greenhouse", slug: "good" }]),
        fetch: flaky,
        now: NOW,
        env: cacheEnv(),
        sleep: (milliseconds) => {
          delays.push(milliseconds);
          return Promise.resolve();
        },
      },
    );
    expect(result.ok && result.value).toMatchObject({ checked: 1, kept: 1, errors: [] });
    expect(calls).toBe(3);
    expect(delays).toEqual([1000, 2000]);
  });

  test("records no rejection from a keyword run and drops rejections when the Profile changes", async () => {
    const candidates = [{ ats: "greenhouse", slug: "good" }];
    const deps = () => ({
      findCandidates: finder(candidates),
      fetch: fakeFetch({ good: "Backend Engineer" }),
      now: NOW,
      env: cacheEnv(),
    });
    const keyword = await runDiscover({ path: root }, deps(), { keyword: "haskell" });
    expect(keyword.ok && keyword.value).toMatchObject({ checked: 1, kept: 0 });
    const plain = await runDiscover({ path: root }, deps());
    expect(plain.ok && plain.value).toMatchObject({ checked: 1, kept: 1 });

    const empty = {
      findCandidates: finder([{ ats: "greenhouse", slug: "empty" }]),
      fetch: fakeFetch({ empty: null }),
      now: NOW,
      env: cacheEnv(),
    };
    const first = await runDiscover({ path: root }, empty);
    expect(first.ok && first.value.checked).toBe(1);
    const repeat = await runDiscover({ path: root }, empty);
    expect(repeat.ok && repeat.value.checked).toBe(0);
    const profilePath = path.join(root, "profile.yaml");
    writeFileSync(
      profilePath,
      readFileSync(profilePath, "utf8").replace("outreachDailyCap: 5", "outreachDailyCap: 6"),
    );
    const changed = await runDiscover({ path: root }, empty);
    expect(changed.ok && changed.value.checked).toBe(1);
  });

  test("never has more than 5 ashby verifications in flight", async () => {
    let inFlight = 0;
    let peak = 0;
    const slow = async (): Promise<Response> => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return new Response(JSON.stringify({ jobs: [] }), {
        headers: { "content-type": "application/json" },
      });
    };
    const candidates = Array.from({ length: 12 }, (_, index) => ({
      ats: "ashby",
      slug: `co-${index}`,
    }));
    const result = await runDiscover(
      { path: root },
      { findCandidates: finder(candidates), fetch: slow, now: NOW, env: cacheEnv() },
    );
    expect(result.ok && result.value.checked).toBe(12);
    expect(peak).toBe(5);
  });

  test("reports a stored company whose ATS has no adapter", async () => {
    writeCompanies([
      { ats: "mystery", slug: "odd", origin: "discovered", checkedAt: "2026-01-01T00:00:00Z" },
    ]);
    const result = await runDiscover(
      { path: root },
      { findCandidates: finder([]), fetch: fakeFetch({}), now: NOW, env: cacheEnv() },
    );
    expect(result.ok && result.value.errors).toEqual(["mystery:odd: unsupported ATS"]);
  });

  test("reports a verification whose fetch throws", async () => {
    const broken = explodingFetch;
    const result = await runDiscover(
      { path: root },
      {
        findCandidates: finder([{ ats: "greenhouse", slug: "boom" }]),
        fetch: broken,
        now: NOW,
        env: cacheEnv(),
      },
    );
    expect(result.ok && result.value.errors).toEqual(["greenhouse:boom: response exploded"]);
  });

  test("ignores a rejected-candidates cache that is not valid JSON or not an object", async () => {
    const deps = emptyCandidateDeps;
    await runDiscover({ path: root }, deps());
    const directory = path.join(root, "cache", "discover");
    const file = path.join(directory, readdirSync(directory)[0] ?? "");
    writeFileSync(file, "{broken");
    const invalid = await runDiscover({ path: root }, deps());
    expect(invalid.ok && invalid.value.errors[0]).toContain("rejected-candidates cache ignored");
    writeFileSync(file, "[]");
    const notObject = await runDiscover({ path: root }, deps());
    expect(notObject.ok && notObject.value.errors).toContain(
      "rejected-candidates cache ignored: not a JSON object",
    );
  });

  test("reports a rejected-candidates cache that cannot be written", async () => {
    const blocker = path.join(root, "blocker");
    writeFileSync(blocker, "file");
    const result = await runDiscover(
      { path: root },
      {
        findCandidates: finder([]),
        fetch: fakeFetch({}),
        now: NOW,
        env: { JOBSHIP_CACHE_DIR: blocker },
      },
    );
    expect(result.ok && result.value.errors[0]).toContain("rejected-candidates cache not written");
  });

  test("fails clearly without a Profile or with a malformed companies file", async () => {
    writeFileSync(path.join(root, "companies.json"), "{not json");
    const malformed = await runDiscover(
      { path: root },
      { findCandidates: finder([]), fetch: fakeFetch({}), now: NOW, env: cacheEnv() },
    );
    expect(malformed.ok ? null : malformed.error.code).toBe("companies-malformed");
    const empty = mkdtempSync(path.join(os.tmpdir(), "jobship-discover-empty-"));
    const missing = await runDiscover(
      { path: empty },
      { findCandidates: finder([]), fetch: fakeFetch({}), now: NOW, env: cacheEnv() },
    );
    rmSync(empty, { recursive: true, force: true });
    expect(missing.ok ? null : missing.error.code).toBe("profile-missing");
  });
});

describe("discover command", () => {
  test("rejects unknown flags and a bad limit", async () => {
    const context = { dataDir: { path: root }, env: {}, cwd: root };
    const unknown = await run(["--bogus", "1"], context);
    const badLimit = await run(["--limit", "0"], context);
    expect(unknown.ok ? null : unknown.error.code).toBe("usage");
    expect(badLimit.ok ? null : badLimit.error.code).toBe("usage");
  });

  test("needs a data directory", async () => {
    const result = await run([], { dataDir: null, env: {}, cwd: root });
    expect(result.ok ? null : result.error.code).toBe("data-dir-not-found");
  });

  test("rejects a flag without a value and a non-numeric limit", async () => {
    const context = { dataDir: { path: root }, env: {}, cwd: root };
    const missing = await run(["--limit"], context);
    const text = await run(["--limit", "ten"], context);
    expect(missing.ok ? null : missing.error.code).toBe("usage");
    expect(text.ok ? null : text.error.code).toBe("usage");
  });

  test("runs discovery with a keyword through the global fetch", async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = Object.assign(
      () => {
        calls += 1;
        return Promise.resolve(new Response("", { status: 404 }));
      },
      { preconnect: () => undefined },
    );
    const result = await run(["--keyword", "typescript", "--limit", "2"], {
      dataDir: { path: root },
      env: cacheEnv(),
      cwd: root,
    });
    globalThis.fetch = originalFetch;
    expect(calls).toBeGreaterThan(0);
    expect(typeof result.ok).toBe("boolean");
  });
});
