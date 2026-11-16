import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { PRODUCT_NAME, settingValue } from "../../core/env.ts";
import { errorMessage } from "../../core/narrow.ts";
import type { AtsName } from "../ats.ts";
import { detectAts, type AtsRef } from "../detect.ts";
import {
  field,
  getJsonWithRetry,
  getTextWithRetry,
  identifier,
  records,
  text,
  type FetchFunction,
} from "../http.ts";

type FinderEnv = Readonly<Record<string, string | undefined>>;

export interface FinderOptions {
  readonly fetch: FetchFunction;
  readonly env: FinderEnv;
  readonly now?: Date;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

export interface FinderResult { readonly candidates: AtsRef[]; readonly errors: string[] }

const COLLINFO_URL = "https://index.commoncrawl.org/collinfo.json";
const CDX_PAGE_LIMIT = 20_000;
const CDX_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const HN_STORY_SEARCH =
  "https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&query=%22who%20is%20hiring%22&hitsPerPage=5";

const CDX_HOSTS: readonly { readonly ats: AtsName; readonly host: string }[] = [
  { ats: "greenhouse", host: "boards.greenhouse.io" },
  { ats: "greenhouse", host: "job-boards.greenhouse.io" },
  { ats: "ashby", host: "jobs.ashbyhq.com" },
  { ats: "workable", host: "apply.workable.com" },
  { ats: "smartrecruiters", host: "jobs.smartrecruiters.com" },
];

const NON_BOARD_SLUGS: ReadonlySet<string> = new Set([
  "api",
  "assets",
  "embed",
  "favicon.ico",
  "job",
  "jobs",
  "robots.txt",
  "static",
  "v1",
  "widget",
]);

/** Returns the directory where Discovery keeps its caches. */
export function discoverCacheDirectory(env: FinderEnv): string {
  const override = settingValue(env, "CACHE_DIR");
  if (override !== undefined) return path.join(override, "discover");
  const xdg = env.XDG_CACHE_HOME;
  const root =
    xdg !== undefined && xdg !== "" ? xdg : path.join(env.HOME ?? os.homedir(), ".cache");
  return path.join(root, PRODUCT_NAME, "discover");
}

function boardRef(url: string): AtsRef | null {
  const ref = detectAts(url);
  if (ref === null || NON_BOARD_SLUGS.has(ref.slug.toLowerCase())) return null;
  return ref;
}

function readFreshCache(file: string, now: number): string | undefined {
  try {
    if (!existsSync(file) || now - statSync(file).mtimeMs >= CDX_CACHE_MAX_AGE_MS) return undefined;
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

function writeCache(file: string, body: string): string | undefined {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, body);
    return undefined;
  } catch (error) {
    return `cdx cache not written: ${errorMessage(error)}`;
  }
}

function cdxUrls(body: string): string[] {
  const urls: string[] = [];
  for (const line of body.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const url = text(field(JSON.parse(line), "url"));
      if (url !== undefined) urls.push(url);
    } catch {
      continue;
    }
  }
  return urls;
}

async function latestCdxApi(options: FinderOptions): Promise<string | { error: string }> {
  const outcome = await getJsonWithRetry(options.fetch, COLLINFO_URL, { sleep: options.sleep });
  if (!outcome.ok) return { error: `cdx: ${outcome.error}` };
  const api = text(records(outcome.body)?.[0]?.["cdx-api"]);
  return api ?? { error: "cdx: collinfo.json lists no crawl" };
}

type CdxHost = (typeof CDX_HOSTS)[number];

async function fetchCdxHost(
  options: FinderOptions,
  host: CdxHost,
  api: () => Promise<string | { error: string }>,
  errors: string[],
): Promise<string[]> {
  const file = path.join(discoverCacheDirectory(options.env), `cdx-${host.host}.ndjson`);
  const now = (options.now ?? new Date()).getTime();
  const cached = readFreshCache(file, now);
  if (cached !== undefined) return cdxUrls(cached);
  const endpoint = await api();
  if (typeof endpoint !== "string") {
    if (!errors.includes(endpoint.error)) errors.push(endpoint.error);
    return [];
  }
  const query = `url=${host.host}/*&output=json&fl=url&collapse=urlkey&limit=${CDX_PAGE_LIMIT}`;
  const outcome = await getTextWithRetry(options.fetch, `${endpoint}?${query}`, {
    sleep: options.sleep,
  });
  if (!outcome.ok) {
    errors.push(`cdx ${host.host}: ${outcome.error}`);
    return [];
  }
  const cacheError = writeCache(file, outcome.body);
  if (cacheError !== undefined) errors.push(cacheError);
  return cdxUrls(outcome.body);
}

async function findInCommonCrawl(options: FinderOptions, errors: string[]): Promise<AtsRef[]> {
  let resolved: Promise<string | { error: string }> | undefined;
  const api = (): Promise<string | { error: string }> => (resolved ??= latestCdxApi(options));
  const perHost = await Promise.all(
    CDX_HOSTS.map(async (host) => {
      const urls = await fetchCdxHost(options, host, api, errors);
      return urls
        .map(boardRef)
        .filter((ref): ref is AtsRef => ref !== null && ref.ats === host.ats);
    }),
  );
  return perHost.flat();
}

function decodeEntities(value: string): string {
  return value
    .replace(/&#x2F;/gi, "/")
    .replace(/&#47;/g, "/")
    .replace(/&#x3D;/gi, "=")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

const URL_PATTERN = /https?:\/\/[^\s<>"')]+/gi;

function commentUrls(raw: string): string[] {
  const decoded = decodeEntities(raw);
  return (decoded.match(URL_PATTERN) ?? []).map((url) => url.replace(/[.,;:]+$/, ""));
}

function hnStoryId(body: unknown): string | undefined {
  const story = records(field(body, "hits"))?.find((hit) =>
    /who is hiring/i.test(text(hit.title) ?? ""),
  );
  return story === undefined ? undefined : identifier(story.objectID);
}

async function findInHackerNews(options: FinderOptions, errors: string[]): Promise<AtsRef[]> {
  const stories = await getJsonWithRetry(options.fetch, HN_STORY_SEARCH, { sleep: options.sleep });
  if (!stories.ok) {
    errors.push(`hn: ${stories.error}`);
    return [];
  }
  const storyId = hnStoryId(stories.body);
  if (storyId === undefined) {
    errors.push("hn: no Who is hiring thread found in the response");
    return [];
  }
  const url = `https://hn.algolia.com/api/v1/search?tags=comment,story_${storyId}&hitsPerPage=1000`;
  const comments = await getJsonWithRetry(options.fetch, url, { sleep: options.sleep });
  if (!comments.ok) {
    errors.push(`hn: ${comments.error}`);
    return [];
  }
  const refs: AtsRef[] = [];
  for (const row of records(field(comments.body, "hits")) ?? []) {
    for (const link of commentUrls(text(row.comment_text) ?? "")) {
      const ref = boardRef(link);
      if (ref !== null) refs.push(ref);
    }
  }
  return refs;
}

function dedupe(refs: readonly AtsRef[]): AtsRef[] {
  const seen = new Set<string>();
  const unique: AtsRef[] = [];
  for (const ref of refs) {
    const key = `${ref.ats}:${ref.slug.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(ref);
  }
  return unique;
}

/**
 * Finds candidate ATS boards from the Common Crawl CDX index and the latest HN Who is hiring
 * thread. Issues GETs only. A failing finder adds to `errors` and does not stop the other.
 */
export async function findCandidates(options: FinderOptions): Promise<FinderResult> {
  const errors: string[] = [];
  const crawled = await findInCommonCrawl(options, errors);
  const hiring = await findInHackerNews(options, errors);
  return { candidates: dedupe([...crawled, ...hiring]), errors };
}
