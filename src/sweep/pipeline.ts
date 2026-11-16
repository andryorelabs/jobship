import path from "node:path";

import { withLock } from "../core/fs.ts";
import type {
  DataDir,
  Eligibility,
  HuntEvent,
  Posting,
  Profile,
  RejectionReason,
} from "../core/types.ts";
import { evaluateGates } from "../gates/gates.ts";
import {
  dedupKey,
  type DuplicateIndex,
  type LedgerOutcome,
  ledgerRecord,
  loadDuplicateIndex,
} from "../ledger/dedup.ts";
import { appendEvent, type NewEvent } from "../ledger/events.ts";
import type { SourceCounts } from "./types.ts";

export interface BatchOutcome {
  readonly counts: SourceCounts;
  readonly leadKeys: readonly string[];
  readonly events: readonly HuntEvent[];
}

type PostingOutcome =
  | { readonly kind: "known" }
  | { readonly kind: "dismissed"; readonly event: HuntEvent }
  | { readonly kind: "lead"; readonly event: HuntEvent; readonly key: string };

interface BatchContext {
  readonly dir: DataDir;
  readonly profile: Profile;
  readonly index: DuplicateIndex;
}

const LOCK_DIRECTORY = ".pipeline";

export const EMPTY_COUNTS: SourceCounts = { seen: 0, known: 0, new: 0, dismissed: 0 };

const EMPTY_OUTCOME: BatchOutcome = { counts: EMPTY_COUNTS, leadKeys: [], events: [] };

export function addCounts(left: SourceCounts, right: SourceCounts): SourceCounts {
  return {
    seen: left.seen + right.seen,
    known: left.known + right.known,
    new: left.new + right.new,
    dismissed: left.dismissed + right.dismissed,
  };
}

function overallEligibility(values: readonly Eligibility[]): Eligibility {
  return values.every((value) => value === "eligible") ? "eligible" : "unknown";
}

async function record(
  context: BatchContext,
  posting: Posting,
  outcome: LedgerOutcome,
  reason?: RejectionReason,
): Promise<void> {
  context.index.addLedgerEntry(await ledgerRecord(context.dir, posting, outcome, reason));
}

async function append(context: BatchContext, event: NewEvent): Promise<HuntEvent> {
  const stored = await appendEvent(context.dir, event);
  context.index.addEvent(stored);
  return stored;
}

async function processPosting(context: BatchContext, posting: Posting): Promise<PostingOutcome> {
  const duplicate = context.index.find(posting);
  if (duplicate !== null) {
    if (duplicate.key !== dedupKey(posting)) await record(context, posting, "duplicate");
    return { kind: "known" };
  }
  const key = dedupKey(posting);
  const gates = evaluateGates(context.profile, posting);
  if (gates.dismissed) {
    const reason = gates.reason ?? "other";
    const event = await append(context, { kind: "posting.dismissed", key, posting, reason });
    await record(context, posting, "dismissed", reason);
    return { kind: "dismissed", event };
  }
  const eligibility = overallEligibility(Object.values(gates.eligibility));
  const event = await append(context, { kind: "lead.created", key, posting, eligibility });
  await record(context, posting, "seen");
  return { kind: "lead", event, key };
}

function absorb(accumulated: BatchOutcome, outcome: PostingOutcome): BatchOutcome {
  const seen = { ...accumulated.counts, seen: accumulated.counts.seen + 1 };
  if (outcome.kind === "known") {
    return { ...accumulated, counts: { ...seen, known: seen.known + 1 } };
  }
  if (outcome.kind === "dismissed") {
    return {
      ...accumulated,
      counts: { ...seen, dismissed: seen.dismissed + 1 },
      events: [...accumulated.events, outcome.event],
    };
  }
  return {
    counts: { ...seen, new: seen.new + 1 },
    leadKeys: [...accumulated.leadKeys, outcome.key],
    events: [...accumulated.events, outcome.event],
  };
}

async function processFrom(
  context: BatchContext,
  postings: readonly Posting[],
  position: number,
  accumulated: BatchOutcome,
): Promise<BatchOutcome> {
  const posting = postings[position];
  if (posting === undefined) return accumulated;
  const outcome = await processPosting(context, posting);
  return processFrom(context, postings, position + 1, absorb(accumulated, outcome));
}

async function processEach(
  context: BatchContext,
  batches: readonly (readonly Posting[])[],
  position: number,
  outcomes: readonly BatchOutcome[],
): Promise<BatchOutcome[]> {
  const batch = batches[position];
  if (batch === undefined) return [...outcomes];
  const outcome = await processFrom(context, batch, 0, EMPTY_OUTCOME);
  return processEach(context, batches, position + 1, [...outcomes, outcome]);
}

function withBatchContext<Value>(
  dir: DataDir,
  profile: Profile,
  work: (context: BatchContext) => Promise<Value>,
): Promise<Value> {
  return withLock(path.join(dir.path, LOCK_DIRECTORY), async () =>
    work({ dir, profile, index: await loadDuplicateIndex(dir) }),
  );
}

/** Dedups, gates and records a batch of Postings, reading the ledger and event log once. */
export function processBatch(
  dir: DataDir,
  profile: Profile,
  postings: readonly Posting[],
): Promise<BatchOutcome> {
  return withBatchContext(dir, profile, (context) =>
    processFrom(context, postings, 0, EMPTY_OUTCOME),
  );
}

/**
 * Processes several batches in order under one lock and one read of the ledger
 * and event log, returning one outcome per batch.
 */
export function processBatches(
  dir: DataDir,
  profile: Profile,
  batches: readonly (readonly Posting[])[],
): Promise<BatchOutcome[]> {
  return withBatchContext(dir, profile, (context) => processEach(context, batches, 0, []));
}
