import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { parseProposal, validateProposal } from "./proposal.ts";

const REPO_ROOT = path.resolve(import.meta.dir, "../..");
let dataDir = "";

beforeEach(() => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), "jobship-proposal-"));
  cpSync(path.join(REPO_ROOT, "fixtures/dossier/complete/dossier"), path.join(dataDir, "dossier"), {
    recursive: true,
  });
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

const FACT = {
  id: "f1",
  text: "Did a thing",
  tags: [],
  source: "cv",
  cites: ["dossier/career.md:10"],
};
const BULLET = { id: "b1", text: "Bullet", tags: [], factIds: ["f1"] };
const ANSWER = { answerKey: "sponsorship", scope: "global", text: "No", provenance: "p" };

function proposalOf(raw: unknown): Parameters<typeof validateProposal>[1] {
  const proposal = parseProposal(raw);
  if (!proposal.ok) throw new Error(proposal.error.message);
  return proposal.value;
}

describe("parseProposal rejections", () => {
  test.each([
    ["facts that are not a list of objects", { facts: ["x"] }, "facts must be a list of objects"],
    ["a fact without an id", { facts: [{ ...FACT, id: "" }] }, "needs a non-empty string id"],
    [
      "a fact with a blank text",
      { facts: [{ ...FACT, text: " " }] },
      "needs a non-empty string id",
    ],
    ["fact tags that are not strings", { facts: [{ ...FACT, tags: [1] }] }, "tags must be a list"],
    ["a fact with an unknown source", { facts: [{ ...FACT, source: "dream" }] }, "source must be"],
    ["a bullet without an id", { bullets: [{ ...BULLET, id: "" }] }, "needs a non-empty string id"],
    [
      "bullet tags that are not strings",
      { bullets: [{ ...BULLET, tags: [1] }] },
      "tags and factIds must be lists",
    ],
    [
      "bullet factIds that are not strings",
      { bullets: [{ ...BULLET, factIds: [1] }] },
      "tags and factIds must be lists",
    ],
    [
      "a bullet entry that is not a string",
      { bullets: [{ ...BULLET, entry: 1 }] },
      "entry must be",
    ],
    [
      "a bullet order that is not a number",
      { bullets: [{ ...BULLET, order: "1" }] },
      "order must be a number",
    ],
    [
      "an Entry role that is not a string",
      { experience: [{ id: "e", name: "N", role: 1, cites: ["x:1"] }] },
      "role and dates must be strings",
    ],
    ["a profile that is not an object", { profile: [] }, "profile must be an object"],
    ["an unproposable profile field", { profile: { bogus: 1 } }, "not a proposable Profile field"],
    ["removals that are not an object", { removals: [] }, "removals must be an object"],
    ["a header that is not an object", { header: "x" }, "header must be an object"],
    [
      "skills items that are not strings",
      { skills: [{ name: "A", items: [1], cites: ["x:1"] }] },
      "items must be a list of strings",
    ],
    ["a neverClaim that is not strings", { neverClaim: [1] }, "neverClaim must be a list"],
    ["an Answer without a scope", { answers: [{ ...ANSWER, scope: "" }] }, "needs answerKey"],
    [
      "an unknown Answer key",
      { answers: [{ ...ANSWER, answerKey: "nonsense" }] },
      "unknown Answer key",
    ],
    ["a tier D Answer key", { answers: [{ ...ANSWER, answerKey: "gender" }] }, "never stored"],
  ])("rejects %s", (_label, raw, message) => {
    const parsed = parseProposal(raw);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.code).toBe("proposal-invalid");
      expect(parsed.error.message).toContain(message);
    }
  });
});

describe("validateProposal rejections", () => {
  test("skills items and header contact values are screened and accepted when clean", () => {
    const proposal = proposalOf({
      skills: [{ name: "Languages", items: ["TypeScript", "Go"], cites: ["dossier/career.md:10"] }],
      header: {
        name: "Jane Example",
        contact: { site: "example.dev" },
        cites: ["dossier/career.md:10"],
      },
    });
    expect(validateProposal({ path: dataDir }, proposal, []).ok).toBe(true);
  });

  test("proposed bullets are checked against removed facts and removed Entries", () => {
    const proposal = proposalOf({
      facts: [FACT],
      bullets: [{ ...BULLET, entry: "kept" }],
      removals: { facts: ["f-old"], bullets: [], experience: ["old"] },
    });
    const stored = [{ id: "b-old", text: "t", tags: [], factIds: ["f1"], entry: "kept" }];
    const checked = validateProposal({ path: dataDir }, proposal, ["f-old"], stored, {
      experience: ["old", "kept"],
      projects: [],
    });
    expect(checked.ok).toBe(true);
  });

  test("a proposed bullet that cites a removed fact is refused", () => {
    const proposal = proposalOf({
      bullets: [{ ...BULLET, factIds: ["f-old"] }],
      removals: { facts: ["f-old"], bullets: [] },
    });
    const checked = validateProposal({ path: dataDir }, proposal, ["f-old"]);
    expect(checked.ok).toBe(false);
  });

  test("a bullet id proposed twice is refused", () => {
    const proposal = proposalOf({ facts: [FACT], bullets: [BULLET, BULLET] });
    const checked = validateProposal({ path: dataDir }, proposal, []);
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.error.message).toContain("proposed twice");
  });

  test("a fact citation naming no Dossier line is refused", () => {
    const proposal = proposalOf({ facts: [{ ...FACT, cites: ["dossier/career.md:999"] }] });
    const checked = validateProposal({ path: dataDir }, proposal, []);
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.error.message).toContain("does not name a Dossier line");
  });

  test("a profile.yaml that is not valid YAML is refused", () => {
    writeFileSync(path.join(dataDir, "profile.yaml"), "a: [unterminated\n");
    const proposal = proposalOf({ profile: { regions: ["EU"] } });
    const checked = validateProposal({ path: dataDir }, proposal, []);
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.error.message).toContain("is not valid YAML");
  });
});
