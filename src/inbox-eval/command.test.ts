import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { CommandContext } from "../core/commands.ts";
import { run } from "./command.ts";

let root = "";

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "inbox-eval-command-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function context(): CommandContext {
  return { dataDir: null, env: {}, cwd: root };
}

function writeJson(name: string, value: unknown): void {
  writeFileSync(path.join(root, name), JSON.stringify(value));
}

function labelled(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    messageId: "m1",
    language: "en",
    from: "jobs@acme.test",
    subject: "Update",
    body: "We regret to inform you",
    label: "rejection",
    ...overrides,
  };
}

function labelsDirectory(rows: unknown): void {
  mkdirSync(path.join(root, "labels"), { recursive: true });
  writeJson("labels/rows.json", rows);
}

async function failureMessage(argv: string[]): Promise<string> {
  const envelope = await run(argv, context());
  if (envelope.ok) throw new Error("expected a failure envelope");
  return envelope.error.message;
}

describe("inbox eval inputs", () => {
  test("scores predictions against a custom labels directory", async () => {
    labelsDirectory([labelled()]);
    writeJson("predictions.json", [{ messageId: "m1", classification: "rejection" }]);
    const envelope = await run(["predictions.json", "--labels", "labels"], context());
    expect(envelope.ok).toBe(true);
  });

  test("ignores non-JSON files in the labels directory", async () => {
    labelsDirectory([labelled()]);
    writeFileSync(path.join(root, "labels", "notes.txt"), "ignore me");
    writeJson("predictions.json", []);
    const envelope = await run(["predictions.json", "--labels", "labels"], context());
    expect(envelope.ok).toBe(true);
  });

  test("skips flag tokens when locating the predictions file", async () => {
    labelsDirectory([labelled()]);
    writeJson("predictions.json", []);
    const envelope = await run(["--labels", "labels", "predictions.json"], context());
    expect(envelope.ok).toBe(true);
  });

  test.each([
    ["not an object", "row"],
    ["empty id", labelled({ messageId: "" })],
    ["unknown language", labelled({ language: "fr" })],
    ["non-string field", labelled({ from: 1 })],
    ["unknown label", labelled({ label: "bogus" })],
  ])("rejects a labelled row with %s", async (_name, row) => {
    writeJson("predictions.json", []);
    labelsDirectory([row]);
    expect(await failureMessage(["predictions.json", "--labels", "labels"])).toContain(
      "malformed or empty",
    );
  });

  test("rejects labels that are not an array or are empty", async () => {
    writeJson("predictions.json", []);
    labelsDirectory({ not: "an array" });
    expect(await failureMessage(["predictions.json", "--labels", "labels"])).toContain(
      "malformed or empty",
    );
    labelsDirectory([]);
    expect(await failureMessage(["predictions.json", "--labels", "labels"])).toContain(
      "malformed or empty",
    );
  });

  test.each([
    ["not an array", { not: "an array" }],
    ["a non-object row", ["row"]],
    ["an empty id", [{ messageId: "", classification: "other" }]],
    ["an unknown class", [{ messageId: "m1", classification: "bogus" }]],
  ])("rejects predictions that are %s", async (_name, value) => {
    labelsDirectory([labelled()]);
    writeJson("predictions.json", value);
    expect(await failureMessage(["predictions.json", "--labels", "labels"])).toContain(
      "classifications must be a JSON array",
    );
  });

  test("reports unreadable inputs", async () => {
    labelsDirectory([labelled()]);
    expect(await failureMessage(["missing.json", "--labels", "labels"])).toContain(
      "could not read inputs",
    );
    expect(await failureMessage(["predictions.json", "--labels", "absent"])).toContain(
      "could not read inputs",
    );
  });

  test("requires a classifications file", async () => {
    expect(await failureMessage([])).toContain("needs a classifications file path");
  });
});
