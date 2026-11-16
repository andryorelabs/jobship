import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { approvalHash, batchKey, IdempotencyMap } from "../core/approval.ts";
import type { CommandContext } from "../core/commands.ts";
import { applyDossierBatch, deriveBatch } from "./derive.ts";
import { parseProposal } from "./proposal.ts";

const REPO_ROOT = path.resolve(import.meta.dir, "../..");
let dataDir = "";

function context(): CommandContext {
  return { dataDir: { path: dataDir }, env: {}, cwd: dataDir };
}

beforeEach(() => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), "jobship-derive-edges-"));
  cpSync(path.join(REPO_ROOT, "fixtures/dossier/complete/dossier"), path.join(dataDir, "dossier"), {
    recursive: true,
  });
  for (const file of ["facts.yaml", "bullets.yaml", "profile.yaml", "never-claim.yaml"]) {
    cpSync(path.join(REPO_ROOT, "templates", file), path.join(dataDir, file));
  }
  writeFileSync(path.join(dataDir, "answers.json"), "[]\n");
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

async function derive(raw: unknown): ReturnType<typeof deriveBatch> {
  const proposal = parseProposal(raw);
  if (!proposal.ok) throw new Error(proposal.error.message);
  return deriveBatch(context(), proposal.value);
}

function recordBatch(batchPath: string, content: string): void {
  writeFileSync(batchPath, content);
  new IdempotencyMap(path.join(dataDir, "dossier-batches.json")).record(
    batchKey(dataDir, batchPath),
    approvalHash(content),
  );
}

function writeBatchFile(content: string): string {
  const batchPath = path.join(dataDir, "dossier", "batches", "crafted.json");
  mkdirSync(path.dirname(batchPath), { recursive: true });
  recordBatch(batchPath, content);
  return batchPath;
}

function writeItemsBatch(items: readonly unknown[]): string {
  return writeBatchFile(`${JSON.stringify({ version: 1, items })}\n`);
}

const ANSWER = {
  answerKey: "sponsorship",
  scope: "global",
  text: "No",
  provenance: "dossier/search.md",
};

describe("deriveBatch edges", () => {
  test("a profile key absent from profile.yaml is an add", async () => {
    const profilePath = path.join(dataDir, "profile.yaml");
    const withoutRegions = readFileSync(profilePath, "utf8").replace("regions: []\n", "");
    writeFileSync(profilePath, withoutRegions);
    const derived = await derive({ profile: { regions: ["EU"] } });
    if (!derived.ok) throw new Error(derived.error.message);
    expect(derived.value.items.map((item) => [item.file, item.op])).toEqual([
      ["profile.yaml", "add"],
    ]);
  });

  test("a changed stored Answer is an update and apply rewrites it", async () => {
    const first = await derive({ answers: [ANSWER] });
    if (!first.ok) throw new Error(first.error.message);
    await applyDossierBatch(context(), first.value.batchPath);
    const second = await derive({ answers: [{ ...ANSWER, text: "Yes" }] });
    if (!second.ok) throw new Error(second.error.message);
    expect(second.value.items.map((item) => item.op)).toEqual(["update"]);
    const applied = await applyDossierBatch(context(), second.value.batchPath);
    expect(applied).toEqual({ ok: true, value: { applied: 1 } });
    expect(readFileSync(path.join(dataDir, "answers.json"), "utf8")).toContain("Yes");
  });

  test("missing facts, bullets and never-claim files derive as empty", async () => {
    for (const file of ["facts.yaml", "bullets.yaml", "never-claim.yaml"]) {
      unlinkSync(path.join(dataDir, file));
    }
    const derived = await derive({});
    expect(derived.ok).toBe(true);
  });

  test("an unreadable derived file fails dossier-derive-failed", async () => {
    unlinkSync(path.join(dataDir, "profile.yaml"));
    mkdirSync(path.join(dataDir, "profile.yaml"));
    const derived = await derive({});
    expect(derived.ok).toBe(false);
    if (!derived.ok) expect(derived.error.code).toBe("dossier-derive-failed");
  });
});

describe("applyDossierBatch edges", () => {
  test("a batch this data dir never derived is batch-changed", async () => {
    const batchPath = path.join(dataDir, "stray.json");
    writeFileSync(batchPath, '{"items":[]}');
    const applied = await applyDossierBatch(context(), batchPath);
    expect(applied.ok).toBe(false);
    if (!applied.ok) expect(applied.error.code).toBe("batch-changed");
  });

  test("a missing batch file is batch-not-found", async () => {
    const applied = await applyDossierBatch(context(), path.join(dataDir, "nope.json"));
    expect(applied.ok).toBe(false);
    if (!applied.ok) expect(applied.error.code).toBe("batch-not-found");
  });

  test.each([
    ["a non-object item", ["nope"]],
    ["an unknown file", [{ file: "x.yaml", op: "add", id: "a" }]],
    [
      "a section on a non-facts file",
      [{ file: "bullets.yaml", section: "facts", op: "add", id: "a" }],
    ],
    ["an unknown section", [{ file: "facts.yaml", section: "nope", op: "add", id: "a" }]],
  ])("%s is not a valid batch", async (_name, items) => {
    const applied = await applyDossierBatch(context(), writeItemsBatch(items));
    expect(applied.ok).toBe(false);
    if (!applied.ok) expect(applied.error.message).toContain("not a valid batch");
  });

  test("a batch whose items is not a list is not a valid batch", async () => {
    const batchPath = writeBatchFile('{"version":1,"items":"x"}\n');
    const applied = await applyDossierBatch(context(), batchPath);
    expect(applied.ok).toBe(false);
    if (!applied.ok) expect(applied.error.message).toContain("not a valid batch");
  });

  test.each([
    ["answers.json", undefined, "answer"],
    ["facts.yaml", undefined, "fact"],
    ["facts.yaml", "experience", "entry"],
    ["facts.yaml", "skills", "skills"],
    ["facts.yaml", "header", "header"],
    ["bullets.yaml", undefined, "bullet"],
  ])("a malformed %s %s item fails dossier-apply-failed", async (file, section, label) => {
    const item = {
      file,
      ...(section === undefined ? {} : { section }),
      op: "add",
      id: "x",
      value: 1,
    };
    const applied = await applyDossierBatch(context(), writeItemsBatch([item]));
    expect(applied.ok).toBe(false);
    if (!applied.ok) {
      expect(applied.error.code).toBe("dossier-apply-failed");
      expect(applied.error.message).toContain(`${label} item is`);
    }
  });
});
