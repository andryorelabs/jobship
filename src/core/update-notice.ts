import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { PRODUCT_NAME, settingValue } from "./env.ts";
import { isObject } from "./narrow.ts";

export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const UPDATE_CHECK_COMMAND = "__update-check";
const LATEST_RELEASE_API = "https://api.github.com/repos/andryorelabs/jobship/releases/latest";
const RELEASES_PAGE = "https://github.com/andryorelabs/jobship/releases/latest";

const FETCH_TIMEOUT_MS = 5000;

type Env = Readonly<Record<string, string | undefined>>;

/** What the last release check learned: when it ran and the latest version it saw. */
export interface UpdateCache {
  readonly checkedAt: number;
  readonly latest: string | null;
}

/** The injected edges of the update notice: clock, disk and the detached refresh. */
export interface UpdateNoticeDeps {
  readonly env: Env;
  readonly currentVersion: string;
  readonly now: () => number;
  readonly readCacheText: (file: string) => string | null;
  readonly writeCacheText: (file: string, text: string) => void;
  readonly spawnRefresh: () => void;
}

/** The injected edges of the refresh: network, clock and disk. */
export interface RefreshDeps {
  readonly env: Env;
  readonly fetchImpl: (url: string, init: { signal: AbortSignal }) => Promise<Response>;
  readonly now: () => number;
  readonly readCacheText: (file: string) => string | null;
  readonly writeCacheText: (file: string, text: string) => void;
}

/** Where the update check keeps its cache, under the jobship cache dir. */
export function updateCacheFile(env: Env): string {
  const override = settingValue(env, "CACHE_DIR");
  if (override !== undefined) return path.join(override, "update-check.json");
  const xdg = env.XDG_CACHE_HOME;
  const root =
    xdg !== undefined && xdg !== ""
      ? path.join(xdg, PRODUCT_NAME)
      : path.join(env.HOME ?? os.homedir(), ".cache", PRODUCT_NAME);
  return path.join(root, "update-check.json");
}

/** True when the environment opts out of the update check. */
export function updateCheckDisabled(env: Env): boolean {
  const optOut = settingValue(env, "NO_UPDATE_CHECK");
  if (optOut !== undefined && optOut !== "0") return true;
  const ci = env.CI;
  return ci !== undefined && ci !== "" && ci !== "0" && ci !== "false";
}

/** Parses the cache file. A corrupt or malformed cache is `null`, never an error. */
export function parseUpdateCache(text: string | null): UpdateCache | null {
  if (text === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(parsed)) return null;
  const { checkedAt, latest } = parsed;
  if (typeof checkedAt !== "number" || !Number.isFinite(checkedAt)) return null;
  if (latest !== null && typeof latest !== "string") return null;
  return { checkedAt, latest };
}

function versionParts(version: string): number[] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (match === null) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** True when `candidate` is a newer release than `current`. Unparseable versions are never newer. */
export function isNewerVersion(candidate: string, current: string): boolean {
  const next = versionParts(candidate);
  const running = versionParts(current);
  if (next === null || running === null) return false;
  for (const [index, part] of next.entries()) {
    const other = running[index] ?? 0;
    if (part !== other) return part > other;
  }
  return false;
}

/**
 * A cache is stale when it is older than a day, or when its timestamp is in the future
 * because the clock went backwards.
 */
export function isCacheStale(cache: UpdateCache | null, now: number): boolean {
  if (cache === null) return true;
  if (cache.checkedAt > now) return true;
  return now - cache.checkedAt >= UPDATE_CHECK_INTERVAL_MS;
}

/**
 * Returns the one-line update notice for human mode, or `null`. It reads only the cache and,
 * when the cache is stale, stamps the check time and starts the detached refresh; it never
 * touches the network itself. Stamping first keeps the check to once a day even when the
 * refresh dies, and a cache that cannot be written skips the refresh entirely.
 */
export function updateNoticeLine(deps: UpdateNoticeDeps): string | null {
  if (updateCheckDisabled(deps.env)) return null;
  if (versionParts(deps.currentVersion) === null) return null;
  const file = updateCacheFile(deps.env);
  const cache = parseUpdateCache(deps.readCacheText(file));
  if (isCacheStale(cache, deps.now()) && stampCheck(deps, file, cache)) deps.spawnRefresh();
  const latest = cache?.latest ?? null;
  if (latest === null || !isNewerVersion(latest, deps.currentVersion)) return null;
  return `jobship ${latest.replace(/^v/, "")} is available (you have ${deps.currentVersion}): ${RELEASES_PAGE}`;
}

function stampCheck(deps: UpdateNoticeDeps, file: string, cache: UpdateCache | null): boolean {
  const stamp: UpdateCache = { checkedAt: deps.now(), latest: cache?.latest ?? null };
  try {
    deps.writeCacheText(file, JSON.stringify(stamp));
    return true;
  } catch {
    return false;
  }
}

async function fetchLatestTag(deps: RefreshDeps): Promise<string | null> {
  try {
    const response = await deps.fetchImpl(LATEST_RELEASE_API, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    if (!isObject(body)) return null;
    const tag = body.tag_name;
    return typeof tag === "string" && versionParts(tag) !== null ? tag : null;
  } catch {
    return null;
  }
}

/**
 * Asks GitHub for the latest release and records the answer. A failed fetch still stamps the
 * check time and keeps the previous version, so a broken network is retried once a day, not
 * on every run.
 */
export async function refreshUpdateCache(deps: RefreshDeps): Promise<UpdateCache> {
  const file = updateCacheFile(deps.env);
  const previous = parseUpdateCache(deps.readCacheText(file));
  const tag = await fetchLatestTag(deps);
  const cache: UpdateCache = { checkedAt: deps.now(), latest: tag ?? previous?.latest ?? null };
  try {
    deps.writeCacheText(file, JSON.stringify(cache));
  } catch {
    return cache;
  }
  return cache;
}

/** Reads a cache file; a missing or unreadable cache is `null`, as if it were corrupt. */
export function readCacheFile(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** Writes a cache file, creating its directory. */
export function writeCacheFile(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

/** Starts `command` detached with no stdio so the CLI can exit without waiting for it. */
export function spawnDetached(command: readonly string[]): void {
  const [program, ...args] = command;
  if (program === undefined) return;
  const child = spawn(program, args, { detached: true, stdio: "ignore" });
  child.on("error", () => undefined);
  child.unref();
}
