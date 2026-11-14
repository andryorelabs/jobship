import { loadProfile } from "../../core/data-dir.ts";
import { errorMessage } from "../../core/narrow.ts";
import type { DataDir, Posting, Profile, Result, SourceAdapter } from "../../core/types.ts";
import { evaluateGates } from "../../gates/gates.ts";
import { matchesKeywords } from "../adapter.ts";
import { ATS_NAMES, createAtsAdapters } from "../ats.ts";
import { readCompanies, updateCompanies, type SavedCompany } from "../companies.ts";
import type { AtsRef } from "../detect.ts";
import type { FetchFunction } from "../http.ts";

export const DEFAULT_LIMIT = 200;
const RECHECK_DAYS = 30;

const DAY_MS = 86_400_000;
const DEFAULT_CONCURRENCY = 10;
const CONCURRENCY_BY_ATS: Readonly<Record<string, number>> = { ashby: 5 };

export type FindCandidates = (options: {
  readonly fetch: FetchFunction;
  readonly env: Record<string, string | undefined>;
  readonly now?: Date;
}) => Promise<{ candidates: AtsRef[]; errors: string[] }>;

export type DiscoverDeps = {
  readonly findCandidates: FindCandidates;
  readonly fetch: FetchFunction;
  readonly now: Date;
  readonly env?: Record<string, string | undefined>;
};

export type DiscoverOptions = {
  readonly limit?: number;
  readonly keyword?: string;
};

export type DiscoverReport = {
  readonly candidates: number;
  readonly checked: number;
  readonly kept: number;
  readonly removed: number;
  readonly errors: string[];
};

type Verdict = { readonly target: AtsRef; readonly passes: boolean };

function companyKey(company: AtsRef): string {
  return `${company.ats}:${company.slug}`;
}

function isStale(company: SavedCompany, now: Date): boolean {
  if (company.origin !== "discovered") return false;
  if (company.checkedAt === undefined) return true;
  const checked = Date.parse(company.checkedAt);
  return Number.isNaN(checked) || now.getTime() - checked > RECHECK_DAYS * DAY_MS;
}

function groupByAts(targets: readonly AtsRef[]): Map<string, AtsRef[]> {
  const groups = new Map<string, AtsRef[]>();
  for (const target of targets) groups.set(target.ats, [...(groups.get(target.ats) ?? []), target]);
  return groups;
}

function roundRobin(targets: readonly AtsRef[], limit: number): AtsRef[] {
  const lists = [...groupByAts(targets).values()];
  const picked: AtsRef[] = [];
  for (let round = 0; picked.length < limit; round += 1) {
    const layer = lists.map((list) => list[round]).filter((entry) => entry !== undefined);
    if (layer.length === 0) break;
    picked.push(...layer.slice(0, limit - picked.length));
  }
  return picked;
}

function passesGates(profile: Profile, posting: Posting, keyword: string | undefined): boolean {
  if (evaluateGates(profile, posting).dismissed) return false;
  return matchesKeywords(posting, keyword === undefined ? undefined : [keyword]);
}

async function runPool<T>(
  items: readonly T[],
  size: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const drain = async (): Promise<void> => {
    const item = items[next];
    next += 1;
    if (item === undefined) return;
    await work(item);
    await drain();
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, drain));
}

async function verify(
  targets: readonly AtsRef[],
  profile: Profile,
  keyword: string | undefined,
  adapters: ReadonlyMap<string, SourceAdapter>,
  errors: string[],
): Promise<Verdict[]> {
  const verdicts: Verdict[] = [];
  const check = async (target: AtsRef) => {
    const adapter = adapters.get(target.ats);
    if (adapter === undefined) {
      errors.push(`${companyKey(target)}: unsupported ATS`);
      return;
    }
    try {
      const result = await adapter.fetch({ slug: target.slug, company: target.slug });
      if (result.errors.length > 0) {
        errors.push(...result.errors.map((message) => `${companyKey(target)}: ${message}`));
        return;
      }
      const passes = result.postings.some((posting) => passesGates(profile, posting, keyword));
      verdicts.push({ target, passes });
    } catch (error) {
      errors.push(`${companyKey(target)}: ${errorMessage(error)}`);
    }
  };
  await Promise.all(
    [...groupByAts(targets).entries()].map(([ats, list]) =>
      runPool(list, CONCURRENCY_BY_ATS[ats] ?? DEFAULT_CONCURRENCY, check),
    ),
  );
  return verdicts;
}

function applyVerdicts(
  current: readonly SavedCompany[],
  verdicts: readonly Verdict[],
  now: Date,
): SavedCompany[] {
  const byKey = new Map(verdicts.map((verdict) => [companyKey(verdict.target), verdict]));
  const checkedAt = now.toISOString();
  const next: SavedCompany[] = [];
  for (const company of current) {
    const verdict = byKey.get(companyKey(company));
    if (verdict === undefined || company.origin !== "discovered") next.push(company);
    else if (verdict.passes) next.push({ ...company, checkedAt });
  }
  const present = new Set(current.map(companyKey));
  for (const { target, passes } of verdicts) {
    if (passes && !present.has(companyKey(target))) {
      next.push({ ats: target.ats, slug: target.slug, origin: "discovered", checkedAt });
    }
  }
  return next;
}

/**
 * Verifies candidate companies and stale discovered ones against the Profile Gates, saves the
 * passing ones as discovered and drops discovered ones that no longer pass. Manual companies are
 * never touched, and a company whose check errored is left as it was.
 */
export async function runDiscover(
  dir: DataDir,
  deps: DiscoverDeps,
  options: DiscoverOptions = {},
): Promise<Result<DiscoverReport>> {
  const profile = loadProfile(dir);
  if (!profile.ok) return profile;
  const saved = readCompanies(dir);
  if (!saved.ok) return saved;
  const found = await deps.findCandidates({
    fetch: deps.fetch,
    env: deps.env ?? {},
    now: deps.now,
  });
  const errors = [...found.errors];
  const known = new Set(saved.value.map(companyKey));
  const fresh = new Map<string, AtsRef>();
  for (const candidate of found.candidates) {
    const supported = ATS_NAMES.some((name) => name === candidate.ats);
    if (supported && !known.has(companyKey(candidate))) {
      fresh.set(companyKey(candidate), { ats: candidate.ats, slug: candidate.slug });
    }
  }
  const stale = saved.value
    .filter((company) => isStale(company, deps.now))
    .map(({ ats, slug }) => ({ ats, slug }));
  const queue = roundRobin([...stale, ...fresh.values()], options.limit ?? DEFAULT_LIMIT);
  const adapters = new Map(createAtsAdapters(deps.fetch).map((adapter) => [adapter.name, adapter]));
  const verdicts = await verify(queue, profile.value, options.keyword, adapters, errors);
  let removed = 0;
  const updated = await updateCompanies(dir, (current) => {
    const next = applyVerdicts(current, verdicts, deps.now);
    const remaining = new Set(next.map(companyKey));
    removed = current.filter((company) => !remaining.has(companyKey(company))).length;
    return next;
  });
  if (!updated.ok) return updated;
  return {
    ok: true,
    value: {
      candidates: found.candidates.length,
      checked: verdicts.length,
      kept: verdicts.filter((verdict) => verdict.passes).length,
      removed,
      errors,
    },
  };
}
