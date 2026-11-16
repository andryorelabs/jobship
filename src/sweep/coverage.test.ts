import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { CommandContext } from "../core/commands.ts";
import type { Posting, Result, SourceAdapter, TrackerAdapter } from "../core/types.ts";
import { run } from "./command.ts";
import { recordScore } from "./score.ts";
import { ingestPostings, runSweep } from "./sweep.ts";

let root = "";

function makeContext(overrides: Partial<CommandContext> = {}): CommandContext {
  return { dataDir: { path: root }, env: { JOBSHIP_CATALOG_URL: "off" }, cwd: root, ...overrides };
}

function writeProfile(
  sources: string[],
  tracker: Record<string, unknown> = { kind: "local" },
): void {
  writeFileSync(path.join(root, "jobship.json"), '{"version":1}\n');
  writeFileSync(
    path.join(root, "profile.yaml"),
    JSON.stringify({
      regions: ["LATAM"],
      contractTypes: ["full-time"],
      remote: "any",
      stack: { include: [], exclude: [] },
      salaryFloor: null,
      excludedCompanies: [],
      outreachDailyCap: 5,
      sources,
      tracker,
    }),
  );
}

function posting(overrides: Partial<Posting> = {}): Posting {
  return {
    id: "2001",
    source: "himalayas",
    url: "https://example.test/jobs/2001",
    company: "Globex",
    title: "Platform Engineer",
    location: "Worldwide",
    ...overrides,
  };
}

function staticAdapter(name: string, postings: Posting[]): SourceAdapter {
  return { name, fetch: () => Promise.resolve({ postings, errors: [], warnings: [] }) };
}

function boom(): Promise<Result<never>> {
  return Promise.reject(new Error("tracker exploded"));
}

function throwingTracker(): TrackerAdapter {
  return { upsertLead: boom, setStatus: boom, comment: boom, find: boom };
}

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "jobship-sweep-cov-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("runSweep edge cases", () => {
  test("--source naming a Profile source narrows the sweep to it", async () => {
    writeProfile(["himalayas", "hn"]);
    const adapters = { himalayas: staticAdapter("himalayas", [posting()]) };
    const result = await runSweep(makeContext(), { adapters, only: ["himalayas"] });
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.sources.map((report) => report.source)).toEqual(["himalayas"]);
  });

  test("a non-array pending file is treated as empty", async () => {
    writeProfile(["himalayas"]);
    writeFileSync(path.join(root, "pending-projection.json"), '{"not":"a list"}\n');
    const adapters = { himalayas: staticAdapter("himalayas", [posting()]) };
    const result = await runSweep(makeContext(), { adapters });
    expect(result.ok).toBe(true);
  });

  test("a throwing tracker fails the sweep with sweep-failed", async () => {
    writeProfile(["himalayas"]);
    mkdirSync(path.join(root, "pending-projection.json"));
    const adapters = { himalayas: staticAdapter("himalayas", [posting()]) };
    const result = await runSweep(makeContext(), { adapters, tracker: throwingTracker() });
    expect(result).toMatchObject({ ok: false, error: { code: "sweep-failed" } });
  });
});

describe("ingestPostings edge cases", () => {
  test("a throwing tracker fails the ingest with ingest-failed", async () => {
    writeProfile([]);
    mkdirSync(path.join(root, "pending-projection.json"));
    const result = await ingestPostings(makeContext(), [posting()], "manual", {
      tracker: throwingTracker(),
    });
    expect(result).toMatchObject({ ok: false, error: { code: "ingest-failed" } });
  });
});

describe("recordScore edge cases", () => {
  test("fails without a data dir", async () => {
    const result = await recordScore(makeContext({ dataDir: null }), "k", {
      score: 50,
      reasons: [],
    });
    expect(result).toMatchObject({ ok: false, error: { code: "data-dir-not-found" } });
  });

  test("rejects blank reasons", async () => {
    writeProfile([]);
    const result = await recordScore(makeContext(), "k", { score: 50, reasons: [" "] });
    expect(result).toMatchObject({ ok: false, error: { code: "usage" } });
  });

  test("reports a projection failure after the score is recorded", async () => {
    writeProfile([]);
    const ingested = await ingestPostings(makeContext(), [posting()], "manual");
    if (!ingested.ok) throw new Error(ingested.error.message);
    const key = ingested.value.leads[0] ?? "";
    writeProfile([], { kind: "linear", team: "HNT" });
    const result = await recordScore(makeContext({ env: {} }), key, {
      score: 70,
      reasons: ["fits"],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("score recorded but not projected");
  });

  test("a throwing tracker setup is reported as a projection failure", async () => {
    writeProfile([]);
    const ingested = await ingestPostings(makeContext(), [posting()], "manual");
    if (!ingested.ok) throw new Error(ingested.error.message);
    const key = ingested.value.leads[0] ?? "";
    writeProfile([], { kind: "linear", team: "HNT" });
    writeFileSync(path.join(root, "tracker-leads.json"), "{not json");
    const result = await recordScore(
      makeContext({ env: { LINEAR_API_KEY: "lin_synthetic" } }),
      key,
      {
        score: 70,
        reasons: ["fits"],
      },
    );
    expect(result).toMatchObject({ ok: false, error: { code: "tracker-projection-failed" } });
  });
});

describe("recordScore tracker construction failure", () => {
  test("a throw while building the tracker is reported as a projection failure", async () => {
    writeProfile([]);
    const ingested = await ingestPostings(makeContext(), [posting()], "manual");
    if (!ingested.ok) throw new Error(ingested.error.message);
    const key = ingested.value.leads[0] ?? "";
    const env = {
      get LINEAR_API_KEY(): string {
        throw new Error("env unavailable");
      },
    };
    const result = await recordScore(makeContext({ env }), key, { score: 70, reasons: [] });
    expect(result).toMatchObject({ ok: false, error: { code: "tracker-projection-failed" } });
    if (!result.ok) expect(result.error.message).toContain("env unavailable");
  });
});

describe("command parsing edge cases", () => {
  test("an unknown command is a usage failure", async () => {
    expect(await run(["bogus"], makeContext())).toMatchObject({ ok: false });
    expect(await run([], makeContext())).toMatchObject({ ok: false });
  });

  test("postings validation rejects malformed entries", async () => {
    writeProfile([]);
    const bad: unknown[] = [
      "text",
      { id: 1, url: "u" },
      { id: "a", url: "u", company: 1, title: "t" },
      { ...posting(), location: 3 },
      { ...posting(), remote: "yes" },
      { ...posting(), stack: "ts" },
      { ...posting(), stack: [1] },
      { ...posting(), salary: "much" },
      { ...posting(), salary: { min: "x" } },
    ];
    const results = await Promise.all(
      bad.map((entry) =>
        run(["ingest", "--source", "s", "--json", JSON.stringify([entry])], makeContext()),
      ),
    );
    for (const result of results) {
      expect(result).toMatchObject({ ok: false, error: { code: "usage" } });
    }
    const notList = await run(["ingest", "--source", "s", "--json", '"x"'], makeContext());
    expect(notList).toMatchObject({ ok: false, error: { code: "usage" } });
    const badJson = await run(["ingest", "--source", "s", "--json", "{"], makeContext());
    expect(badJson).toMatchObject({ ok: false, error: { code: "usage" } });
  });

  test("valid optional fields and salary are parsed", async () => {
    writeProfile([]);
    const full = {
      ...posting({ source: "" }),
      remote: true,
      stack: ["ts"],
      salary: { min: 1, max: 2, currency: "USD", period: "year" },
      description: "d",
    };
    const ok = await run(
      ["ingest", "--source", "manual", "--json", JSON.stringify({ postings: [full] })],
      makeContext(),
    );
    expect(ok.ok).toBe(true);
    const noValue = await run(["score", "k", "--score"], makeContext());
    expect(noValue).toMatchObject({ ok: false, error: { code: "usage" } });
  });

  test("score reports a failure for an unknown key", async () => {
    writeProfile([]);
    const result = await run(["score", "nope", "--score", "10"], makeContext());
    expect(result).toMatchObject({ ok: false, error: { code: "not-found" } });
  });
});
