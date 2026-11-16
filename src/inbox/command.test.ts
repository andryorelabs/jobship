import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { CommandContext } from "../core/commands.ts";
import { run } from "./command.ts";

let dir = { path: "" };

beforeEach(() => {
  dir = { path: mkdtempSync(path.join(os.tmpdir(), "jobship-inbox-command-")) };
});

afterEach(() => {
  rmSync(dir.path, { recursive: true, force: true });
});

function context(dataDir: { path: string } | null = dir): CommandContext {
  return { dataDir, env: {}, cwd: dir.path };
}

function writeEmails(rows: unknown): void {
  writeFileSync(path.join(dir.path, "emails.json"), JSON.stringify(rows));
}

function errorOf(envelope: Awaited<ReturnType<typeof run>>): { code: string; message: string } {
  if (envelope.ok) throw new Error("expected a failure envelope");
  return envelope.error;
}

describe("inbox command errors", () => {
  test("fails without a data directory", async () => {
    const envelope = await run(["propose"], context(null));
    expect(errorOf(envelope).code).toBe("data-dir-not-found");
  });

  test("rejects emails that are not an array of classified rows", async () => {
    writeEmails({ not: "an array" });
    const notArray = await run(["propose", "--emails", "emails.json"], context());
    expect(errorOf(notArray).code).toBe("usage");
    writeEmails([
      { messageId: "", threadId: "t", from: "a", subject: "s", classification: "other" },
    ]);
    const emptyId = await run(["propose", "--emails", "emails.json"], context());
    expect(errorOf(emptyId).code).toBe("usage");
    writeEmails([
      { messageId: "m", threadId: 1, from: "a", subject: "s", classification: "other" },
    ]);
    const badThread = await run(["propose", "--emails", "emails.json"], context());
    expect(errorOf(badThread).code).toBe("usage");
    writeEmails([{ messageId: "m", threadId: "t", from: "a", subject: "s", classification: "x" }]);
    const badClass = await run(["propose", "--emails", "emails.json"], context());
    expect(errorOf(badClass).code).toBe("usage");
    writeEmails(["row"]);
    const notObject = await run(["propose", "--emails", "emails.json"], context());
    expect(errorOf(notObject).code).toBe("usage");
  });

  test("reports an internal error when the emails file is missing", async () => {
    const envelope = await run(["propose", "--emails", "missing.json"], context());
    expect(errorOf(envelope).code).toBe("internal");
  });

  test("surfaces a propose failure from a corrupt thread map", async () => {
    writeEmails([]);
    writeFileSync(path.join(dir.path, "inbox-threads.json"), "{");
    const envelope = await run(["propose", "--emails", "emails.json"], context());
    expect(errorOf(envelope).code).toBe("inbox-propose-failed");
  });

  test("apply needs a batch path and reports a missing batch as recoverable", async () => {
    const missingArg = await run(["apply"], context());
    expect(errorOf(missingArg).code).toBe("usage");
    const missingFile = await run(["apply", "--ignored", "x", "nope.json"], context());
    expect(missingFile.ok).toBe(false);
    expect(!missingFile.ok && missingFile.error.recoveryAction).toContain("inbox propose");
  });
});
