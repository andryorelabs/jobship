import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { withLock, writeAtomic } from "./fs.ts";

let workDir = "";
let lockPath = "";

const LONG_AGO = new Date(Date.now() - 60_000);

beforeEach(() => {
  workDir = mkdtempSync(path.join(os.tmpdir(), "jobship-fs-"));
  lockPath = path.join(workDir, ".jobship.lock");
});

afterEach(() => {
  chmodSync(workDir, 0o700);
  rmSync(workDir, { recursive: true, force: true });
});

describe("writeAtomic failures", () => {
  test("removes the temporary file and rethrows when the rename fails", () => {
    const target = path.join(workDir, "occupied");
    mkdirSync(target);
    writeFileSync(path.join(target, "keep"), "x");
    expect(() => {
      writeAtomic(target, "data");
    }).toThrow();
    expect(readdirSync(workDir)).toEqual(["occupied"]);
  });
});

describe("withLock stale detection", () => {
  test("reclaims an old lock directory that has no holder file", async () => {
    mkdirSync(lockPath);
    writeFileSync(path.join(lockPath, "stray"), "x");
    utimesSync(lockPath, LONG_AGO, LONG_AGO);
    expect(await withLock(workDir, () => Promise.resolve("reclaimed"))).toBe("reclaimed");
  });

  test.each(["not json", "[]", '{"pid":"x","acquiredAt":1}', '{"pid":1}'])(
    "reclaims an old lock whose holder file is %s",
    async (contents) => {
      mkdirSync(lockPath);
      writeFileSync(path.join(lockPath, "holder.json"), contents);
      utimesSync(lockPath, LONG_AGO, LONG_AGO);
      expect(await withLock(workDir, () => Promise.resolve(contents))).toBe(contents);
    },
  );

  test("removes an abandoned reclaim guard and still reclaims the lock", async () => {
    mkdirSync(lockPath);
    writeFileSync(path.join(lockPath, "stray"), "x");
    utimesSync(lockPath, LONG_AGO, LONG_AGO);
    const guard = `${lockPath}.reclaim`;
    mkdirSync(guard);
    utimesSync(guard, LONG_AGO, LONG_AGO);
    expect(await withLock(workDir, () => Promise.resolve("ok"))).toBe("ok");
    expect(existsSync(guard)).toBe(false);
  });

  test("reclaims a lock whose holder process no longer exists", async () => {
    mkdirSync(lockPath);
    writeFileSync(
      path.join(lockPath, "holder.json"),
      JSON.stringify({ pid: 2_147_483_646, acquiredAt: Date.now() }),
    );
    expect(await withLock(workDir, () => Promise.resolve("reclaimed"))).toBe("reclaimed");
  });

  test("times out while a live process holds the lock", async () => {
    mkdirSync(lockPath);
    writeFileSync(
      path.join(lockPath, "holder.json"),
      JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }),
    );
    const outcome = await withLock(workDir, () => Promise.resolve("never"), 100).catch(
      (error: unknown) => error,
    );
    expect(String(outcome)).toContain(`waiting for the lock at ${lockPath}`);
  });
});

describe("withLock error paths", () => {
  test("rethrows an acquisition error that is not lock contention", async () => {
    writeFileSync(lockPath, "a file where the lock directory belongs");
    const outcome = await withLock(workDir, () => Promise.resolve("never")).catch(
      (error: unknown) => error,
    );
    expect(outcome).toBeInstanceOf(Error);
    expect(readdirSync(workDir)).toEqual([".jobship.lock"]);
  });

  test("tolerates a lock that vanished before release", async () => {
    const result = await withLock(workDir, () => {
      rmSync(lockPath, { recursive: true, force: true });
      return Promise.resolve("done");
    });
    expect(result).toBe("done");
  });

  test("rethrows a release error that is not a missing lock", async () => {
    const outcome = await withLock(workDir, () => {
      chmodSync(workDir, 0o500);
      return Promise.resolve("done");
    }).catch((error: unknown) => error);
    expect(outcome).toBeInstanceOf(Error);
  });
});
