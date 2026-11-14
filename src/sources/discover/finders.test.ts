import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FetchFunction } from "../http.ts";
import { findCandidates } from "./finders.ts";

function fixture(name: string): string {
  return readFileSync(path.join(import.meta.dir, "fixtures", name), "utf8");
}

const CDX_FIXTURES: Record<string, string> = {
  "boards.greenhouse.io": "cdx-greenhouse.ndjson",
  "job-boards.greenhouse.io": "cdx-greenhouse.ndjson",
  "jobs.ashbyhq.com": "cdx-ashby.ndjson",
  "apply.workable.com": "cdx-workable.ndjson",
  "jobs.smartrecruiters.com": "cdx-smartrecruiters.ndjson",
};

type Served = { requested: string[]; failures: Map<string, number> };

function serving(served: Served): FetchFunction {
  return (input) => {
    served.requested.push(input);
    const remaining = served.failures.get(input) ?? 0;
    if (remaining > 0) {
      served.failures.set(input, remaining - 1);
      return Promise.resolve(new Response("busy", { status: 503 }));
    }
    if (input.includes("collinfo.json"))
      return Promise.resolve(new Response(fixture("collinfo.json")));
    if (input.startsWith("https://index.example.test/CC-MAIN-2026-40-index")) {
      const host = Object.keys(CDX_FIXTURES).find((name) => input.includes(`url=${name}/*`));
      return Promise.resolve(new Response(fixture(CDX_FIXTURES[host ?? ""] ?? "")));
    }
    if (input.includes("author_whoishiring"))
      return Promise.resolve(new Response(fixture("hn-stories.json")));
    if (input.includes("story_910001"))
      return Promise.resolve(new Response(fixture("hn-comments.json")));
    return Promise.resolve(new Response("not found", { status: 404 }));
  };
}

let cacheDir: string;
let served: Served;
const noSleep = (): Promise<void> => Promise.resolve();

beforeEach(() => {
  cacheDir = mkdtempSync(path.join(os.tmpdir(), "jobship-finders-"));
  served = { requested: [], failures: new Map() };
});

afterEach(() => {
  rmSync(cacheDir, { recursive: true, force: true });
});

function run(now?: Date) {
  return findCandidates({
    fetch: serving(served),
    env: { JOBSHIP_CACHE_DIR: cacheDir },
    sleep: noSleep,
    ...(now === undefined ? {} : { now }),
  });
}

describe("findCandidates", () => {
  test("returns deduplicated slugs from CDX and HN, skipping non-board paths", async () => {
    const result = await run();
    expect(result.errors).toEqual([]);
    const keys = result.candidates.map((ref) => `${ref.ats}:${ref.slug}`).toSorted();
    expect(keys).toEqual([
      "ashby:acme",
      "ashby:plainco",
      "ashby:zeta",
      "greenhouse:acme",
      "greenhouse:gizmo",
      "greenhouse:widgetco",
      "lever:leverco",
      "smartrecruiters:SigmaCorp",
      "workable:omega",
    ]);
  });

  test("queries the latest crawl from collinfo", async () => {
    await run();
    const cdx = served.requested.filter((url) => url.startsWith("https://index.example.test/"));
    expect(cdx.length).toBe(5);
    expect(cdx.every((url) => url.includes("CC-MAIN-2026-40"))).toBe(true);
  });

  test("retries 503 twice then succeeds", async () => {
    served.failures.set("https://index.commoncrawl.org/collinfo.json", 2);
    const result = await run();
    expect(result.errors).toEqual([]);
    expect(result.candidates.length).toBeGreaterThan(0);
  });

  test("reports an error when retries are exhausted and still returns HN candidates", async () => {
    served.failures.set("https://index.commoncrawl.org/collinfo.json", 3);
    const result = await run();
    expect(result.errors.some((message) => message.startsWith("cdx:"))).toBe(true);
    expect(result.candidates.map((ref) => ref.slug)).toContain("leverco");
  });

  test("a second run within 30 days makes no CDX request", async () => {
    await run();
    served.requested.length = 0;
    await run();
    expect(
      served.requested.some((url) => url.includes("collinfo") || url.includes("example.test")),
    ).toBe(false);
  });

  test("refetches CDX after the cache is older than 30 days", async () => {
    await run();
    served.requested.length = 0;
    await run(new Date(Date.now() + 31 * 24 * 60 * 60 * 1000));
    expect(served.requested.some((url) => url.includes("example.test"))).toBe(true);
  });
});
