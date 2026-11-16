import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  isCacheStale,
  isNewerVersion,
  parseUpdateCache,
  readCacheFile,
  refreshUpdateCache,
  spawnDetached,
  UPDATE_CHECK_INTERVAL_MS,
  updateCacheFile,
  updateCheckDisabled,
  updateNoticeLine,
  writeCacheFile,
  type UpdateNoticeDeps,
} from "./update-notice.ts";

const NOW = 1_800_000_000_000;

function noticeDeps(overrides: Partial<UpdateNoticeDeps> & { cacheText?: string | null }): {
  deps: UpdateNoticeDeps;
  spawned: { count: number };
} {
  const spawned = { count: 0 };
  const deps: UpdateNoticeDeps = {
    env: { HOME: "/home/test" },
    currentVersion: "0.8.0",
    now: () => NOW,
    readCacheText: () => overrides.cacheText ?? null,
    writeCacheText: () => undefined,
    spawnRefresh: () => {
      spawned.count += 1;
    },
    ...overrides,
  };
  return { deps, spawned };
}

function cacheJson(checkedAt: number, latest: string | null): string {
  return JSON.stringify({ checkedAt, latest });
}

describe("updateCacheFile", () => {
  test("uses JOBSHIP_CACHE_DIR first", () => {
    expect(updateCacheFile({ JOBSHIP_CACHE_DIR: "/c", XDG_CACHE_HOME: "/x" })).toBe(
      "/c/update-check.json",
    );
  });

  test("falls back to XDG_CACHE_HOME then HOME", () => {
    expect(updateCacheFile({ XDG_CACHE_HOME: "/x" })).toBe("/x/jobship/update-check.json");
    expect(updateCacheFile({ HOME: "/h" })).toBe("/h/.cache/jobship/update-check.json");
  });
});

describe("updateCheckDisabled", () => {
  test("JOBSHIP_NO_UPDATE_CHECK=1 disables it", () => {
    expect(updateCheckDisabled({ JOBSHIP_NO_UPDATE_CHECK: "1" })).toBe(true);
  });

  test("CI disables it", () => {
    expect(updateCheckDisabled({ CI: "true" })).toBe(true);
  });

  test("an unset or falsy environment leaves it on", () => {
    expect(updateCheckDisabled({})).toBe(false);
    expect(updateCheckDisabled({ JOBSHIP_NO_UPDATE_CHECK: "0", CI: "0" })).toBe(false);
    expect(updateCheckDisabled({ CI: "false" })).toBe(false);
  });
});

describe("parseUpdateCache", () => {
  test("reads a well-formed cache", () => {
    expect(parseUpdateCache(cacheJson(5, "v1.0.0"))).toEqual({ checkedAt: 5, latest: "v1.0.0" });
    expect(parseUpdateCache(cacheJson(5, null))).toEqual({ checkedAt: 5, latest: null });
  });

  test.each([
    ["missing", null],
    ["not JSON", "{oops"],
    ["not an object", "[1]"],
    ["no timestamp", '{"latest":"v1.0.0"}'],
    ["bad latest", '{"checkedAt":1,"latest":3}'],
  ])("%s is treated as no cache", (_name, text) => {
    expect(parseUpdateCache(text)).toBeNull();
  });
});

describe("isNewerVersion", () => {
  test("compares major, minor and patch numerically", () => {
    expect(isNewerVersion("v0.9.0", "0.8.0")).toBe(true);
    expect(isNewerVersion("0.10.0", "0.9.9")).toBe(true);
    expect(isNewerVersion("1.0.0", "0.99.99")).toBe(true);
    expect(isNewerVersion("0.8.0", "0.8.0")).toBe(false);
    expect(isNewerVersion("0.7.9", "0.8.0")).toBe(false);
  });

  test("an unparseable version is never newer", () => {
    expect(isNewerVersion("latest", "0.8.0")).toBe(false);
    expect(isNewerVersion("0.9.0", "dev")).toBe(false);
  });
});

describe("isCacheStale", () => {
  test("no cache is stale", () => {
    expect(isCacheStale(null, NOW)).toBe(true);
  });

  test("a cache under a day old is fresh", () => {
    expect(isCacheStale({ checkedAt: NOW - 1000, latest: null }, NOW)).toBe(false);
  });

  test("a cache a day old is stale", () => {
    expect(isCacheStale({ checkedAt: NOW - UPDATE_CHECK_INTERVAL_MS, latest: null }, NOW)).toBe(
      true,
    );
  });

  test("a timestamp in the future, from a clock that went backwards, is stale", () => {
    expect(isCacheStale({ checkedAt: NOW + 5000, latest: null }, NOW)).toBe(true);
  });
});

describe("updateNoticeLine", () => {
  test("stamps the check time before starting the refresh, keeping the last known version", () => {
    const written: string[] = [];
    const { deps, spawned } = noticeDeps({
      cacheText: cacheJson(NOW - 2 * UPDATE_CHECK_INTERVAL_MS, "v0.8.5"),
      writeCacheText: (_file, text) => {
        written.push(text);
      },
    });
    updateNoticeLine(deps);
    expect(written).toEqual([cacheJson(NOW, "v0.8.5")]);
    expect(spawned.count).toBe(1);
  });

  test("skips the refresh when the cache cannot be written", () => {
    const { deps, spawned } = noticeDeps({
      writeCacheText: () => {
        throw new Error("read-only cache dir");
      },
    });
    expect(updateNoticeLine(deps)).toBeNull();
    expect(spawned.count).toBe(0);
  });

  test("prints one line when the cached latest is newer", () => {
    const { deps, spawned } = noticeDeps({ cacheText: cacheJson(NOW - 1000, "v0.9.0") });
    const line = updateNoticeLine(deps);
    expect(line).toContain("0.9.0");
    expect(line).toContain("0.8.0");
    expect(line).not.toContain("\n");
    expect(spawned.count).toBe(0);
  });

  test("prints nothing when the cached latest is not newer", () => {
    const { deps } = noticeDeps({ cacheText: cacheJson(NOW - 1000, "v0.8.0") });
    expect(updateNoticeLine(deps)).toBeNull();
  });

  test("a stale cache starts the refresh and still shows a known newer version", () => {
    const { deps, spawned } = noticeDeps({
      cacheText: cacheJson(NOW - 2 * UPDATE_CHECK_INTERVAL_MS, "v0.9.0"),
    });
    expect(updateNoticeLine(deps)).toContain("0.9.0");
    expect(spawned.count).toBe(1);
  });

  test("a corrupt cache starts the refresh and prints nothing", () => {
    const { deps, spawned } = noticeDeps({ cacheText: "{oops" });
    expect(updateNoticeLine(deps)).toBeNull();
    expect(spawned.count).toBe(1);
  });

  test("a backwards clock starts the refresh", () => {
    const { deps, spawned } = noticeDeps({ cacheText: cacheJson(NOW + 9999, "v0.8.0") });
    expect(updateNoticeLine(deps)).toBeNull();
    expect(spawned.count).toBe(1);
  });

  test("JOBSHIP_NO_UPDATE_CHECK=1 spawns nothing and prints nothing", () => {
    const { deps, spawned } = noticeDeps({
      env: { JOBSHIP_NO_UPDATE_CHECK: "1" },
      cacheText: cacheJson(NOW - 1000, "v0.9.0"),
    });
    expect(updateNoticeLine(deps)).toBeNull();
    expect(spawned.count).toBe(0);
  });

  test("CI spawns nothing", () => {
    const { deps, spawned } = noticeDeps({ env: { CI: "true" }, cacheText: null });
    expect(updateNoticeLine(deps)).toBeNull();
    expect(spawned.count).toBe(0);
  });

  test("a development build never checks", () => {
    const { deps, spawned } = noticeDeps({ currentVersion: "0.0.0-dev", cacheText: null });
    expect(updateNoticeLine(deps)).toBeNull();
    expect(spawned.count).toBe(0);
  });
});

function refreshDeps(
  fetchImpl: (url: string, init: { signal: AbortSignal }) => Promise<Response>,
  previous: string | null = null,
): {
  deps: Parameters<typeof refreshUpdateCache>[0];
  written: { file: string; text: string }[];
} {
  const written: { file: string; text: string }[] = [];
  return {
    written,
    deps: {
      env: { JOBSHIP_CACHE_DIR: "/cache" },
      fetchImpl,
      now: () => NOW,
      readCacheText: () => previous,
      writeCacheText: (file, text) => {
        written.push({ file, text });
      },
    },
  };
}

describe("refreshUpdateCache", () => {
  test("returns the result when the cache write fails instead of throwing", async () => {
    const { deps } = refreshDeps(() =>
      Promise.resolve(Response.json({ tag_name: "v0.9.0" }, { status: 200 })),
    );
    const failing = {
      ...deps,
      writeCacheText: () => {
        throw new Error("disk full");
      },
    };
    expect(await refreshUpdateCache(failing)).toEqual({ checkedAt: NOW, latest: "v0.9.0" });
  });

  test("records the latest release tag", async () => {
    const { deps, written } = refreshDeps(() =>
      Promise.resolve(Response.json({ tag_name: "v0.9.0" }, { status: 200 })),
    );
    expect(await refreshUpdateCache(deps)).toEqual({ checkedAt: NOW, latest: "v0.9.0" });
    expect(written).toEqual([{ file: "/cache/update-check.json", text: cacheJson(NOW, "v0.9.0") }]);
  });

  test.each([
    ["an HTTP error", () => Promise.resolve(new Response("no", { status: 500 }))],
    ["a non-object body", () => Promise.resolve(Response.json([1]))],
    ["a body without a tag", () => Promise.resolve(Response.json({ name: "x" }))],
    ["an unparseable tag", () => Promise.resolve(Response.json({ tag_name: "nightly" }))],
    ["a network failure", (): Promise<Response> => Promise.reject(new Error("offline"))],
  ])("%s keeps the previous version and stamps the check time", async (_name, fetchImpl) => {
    const { deps, written } = refreshDeps(fetchImpl, cacheJson(1, "v0.8.5"));
    expect(await refreshUpdateCache(deps)).toEqual({ checkedAt: NOW, latest: "v0.8.5" });
    expect(written).toHaveLength(1);
  });

  test("a failed first check records no version", async () => {
    const { deps } = refreshDeps(() => Promise.resolve(new Response("no", { status: 500 })));
    expect(await refreshUpdateCache(deps)).toEqual({ checkedAt: NOW, latest: null });
  });
});

describe("cache files", () => {
  test("write creates the directory and read returns the text", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "jobship-update-"));
    try {
      const file = path.join(dir, "nested", "update-check.json");
      writeCacheFile(file, "hello");
      expect(readFileSync(file, "utf8")).toBe("hello");
      expect(readCacheFile(file)).toBe("hello");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a missing or unreadable cache reads as null", () => {
    expect(readCacheFile("/nonexistent/update-check.json")).toBeNull();
    expect(readCacheFile(os.tmpdir())).toBeNull();
  });
});

describe("spawnDetached", () => {
  test("ignores an empty command and starts a real one without waiting", () => {
    spawnDetached([]);
    spawnDetached([process.execPath, "-e", ""]);
    spawnDetached(["/nonexistent/jobship-binary"]);
  });
});
