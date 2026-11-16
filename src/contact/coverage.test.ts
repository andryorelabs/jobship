import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { CommandContext } from "../core/commands.ts";
import type { DataDir, Posting } from "../core/types.ts";
import { appendEvent } from "../ledger/events.ts";
import { run } from "./command.ts";
import { parseContacts, pruneContacts, readContacts, recordContacts } from "./store.ts";

const posting: Posting = {
  source: "greenhouse",
  id: "1",
  title: "Engineer",
  company: "Acme",
  url: "https://example.test/1",
};

const base = {
  name: "Ana Ruiz",
  role: "Engineering Manager",
  channel: "linkedin",
  sources: [],
  recentItems: [],
};

const DAY_MS = 86_400_000;

let root: string;
let dir: DataDir;
let ctx: CommandContext;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "contact-cov-"));
  dir = { path: root };
  ctx = { dataDir: dir, env: {}, cwd: root };
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function rejected(value: unknown): string {
  const parsed = parseContacts(value);
  return parsed.ok ? "" : parsed.error.message;
}

async function lead(key: string): Promise<void> {
  await appendEvent(dir, { kind: "lead.created", key, posting, eligibility: "eligible" });
}

function blockedDir(): DataDir {
  const blocked = path.join(root, "blocked");
  writeFileSync(blocked, "x");
  return { path: blocked };
}

describe("parseContacts validation", () => {
  test("rejects every malformed shape", () => {
    expect(rejected({})).toContain("JSON array");
    expect(rejected(["x"])).toContain("must be an object");
    expect(rejected([{ ...base, extra: 1 }])).toContain("unknown field extra");
    expect(rejected([{ ...base, name: " " }])).toContain("non-empty name and role");
    expect(rejected([{ ...base, channel: "sms" }])).toContain("channel");
    expect(rejected([{ ...base, emailConfidence: "sure", email: "a@b.test" }])).toContain(
      "emailConfidence must be",
    );
    expect(rejected([{ ...base, doNotContact: "yes" }])).toContain("doNotContact");
    expect(rejected([{ ...base, profileUrl: 3 }])).toContain("profileUrl");
    expect(rejected([{ ...base, email: "", emailConfidence: "guess" }])).toContain("email");
    expect(rejected([{ ...base, email: "a@b.test" }])).toContain("without emailConfidence");
    expect(rejected([{ ...base, emailConfidence: "guess" }])).toContain("without an email");
    expect(rejected([{ ...base, sources: "x" }])).toContain("sources must be an array");
    expect(rejected([{ ...base, sources: [""] }])).toContain("non-empty strings");
    expect(rejected([{ ...base, recentItems: "x" }])).toContain("recentItems must be an array");
    expect(rejected([{ ...base, recentItems: ["x"] }])).toContain("must be an object");
    expect(rejected([{ ...base, recentItems: [{ date: "d", url: "", summary: "s" }] }])).toContain(
      "non-empty date",
    );
  });

  test("keeps optional fields when present", () => {
    const parsed = parseContacts([
      {
        ...base,
        profileUrl: "https://l.test/ana",
        email: "a@b.test",
        emailConfidence: "pattern",
        doNotContact: true,
      },
    ]);
    expect(parsed.ok && parsed.value[0]).toMatchObject({
      profileUrl: "https://l.test/ana",
      doNotContact: true,
    });
  });
});

describe("store failure paths", () => {
  test("readContacts reports internal errors for unreadable files", async () => {
    mkdirSync(path.join(root, "contacts", "k1.json"), { recursive: true });
    const result = await readContacts(dir, "k1");
    expect(!result.ok && result.error.code).toBe("internal");
  });

  test("recordContacts reports internal errors and unknown leads", async () => {
    const failed = await recordContacts(blockedDir(), "k1", []);
    expect(!failed.ok && failed.error.code).toBe("internal");
    const missing = await recordContacts(dir, "nope", []);
    expect(!missing.ok && missing.error.code).toBe("lead-not-found");
  });

  test("pruneContacts reports internal errors", async () => {
    const failed = await pruneContacts(blockedDir());
    expect(!failed.ok && failed.error.code).toBe("internal");
  });
});

describe("pruneContacts retention", () => {
  test("returns empty without a contacts folder", async () => {
    const pruned = await pruneContacts(dir);
    expect(pruned.ok && pruned.value).toEqual([]);
  });

  test("deletes only stale closed Leads and skips the rest", async () => {
    await lead("old");
    await lead("open");
    await appendEvent(dir, { kind: "status.changed", key: "old", from: "lead", to: "rejected" });
    await recordContacts(dir, "old", []);
    await recordContacts(dir, "open", []);
    writeFileSync(path.join(root, "contacts", "ghost.json"), "[]");
    writeFileSync(path.join(root, "contacts", "notes.txt"), "x");
    const soon = await pruneContacts(dir, new Date(Date.now() + 10 * DAY_MS));
    expect(soon.ok && soon.value).toEqual([]);
    const later = await pruneContacts(dir, new Date(Date.now() + 100 * DAY_MS));
    expect(later.ok && later.value).toEqual(["old"]);
    expect(existsSync(path.join(root, "contacts", "open.json"))).toBe(true);
    expect(existsSync(path.join(root, "contacts", "ghost.json"))).toBe(true);
  });
});

describe("contact command", () => {
  test("usage and data-dir errors", async () => {
    const noDir: CommandContext = { dataDir: null, env: {}, cwd: root };
    const file = path.join(root, "in.json");
    writeFileSync(file, "[]");
    expect((await run([], ctx)).ok).toBe(false);
    expect((await run(["record", "--lead", "k"], ctx)).ok).toBe(false);
    expect((await run(["record", "--lead", "k", "--file"], ctx)).ok).toBe(false);
    expect((await run(["record", "--lead", "k", "--file", file], noDir)).ok).toBe(false);
    expect((await run(["list"], ctx)).ok).toBe(false);
    expect((await run(["list", "--lead", "k"], noDir)).ok).toBe(false);
    expect((await run(["prune"], noDir)).ok).toBe(false);
  });

  test("record reports unreadable, invalid and unknown-lead input", async () => {
    const missing = await run(["record", "--lead", "k", "--file", "absent.json"], ctx);
    expect(!missing.ok && missing.error.code).toBe("not-found");
    const file = path.join(root, "in.json");
    writeFileSync(file, '{"not":"array"}');
    const invalid = await run(["record", "--lead", "k", "--file", file], ctx);
    expect(!invalid.ok && invalid.error.code).toBe("invalid-contact");
    writeFileSync(file, "[]");
    const unknown = await run(["record", "--lead", "k", "--file", file], ctx);
    expect(!unknown.ok && unknown.error.code).toBe("lead-not-found");
  });

  test("list returns contacts and surfaces read errors; prune succeeds", async () => {
    const listed = await run(["list", "--lead", "k"], ctx);
    expect(listed.ok && listed.data).toEqual({ lead: "k", contacts: [] });
    mkdirSync(path.join(root, "contacts", "k.json"), { recursive: true });
    const failed = await run(["list", "--lead", "k"], ctx);
    expect(!failed.ok && failed.error.code).toBe("internal");
    const pruned = await run(["prune"], ctx);
    expect(pruned.ok && pruned.data).toEqual({ deleted: [] });
  });

  test("prune surfaces store errors", async () => {
    const failed = await run(["prune"], { dataDir: blockedDir(), env: {}, cwd: root });
    expect(!failed.ok && failed.error.code).toBe("internal");
  });
});
