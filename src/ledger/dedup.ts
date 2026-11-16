import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

import { withLock } from "../core/fs.ts";
import { isObject } from "../core/narrow.ts";
import type { DataDir, Posting, RejectionReason } from "../core/types.ts";
import { ATS_NAMES } from "../sources/ats.ts";
import { discardUncommittedTail, eventsPath, readJsonLines } from "./events.ts";

const LEDGER_FILE = "ledger.jsonl";
const FUZZY_WINDOW_DAYS = 60;
const TITLE_SIMILARITY = 0.8;
const MS_PER_DAY = 86_400_000;
const CANONICAL_ID_SOURCES: ReadonlySet<string> = new Set(ATS_NAMES);
const NOISE_TOKENS: ReadonlySet<string> = new Set([
  "remote",
  "m",
  "f",
  "d",
  "w",
  "x",
  "the",
  "a",
  "and",
]);
const COMPANY_SUFFIXES: ReadonlySet<string> = new Set([
  "inc",
  "llc",
  "ltd",
  "gmbh",
  "corp",
  "co",
  "sa",
  "bv",
]);
const DISTINGUISHING_TOKENS: ReadonlySet<string> = new Set([
  "junior",
  "jr",
  "senior",
  "sr",
  "staff",
  "lead",
  "principal",
  "head",
  "intern",
  "manager",
  "i",
  "ii",
  "iii",
  "iv",
  "1",
  "2",
  "3",
  "4",
  "5",
  "frontend",
  "backend",
  "fullstack",
  "mobile",
  "ios",
  "android",
  "data",
  "ml",
  "devops",
  "sre",
  "security",
  "qa",
  "platform",
  "infrastructure",
  "design",
  "product",
  "sales",
  "marketing",
]);

export type LedgerOutcome = "seen" | "dismissed" | "duplicate";

export interface LedgerEntry {
  readonly at: string;
  readonly key: string;
  readonly outcome: LedgerOutcome;
  readonly reason?: RejectionReason;
  readonly posting: Posting;
}

export interface DuplicateMatch {
  readonly key: string;
  readonly matchedBy: "exact" | "fuzzy";
  readonly dismissed: boolean;
  readonly source: "ledger" | "events";
}

function tokenize(text: string, ignored: ReadonlySet<string>): string[] {
  return text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter((token) => token !== "" && !ignored.has(token));
}

function normalizeCompany(company: string): string {
  return tokenize(company, COMPANY_SUFFIXES).join(" ");
}

function normalizeTitle(title: string): string[] {
  return tokenize(title, NOISE_TOKENS);
}

function normalizeLocation(location: string | undefined): string {
  return location === undefined ? "" : tokenize(location, NOISE_TOKENS).join(" ");
}

export function dedupKey(posting: Posting): string {
  const source = posting.source.toLowerCase();
  if (CANONICAL_ID_SOURCES.has(source) && posting.id !== "") return `${source}:${posting.id}`;
  const company = normalizeCompany(posting.company);
  const title = normalizeTitle(posting.title).join(" ");
  const location = normalizeLocation(posting.location);
  return `${company}|${title}|${location}`;
}

function titlesMatch(left: string[], right: string[]): boolean {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  const union = new Set([...leftSet, ...rightSet]);
  if (union.size === 0) return false;
  const differing = [...union].filter((token) => !(leftSet.has(token) && rightSet.has(token)));
  if (differing.some((token) => DISTINGUISHING_TOKENS.has(token))) return false;
  return (union.size - differing.length) / union.size >= TITLE_SIMILARITY;
}

function locationsCompatible(left: string, right: string): boolean {
  if (left === "" || right === "") return true;
  const rightTokens = new Set(right.split(" "));
  return left.split(" ").some((token) => rightTokens.has(token));
}

function timestampOf(posting: Posting, fallback: string): number {
  const parsed = Date.parse(posting.postedAt ?? fallback);
  return Number.isNaN(parsed) ? Date.parse(fallback) : parsed;
}

function isFuzzyDuplicate(
  candidate: Posting,
  candidateAt: string,
  incoming: Posting,
  incomingAt: string,
): boolean {
  if (normalizeCompany(candidate.company) !== normalizeCompany(incoming.company)) return false;
  if (!titlesMatch(normalizeTitle(candidate.title), normalizeTitle(incoming.title))) return false;
  if (
    !locationsCompatible(
      normalizeLocation(candidate.location),
      normalizeLocation(incoming.location),
    )
  ) {
    return false;
  }
  const gap = Math.abs(timestampOf(candidate, candidateAt) - timestampOf(incoming, incomingAt));
  return gap <= FUZZY_WINDOW_DAYS * MS_PER_DAY;
}

function isPosting(value: unknown): value is Posting {
  return (
    isObject(value) &&
    typeof value.source === "string" &&
    typeof value.company === "string" &&
    typeof value.title === "string"
  );
}

function isLedgerEntry(value: unknown): value is LedgerEntry {
  return (
    isObject(value) &&
    typeof value.key === "string" &&
    typeof value.at === "string" &&
    (value.outcome === "seen" || value.outcome === "dismissed" || value.outcome === "duplicate") &&
    isPosting(value.posting)
  );
}

function ledgerPath(dir: DataDir): string {
  return path.join(dir.path, LEDGER_FILE);
}

export async function readLedger(dir: DataDir): Promise<LedgerEntry[]> {
  const lines = await withLock(dir.path, () => Promise.resolve(readJsonLines(ledgerPath(dir))));
  return lines.filter(isLedgerEntry);
}

export async function ledgerRecord(
  dir: DataDir,
  posting: Posting,
  outcome: LedgerOutcome,
  reason?: RejectionReason,
): Promise<LedgerEntry> {
  const base = { at: new Date().toISOString(), key: dedupKey(posting), outcome, posting };
  const entry: LedgerEntry = reason === undefined ? base : { ...base, reason };
  await withLock(dir.path, () => {
    mkdirSync(dir.path, { recursive: true });
    discardUncommittedTail(ledgerPath(dir));
    appendFileSync(ledgerPath(dir), `${JSON.stringify(entry)}\n`);
    return Promise.resolve();
  });
  return entry;
}

interface Candidate {
  readonly key: string;
  readonly at: string;
  readonly posting: Posting;
  readonly dismissed: boolean;
  readonly source: "ledger" | "events";
  readonly position: number;
}

interface CompanyBucket {
  readonly ledger: Candidate[];
  readonly events: Candidate[];
}

/** An event read from the event log; only Posting events with a Posting are indexed. */
export interface IndexableEvent {
  readonly kind: string;
  readonly at: string;
  readonly key?: string;
  readonly posting?: unknown;
}

/** The Posting fields dedup reads; dropping the rest keeps descriptions out of the index. */
function dedupFields(posting: Posting): Posting {
  const { id, source, url, company, title, location, postedAt } = posting;
  return {
    id,
    source,
    url,
    company,
    title,
    ...(location === undefined ? {} : { location }),
    ...(postedAt === undefined ? {} : { postedAt }),
  };
}

function ranksBefore(left: Candidate, right: Candidate): boolean {
  if (left.source !== right.source) return left.source === "ledger";
  return left.position < right.position;
}

function toMatch(candidate: Candidate, matchedBy: "exact" | "fuzzy"): DuplicateMatch {
  return {
    key: candidate.key,
    matchedBy,
    dismissed: candidate.dismissed,
    source: candidate.source,
  };
}

/**
 * The ledger and the Posting events, read once and indexed by dedup key and by
 * normalized company. `find` returns what scanning the ledger and then the
 * events in file order would return, so a batch reads the logs once instead of
 * once per Posting.
 */
export class DuplicateIndex {
  private readonly byKey = new Map<string, Candidate>();
  private readonly byCompany = new Map<string, CompanyBucket>();
  private ledgerCount = 0;
  private eventCount = 0;

  addLedgerEntry(entry: LedgerEntry): void {
    this.add({
      key: entry.key,
      at: entry.at,
      posting: entry.posting,
      dismissed: entry.outcome === "dismissed",
      source: "ledger",
      position: this.ledgerCount,
    });
    this.ledgerCount += 1;
  }

  addEvent(event: IndexableEvent): void {
    const { kind, posting } = event;
    if (!isPosting(posting)) return;
    if (kind !== "lead.created" && kind !== "posting.seen" && kind !== "posting.dismissed") return;
    this.add({
      key: event.key ?? dedupKey(posting),
      at: event.at,
      posting,
      dismissed: kind === "posting.dismissed",
      source: "events",
      position: this.eventCount,
    });
    this.eventCount += 1;
  }

  find(posting: Posting): DuplicateMatch | null {
    const exact = this.byKey.get(dedupKey(posting));
    if (exact !== undefined) return toMatch(exact, "exact");
    const bucket = this.byCompany.get(normalizeCompany(posting.company));
    if (bucket === undefined) return null;
    const now = new Date().toISOString();
    const fuzzy = [...bucket.ledger, ...bucket.events].find((candidate) =>
      isFuzzyDuplicate(candidate.posting, candidate.at, posting, now),
    );
    return fuzzy === undefined ? null : toMatch(fuzzy, "fuzzy");
  }

  private add(read: Candidate): void {
    const candidate = { ...read, posting: dedupFields(read.posting) };
    this.keep(candidate.key, candidate);
    this.keep(dedupKey(candidate.posting), candidate);
    const company = normalizeCompany(candidate.posting.company);
    const bucket = this.byCompany.get(company) ?? { ledger: [], events: [] };
    this.byCompany.set(company, bucket);
    if (candidate.source === "ledger") bucket.ledger.push(candidate);
    else bucket.events.push(candidate);
  }

  private keep(key: string, candidate: Candidate): void {
    const current = this.byKey.get(key);
    if (current === undefined || ranksBefore(candidate, current)) this.byKey.set(key, candidate);
  }
}

function toIndexableEvent(raw: unknown): IndexableEvent | null {
  if (!isObject(raw) || typeof raw.kind !== "string" || typeof raw.at !== "string") return null;
  const base = { kind: raw.kind, at: raw.at, posting: raw.posting };
  return typeof raw.key === "string" ? { ...base, key: raw.key } : base;
}

export async function loadDuplicateIndex(dir: DataDir): Promise<DuplicateIndex> {
  const index = new DuplicateIndex();
  for (const entry of await readLedger(dir)) index.addLedgerEntry(entry);
  const raws = await withLock(dir.path, () => Promise.resolve(readJsonLines(eventsPath(dir))));
  for (const raw of raws) {
    const event = toIndexableEvent(raw);
    if (event !== null) index.addEvent(event);
  }
  return index;
}

export async function findDuplicate(
  dir: DataDir,
  posting: Posting,
): Promise<DuplicateMatch | null> {
  return (await loadDuplicateIndex(dir)).find(posting);
}
