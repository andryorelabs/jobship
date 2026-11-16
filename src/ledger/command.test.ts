import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { CommandContext } from "../core/commands.ts";
import { run } from "./command.ts";

let dir = { path: "" };

const PROFILE = {
  regions: ["latam"],
  contractTypes: ["full-time"],
  remote: "remote-only",
  stack: { include: [], exclude: [] },
  salaryFloor: null,
  excludedCompanies: [],
  outreachDailyCap: 5,
  sources: [],
  tracker: { kind: "local" },
};

const POSTING = {
  id: "1001",
  source: "greenhouse",
  url: "https://example.test/jobs/1001",
  company: "Acme Inc.",
  title: "Senior Backend Engineer",
};

beforeEach(() => {
  dir = { path: mkdtempSync(path.join(os.tmpdir(), "jobship-ledger-command-")) };
});

afterEach(() => {
  rmSync(dir.path, { recursive: true, force: true });
});

function context(dataDir: { path: string } | null = dir): CommandContext {
  return { dataDir, env: {}, cwd: dir.path };
}

function writeProfile(): void {
  writeFileSync(path.join(dir.path, "profile.yaml"), JSON.stringify(PROFILE));
}

async function appendJson(event: unknown): Promise<Awaited<ReturnType<typeof run>>> {
  return run(["events", "append", "--json", JSON.stringify(event)], context());
}

async function errorCode(argv: string[], ctx: CommandContext = context()): Promise<string> {
  const envelope = await run(argv, ctx);
  if (envelope.ok) throw new Error("expected a failure envelope");
  return envelope.error.code;
}

describe("command dispatch", () => {
  test("fails without a data directory and for unknown commands", async () => {
    expect(await errorCode(["status", "k"], context(null))).toBe("data-dir-not-found");
    expect(await errorCode(["bogus"])).toBe("usage");
    expect(await errorCode([])).toBe("usage");
  });
});

describe("events", () => {
  test("requires a --json payload that parses", async () => {
    expect(await errorCode(["events", "append"])).toBe("usage");
    expect(await errorCode(["events", "append", "--json", "{"])).toBe("usage");
    expect(await errorCode(["events"])).toBe("usage");
  });

  test("accepts every event kind with its required fields", async () => {
    const valid: unknown[] = [
      { kind: "posting.seen", key: "k", posting: POSTING, eligibility: "unknown" },
      { kind: "posting.dismissed", key: "k", posting: POSTING, reason: "closed" },
      { kind: "score.recorded", key: "k", score: 80, reasons: ["fit"], liveness: "live" },
      { kind: "status.changed", key: "k", from: "lead", to: "applied" },
      { kind: "blocker.opened", key: "k", blockerId: "b", scope: "field", detail: "d" },
      { kind: "blocker.resolved", key: "k", blockerId: "b" },
      { kind: "cv.built", key: "k", variant: "v", path: "p", hash: "h" },
      { kind: "email.classified", key: "k", messageId: "m", classification: "rejection" },
      { kind: "outreach.logged", key: "k", channel: "linkedin", recipient: "r" },
      { kind: "note", key: "k", text: "t" },
    ];
    const envelopes = await Promise.all(valid.map((event) => appendJson(event)));
    expect(envelopes.every((envelope) => envelope.ok)).toBe(true);
    const listed = await run(["events", "list"], context());
    expect(listed.ok && listed.data).toMatchObject({ count: valid.length });
  });

  test("rejects events with a bad shape", async () => {
    const invalid: unknown[] = [
      "not an object",
      { kind: "bogus" },
      { kind: "note", key: "k", text: "t", id: "x" },
      { kind: "note", key: "k", text: "t", at: "now" },
      { kind: "note", key: 5, text: "t" },
      { kind: "note", key: "k", text: 5 },
      { kind: "lead.created", key: "k", posting: "p", eligibility: "unknown" },
      { kind: "lead.created", key: "k", posting: POSTING, eligibility: "bogus" },
      { kind: "posting.dismissed", key: "k", posting: POSTING, reason: "bogus" },
      { kind: "score.recorded", key: "k", score: "80", reasons: [], liveness: "live" },
      { kind: "score.recorded", key: "k", score: 80, reasons: "r", liveness: "live" },
      { kind: "score.recorded", key: "k", score: 80, reasons: [1], liveness: "live" },
      { kind: "score.recorded", key: "k", score: 80, reasons: [], liveness: 1 },
      { kind: "status.changed", key: "k", to: "bogus" },
      { kind: "status.changed", key: "k", from: "bogus", to: "applied" },
      { kind: "blocker.opened", key: "k", blockerId: "b" },
      { kind: "blocker.resolved", key: "k" },
      { kind: "cv.built", key: "k", variant: "v" },
      { kind: "email.classified", key: "k", messageId: "m" },
      { kind: "outreach.logged", key: "k", channel: "c" },
      {
        kind: "posting.seen",
        key: "k",
        posting: { id: "1", source: "s", company: "c" },
        eligibility: "unknown",
      },
    ];
    const codes = await Promise.all(
      invalid.map((event) => errorCode(["events", "append", "--json", JSON.stringify(event)])),
    );
    expect(codes.every((code) => code === "usage")).toBe(true);
  });
});

describe("ledger", () => {
  test("lists entries and checks duplicates", async () => {
    await appendJson({ kind: "lead.created", key: "k", posting: POSTING, eligibility: "unknown" });
    const listed = await run(["ledger", "list"], context());
    expect(listed.ok && listed.data).toMatchObject({ count: 0 });
    const check = await run(["ledger", "check", "--json", JSON.stringify(POSTING)], context());
    expect(check.ok && check.data).toMatchObject({ duplicate: true });
  });

  test("validates check input and subcommands", async () => {
    expect(await errorCode(["ledger", "check"])).toBe("usage");
    expect(await errorCode(["ledger", "check", "--json", '{"id":"1"}'])).toBe("usage");
    expect(await errorCode(["ledger"])).toBe("usage");
  });
});

describe("status", () => {
  test("validates arguments", async () => {
    expect(await errorCode(["status"])).toBe("usage");
    expect(await errorCode(["status", "--set"])).toBe("usage");
    expect(await errorCode(["status", "k", "--set"])).toBe("usage");
    expect(await errorCode(["status", "k", "--set", "bogus"])).toBe("usage");
  });

  test("reports unknown keys as not found", async () => {
    expect(await errorCode(["status", "missing"])).toBe("not-found");
    expect(await errorCode(["status", "missing", "--set", "applied"])).toBe("not-found");
  });

  test("sets a status and projects it through the tracker", async () => {
    writeProfile();
    await appendJson({ kind: "lead.created", key: "k", posting: POSTING, eligibility: "unknown" });
    const changed = await run(["status", "k", "--set", "applied"], context());
    expect(changed.ok && changed.data).toEqual({ key: "k", from: "lead", to: "applied" });
    const read = await run(["status", "k"], context());
    expect(read.ok && read.data).toEqual({ key: "k", state: "applied" });
  });

  test("fails when the profile cannot be loaded", async () => {
    await appendJson({ kind: "lead.created", key: "k", posting: POSTING, eligibility: "unknown" });
    const envelope = await run(["status", "k", "--set", "applied"], context());
    expect(envelope.ok).toBe(false);
  });

  test("fails when the tracker projection fails", async () => {
    writeFileSync(
      path.join(dir.path, "profile.yaml"),
      JSON.stringify({ ...PROFILE, tracker: { kind: "linear", teamId: "t" } }),
    );
    await appendJson({ kind: "lead.created", key: "k", posting: POSTING, eligibility: "unknown" });
    const envelope = await run(["status", "k", "--set", "applied"], context());
    expect(envelope.ok).toBe(false);
  });
});
