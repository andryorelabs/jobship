import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Posting, Profile } from "../core/types.ts";
import { findDuplicate, ledgerRecord, readLedger } from "../ledger/dedup.ts";
import * as events from "../ledger/events.ts";
import { processBatch } from "./pipeline.ts";

const profile: Profile = {
  regions: [],
  contractTypes: [],
  remote: "any",
  stack: { include: [], exclude: [] },
  salaryFloor: null,
  excludedCompanies: [],
  outreachDailyCap: 5,
  sources: [],
  tracker: { kind: "local" },
};

let dir = { path: "" };

beforeEach(() => {
  dir = { path: mkdtempSync(path.join(os.tmpdir(), "jobship-pipeline-")) };
});

afterEach(() => {
  rmSync(dir.path, { recursive: true, force: true });
});

function posting(overrides: Partial<Posting> = {}): Posting {
  return {
    id: "1001",
    source: "greenhouse",
    url: "https://example.test/jobs/1001",
    company: "Acme Inc.",
    title: "Senior Backend Engineer",
    location: "Remote - LATAM",
    ...overrides,
  };
}

describe("processBatch", () => {
  test("reads the ledger and the event log once per batch, not once per Posting", async () => {
    await ledgerRecord(dir, posting({ id: "known" }), "seen");
    const batch = Array.from({ length: 40 }, (_, position) =>
      posting({ id: `p${position}`, title: `Engineer ${position} ${"x".repeat(position)}` }),
    );
    const reads = spyOn(events, "readJsonLines");
    try {
      const outcome = await processBatch(dir, profile, batch);
      expect(outcome.counts.seen).toBe(40);
      expect(reads).toHaveBeenCalledTimes(2);
    } finally {
      reads.mockRestore();
    }
  });

  test("a Posting repeated within one batch is known the second time", async () => {
    const first = posting();
    const repost = posting({ source: "himalayas", id: "h1", url: "https://example.test/h1" });
    const outcome = await processBatch(dir, profile, [first, repost, first]);
    expect(outcome.counts.seen).toBe(3);
    expect(outcome.counts.known).toBe(2);
    expect(outcome.counts.new + outcome.counts.dismissed).toBe(1);
    const outcomes = (await readLedger(dir)).map((entry) => entry.outcome);
    expect(outcomes.slice(1)).toEqual(["duplicate"]);
  });

  test("matches what a fresh findDuplicate sees after the batch", async () => {
    await ledgerRecord(dir, posting({ id: "old", title: "Staff Data Engineer" }), "dismissed");
    const batch = [posting(), posting({ id: "2002", title: "Senior Frontend Engineer" })];
    await processBatch(dir, profile, batch);
    const probes = [
      posting({ source: "himalayas", id: "x", title: "Senior Backend Engineer" }),
      posting({ id: "old", title: "Staff Data Engineer" }),
      posting({ id: "2002" }),
      posting({ source: "remoteok", id: "r", company: "Globex" }),
    ];
    const fresh = await Promise.all(probes.map((probe) => findDuplicate(dir, probe)));
    const rerun = await processBatch(dir, profile, probes);
    expect(fresh.map((match) => match?.matchedBy ?? null)).toEqual([
      "fuzzy",
      "exact",
      "exact",
      null,
    ]);
    expect(fresh[1]?.dismissed).toBe(true);
    expect(rerun.counts.known).toBe(3);
  });
});
