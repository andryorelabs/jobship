import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { CommandContext } from "../core/commands.ts";
import type { Envelope } from "../core/envelope.ts";
import { isObject } from "../core/narrow.ts";
import { run } from "./command.ts";

const REPO_ROOT = path.resolve(import.meta.dir, "../..");
const FIXTURE_ROOT = path.resolve(import.meta.dir, "../../fixtures/dossier/complete");
const PROPOSAL = path.join(REPO_ROOT, "fixtures/dossier/proposal.json");

let dataDir = "";

function context(): CommandContext {
  return { dataDir: { path: dataDir }, env: {}, cwd: dataDir };
}

function errorCode(envelope: Envelope<unknown>): string | undefined {
  return envelope.ok ? undefined : envelope.error.code;
}

beforeEach(() => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), "jobship-dossier-command-"));
  cpSync(path.join(FIXTURE_ROOT, "dossier"), path.join(dataDir, "dossier"), { recursive: true });
  for (const file of ["facts.yaml", "bullets.yaml", "profile.yaml", "never-claim.yaml"]) {
    cpSync(path.join(REPO_ROOT, "templates", file), path.join(dataDir, file));
  }
  writeFileSync(path.join(dataDir, "answers.json"), "[]\n");
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("dossier command", () => {
  test("check lists the sections of the complete fixture", async () => {
    const envelope = await run(["check"], {
      dataDir: { path: FIXTURE_ROOT },
      env: {},
      cwd: FIXTURE_ROOT,
    });
    expect(envelope.ok).toBe(true);
  });

  test("check without a data directory fails", async () => {
    const envelope = await run(["check"], { dataDir: null, env: {}, cwd: FIXTURE_ROOT });
    expect(envelope.ok).toBe(false);
    expect(errorCode(envelope)).toBe("data-dir-not-found");
  });

  test("check reports a broken Dossier with a recovery action", async () => {
    writeFileSync(path.join(dataDir, "dossier", "career.md"), "no front matter\n");
    const envelope = await run(["check"], context());
    expect(envelope.ok).toBe(false);
  });

  test("an unknown subcommand is a usage error", async () => {
    const envelope = await run(["nope"], context());
    expect(errorCode(envelope)).toBe("usage");
  });

  test("derive without --file is a usage error", async () => {
    const envelope = await run(["derive"], context());
    expect(errorCode(envelope)).toBe("usage");
  });

  test("derive with a flag value that is another flag is a usage error", async () => {
    const envelope = await run(["derive", "--file", "--other"], context());
    expect(errorCode(envelope)).toBe("usage");
  });

  test("derive with a missing proposal file is proposal-invalid", async () => {
    const envelope = await run(["derive", "--file", "missing.json"], context());
    expect(errorCode(envelope)).toBe("proposal-invalid");
  });

  test("derive with a non-JSON proposal is proposal-invalid", async () => {
    writeFileSync(path.join(dataDir, "bad.json"), "{not json");
    const envelope = await run(["derive", "--file", "bad.json"], context());
    expect(errorCode(envelope)).toBe("proposal-invalid");
  });

  test("derive with a malformed proposal is proposal-invalid", async () => {
    writeFileSync(path.join(dataDir, "bad.json"), "[]");
    const envelope = await run(["derive", "--file", "bad.json"], context());
    expect(errorCode(envelope)).toBe("proposal-invalid");
  });

  test("derive that fails validation returns the derive error", async () => {
    writeFileSync(
      path.join(dataDir, "unknown-fact.json"),
      JSON.stringify({ bullets: [{ id: "b", text: "t", tags: [], factIds: ["ghost"] }] }),
    );
    const envelope = await run(["derive", "--file", "unknown-fact.json"], context());
    expect(envelope.ok).toBe(false);
  });

  test("derive then apply round-trips a proposal", async () => {
    const derived = await run(["derive", "--file", PROPOSAL], context());
    if (!derived.ok) throw new Error(derived.error.message);
    const { data } = derived;
    if (!isObject(data) || typeof data.batchPath !== "string") throw new Error("no batchPath");
    expect(data.count).toBeGreaterThan(0);
    const applied = await run(["apply", data.batchPath], context());
    expect(applied.ok).toBe(true);
  });

  test("apply without a batch is a usage error", async () => {
    const envelope = await run(["apply"], context());
    expect(errorCode(envelope)).toBe("usage");
  });

  test("apply skips a flag and its value when finding the batch", async () => {
    const envelope = await run(["apply", "--verbose", "x"], context());
    expect(errorCode(envelope)).toBe("usage");
  });

  test("apply of a missing batch returns the apply error", async () => {
    const envelope = await run(["apply", "missing.json"], context());
    expect(errorCode(envelope)).toBe("batch-not-found");
  });

  test("an unexpected throw becomes an internal error", async () => {
    const hostile = {
      dataDir: { path: dataDir },
      env: {},
      get cwd(): string {
        throw new Error("boom");
      },
    };
    const envelope = await run(["derive", "--file", "x.json"], hostile);
    expect(errorCode(envelope)).toBe("internal");
  });
});
