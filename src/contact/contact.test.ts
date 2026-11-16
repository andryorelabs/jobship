import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { CommandContext } from "../core/commands.ts";
import type { DataDir, Posting } from "../core/types.ts";
import { appendEvent, readEvents } from "../ledger/events.ts";
import { run } from "./command.ts";
import { pruneContacts, readContacts } from "./store.ts";

const posting: Posting = {
  source: "greenhouse",
  id: "1",
  title: "Engineer",
  company: "Acme",
  url: "https://example.test/1",
};

const contact = {
  name: "Ana Ruiz",
  role: "Engineering Manager",
  channel: "email",
  email: "ana@acme.test",
  emailConfidence: "published",
  sources: ["https://acme.test/team"],
  recentItems: [{ date: "2026-10-01", url: "https://acme.test/post", summary: "Hiring" }],
};

let root: string;
let dir: DataDir;
let ctx: CommandContext;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "contact-"));
  dir = { path: root };
  ctx = { dataDir: dir, env: {}, cwd: root };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

async function createLead(key: string): Promise<void> {
  await appendEvent(dir, { kind: "lead.created", key, posting, eligibility: "eligible" });
}

function writeInput(value: unknown): string {
  const file = path.join(root, "input.json");
  writeFileSync(file, JSON.stringify(value));
  return file;
}

describe("contact record", () => {
  test("appends a light event and writes the detail file", async () => {
    await createLead("k1");
    const result = await run(["record", "--lead", "k1", "--file", writeInput([contact])], ctx);
    expect(result.ok).toBe(true);
    const found = (await readEvents(dir, "k1")).filter((event) => event.kind === "contact.found");
    expect(found).toHaveLength(1);
    expect(JSON.stringify(found)).not.toContain("ana@acme.test");
    expect(found[0]).toMatchObject({
      name: "Ana Ruiz",
      role: "Engineering Manager",
      channel: "email",
    });
    const stored = await readContacts(dir, "k1");
    expect(stored.ok && stored.value[0]?.email).toBe("ana@acme.test");
  });

  test("rejects verified confidence, more than 3 contacts and unknown leads", async () => {
    await createLead("k1");
    const verified = await run(
      [
        "record",
        "--lead",
        "k1",
        "--file",
        writeInput([{ ...contact, emailConfidence: "verified" }]),
      ],
      ctx,
    );
    expect(verified.ok).toBe(false);
    const many = await run(
      ["record", "--lead", "k1", "--file", writeInput([contact, contact, contact, contact])],
      ctx,
    );
    expect(many.ok).toBe(false);
    const unknown = await run(["record", "--lead", "nope", "--file", writeInput([contact])], ctx);
    expect(unknown.ok).toBe(false);
    expect(existsSync(path.join(root, "contacts"))).toBe(false);
    expect((await readEvents(dir)).filter((event) => event.kind === "contact.found")).toEqual([]);
  });

  test("keys with path characters stay inside the contacts folder", async () => {
    await createLead("greenhouse:a/b|c");
    const result = await run(
      ["record", "--lead", "greenhouse:a/b|c", "--file", writeInput([contact])],
      ctx,
    );
    expect(result.ok).toBe(true);
    const listed = await run(["list", "--lead", "greenhouse:a/b|c"], ctx);
    expect(JSON.stringify(listed)).toContain("Ana Ruiz");
  });
});

describe("contact list", () => {
  test("returns an empty list for a Lead without contacts", async () => {
    const listed = await run(["list", "--lead", "none"], ctx);
    expect(JSON.stringify(listed)).toContain('"contacts":[]');
  });
});

describe("contact prune", () => {
  test("deletes closed-over-90-days files, keeps open and event-less ones", async () => {
    await createLead("old");
    await createLead("open");
    await run(["record", "--lead", "old", "--file", writeInput([contact])], ctx);
    await run(["record", "--lead", "open", "--file", writeInput([contact])], ctx);
    mkdirSync(path.join(root, "contacts"), { recursive: true });
    writeFileSync(path.join(root, "contacts", "ghost.json"), JSON.stringify([contact]));
    await appendEvent(dir, { kind: "status.changed", key: "old", to: "rejected" });
    const future = new Date(Date.now() + 100 * 86_400_000);
    const pruned = await pruneContacts(dir, future);
    expect(pruned.ok && pruned.value).toEqual(["old"]);
    expect(existsSync(path.join(root, "contacts", "old.json"))).toBe(false);
    expect(existsSync(path.join(root, "contacts", "open.json"))).toBe(true);
    expect(existsSync(path.join(root, "contacts", "ghost.json"))).toBe(true);
  });

  test("keeps files of Leads closed less than 90 days ago", async () => {
    await createLead("recent");
    await run(["record", "--lead", "recent", "--file", writeInput([contact])], ctx);
    await appendEvent(dir, { kind: "status.changed", key: "recent", to: "withdrawn" });
    const pruned = await pruneContacts(dir, new Date(Date.now() + 80 * 86_400_000));
    expect(pruned.ok && pruned.value).toEqual([]);
  });
});
