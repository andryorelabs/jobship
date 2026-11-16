import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { listAnswers, lookupAnswer, saveAnswer } from "./answers.ts";

let workDir = "";

beforeEach(() => {
  workDir = mkdtempSync(path.join(os.tmpdir(), "jobship-answers-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function seed(rows: unknown): void {
  writeFileSync(path.join(workDir, "answers.json"), JSON.stringify(rows));
}

describe("stored answers", () => {
  test("lists nothing when no file exists", () => {
    expect(listAnswers({ path: workDir })).toEqual([]);
  });

  test("lists rows keyed by answerKey or by a legacy question and drops malformed rows", () => {
    seed([
      { answerKey: "custom key", scope: "global", text: "a", provenance: "p" },
      { question: "Why us?", scope: "global", text: "b", provenance: "p" },
      { scope: "global", text: "no key", provenance: "p" },
      { answerKey: "k", scope: "global", text: 1, provenance: "p" },
      "not an object",
    ]);
    const answers = listAnswers({ path: workDir });
    expect(answers).toHaveLength(2);
    expect(answers[0]).toMatchObject({ answerKey: "custom key", text: "a" });
    expect(answers[1]).toMatchObject({ text: "b" });
  });

  test("rejects a file that is not a JSON array", () => {
    seed({ not: "an array" });
    expect(() => listAnswers({ path: workDir })).toThrow("answers.json must be a JSON array");
  });

  test("abstains on an empty question and on Tier D questions", () => {
    const dir = { path: workDir };
    expect(lookupAnswer(dir, "   ", "global").status).toBe("abstain");
    expect(lookupAnswer(dir, "gender", "global").status).toBe("abstain");
  });

  test("refuses to save an empty question, empty provenance or a Tier D key", async () => {
    const dir = { path: workDir };
    const empty = await saveAnswer(dir, "  ", "global", "x", "human");
    expect(!empty.ok && empty.error.message).toBe("question is empty");
    const noProvenance = await saveAnswer(dir, "Why us?", "global", "x", "   ");
    expect(!noProvenance.ok && noProvenance.error.message).toBe("provenance is required");
    const tierD = await saveAnswer(dir, "gender", "global", "x", "human");
    expect(!tierD.ok && tierD.error.message).toContain("never pre-filled");
  });

  test("replaces an answer with the same key and scope", async () => {
    const dir = { path: workDir };
    await saveAnswer(dir, "Why us?", "global", "first", "human");
    const saved = await saveAnswer(dir, "Why us?", "global", "second", "human");
    expect(saved.ok).toBe(true);
    const rows: unknown = JSON.parse(readFileSync(path.join(workDir, "answers.json"), "utf8"));
    expect(Array.isArray(rows) && rows).toHaveLength(1);
    expect(lookupAnswer(dir, "Why us?", "global")).toMatchObject({ text: "second" });
  });

  test("reports an internal error when the stored file is corrupt", async () => {
    writeFileSync(path.join(workDir, "answers.json"), "{");
    const saved = await saveAnswer({ path: workDir }, "Why us?", "global", "x", "human");
    expect(!saved.ok && saved.error.code).toBe("internal");
  });
});
