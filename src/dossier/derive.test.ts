import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CommandContext } from "../core/commands.ts";
import { isObject } from "../core/narrow.ts";
import { loadFactBank } from "../cv/facts.ts";
import { applyDossierBatch, deriveBatch } from "./derive.ts";
import { loadIdentityIfPresent } from "./identity-guard.ts";
import { parseProposal, validateProposal } from "./proposal.ts";

const REPO_ROOT = path.resolve(import.meta.dir, "../..");
let dataDir = "";

function context(): CommandContext {
  return { dataDir: { path: dataDir }, env: {}, cwd: dataDir };
}

function readMap(mapPath: string): Record<string, string> {
  const parsed: unknown = JSON.parse(readFileSync(mapPath, "utf8"));
  if (!isObject(parsed)) throw new Error("map is not an object");
  return Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key, String(value)]));
}

beforeEach(() => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), "jobship-derive-unit-"));
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

describe("parseProposal", () => {
  test("rejects a non-object and a fact without cites", () => {
    expect(parseProposal([]).ok).toBe(false);
    const bad = parseProposal({ facts: [{ id: "a", text: "t", source: "cv", cites: [] }] });
    expect(bad.ok).toBe(false);
  });

  test("accepts an empty proposal", () => {
    expect(parseProposal({}).ok).toBe(true);
  });

  test("carries a fact estimate and leaves it off when absent", () => {
    const parsed = parseProposal({
      facts: [
        { ...estimatedFact(), estimate: "1,000 PDFs/month × 3–5 min ≈ 50–85 h/month" },
        estimatedFact("plain"),
      ],
    });
    if (!parsed.ok) throw new Error(parsed.error.message);
    expect(parsed.value.facts[0]?.estimate).toBe("1,000 PDFs/month × 3–5 min ≈ 50–85 h/month");
    expect("estimate" in (parsed.value.facts[1] ?? {})).toBe(false);
  });

  test.each([[""], ["   "], [5], [null], [["a"]]])(
    "rejects estimate %p as proposal-invalid",
    (estimate) => {
      const parsed = parseProposal({ facts: [{ ...estimatedFact(), estimate }] });
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error.code).toBe("proposal-invalid");
    },
  );
});

describe("fact estimate", () => {
  const ESTIMATE = "1,000 PDFs/month × 3–5 min ≈ 50–85 h/month";

  test("derive writes the estimate to the batch and apply stores it", async () => {
    const batchPath = await applyProposal({ facts: [{ ...estimatedFact(), estimate: ESTIMATE }] });
    expect(readFileSync(batchPath, "utf8")).toContain(ESTIMATE);
    const [stored] = listOf("facts.yaml", "facts");
    expect(isObject(stored) && stored["estimate"]).toBe(ESTIMATE);
  });

  test("an estimate-only change is an update and apply rewrites it", async () => {
    await applyProposal({ facts: [estimatedFact()] });
    const proposal = parseProposal({ facts: [{ ...estimatedFact(), estimate: ESTIMATE }] });
    if (!proposal.ok) throw new Error(proposal.error.message);
    const derived = await deriveBatch(context(), proposal.value);
    if (!derived.ok) throw new Error(derived.error.message);
    expect(derived.value.items.map((item) => [item.op, item.id])).toEqual([
      ["update", "mentoring"],
    ]);
    const applied = await applyDossierBatch(context(), derived.value.batchPath);
    expect(applied).toEqual({ ok: true, value: { applied: 1 } });
    const [stored] = listOf("facts.yaml", "facts");
    expect(isObject(stored) && stored["estimate"]).toBe(ESTIMATE);
  });

  test("an unchanged estimate yields no items", async () => {
    const raw = { facts: [{ ...estimatedFact(), estimate: ESTIMATE }] };
    await applyProposal(raw);
    const proposal = parseProposal(raw);
    if (!proposal.ok) throw new Error(proposal.error.message);
    const derived = await deriveBatch(context(), proposal.value);
    if (!derived.ok) throw new Error(derived.error.message);
    expect(derived.value.items).toEqual([]);
  });

  test("dropping the estimate is an update and apply removes it", async () => {
    await applyProposal({ facts: [{ ...estimatedFact(), estimate: ESTIMATE }] });
    const proposal = parseProposal({ facts: [estimatedFact()] });
    if (!proposal.ok) throw new Error(proposal.error.message);
    const derived = await deriveBatch(context(), proposal.value);
    if (!derived.ok) throw new Error(derived.error.message);
    expect(derived.value.items.map((item) => item.op)).toEqual(["update"]);
    const applied = await applyDossierBatch(context(), derived.value.batchPath);
    expect(applied).toEqual({ ok: true, value: { applied: 1 } });
    const [stored] = listOf("facts.yaml", "facts");
    expect(isObject(stored) && "estimate" in stored).toBe(false);
  });
});

function estimatedFact(id = "mentoring"): Record<string, unknown> {
  return {
    id,
    text: "Mentored 3 junior engineers",
    tags: ["leadership"],
    source: "interview",
    cites: ["dossier/career.md:12"],
  };
}

describe("deriveBatch", () => {
  test("an empty proposal yields zero items and applies as a no-op", async () => {
    const proposal = parseProposal({});
    if (!proposal.ok) throw new Error("proposal should parse");
    const derived = await deriveBatch(context(), proposal.value);
    if (!derived.ok) throw new Error(derived.error.message);
    expect(derived.value.items).toEqual([]);
    const applied = await applyDossierBatch(context(), derived.value.batchPath);
    expect(applied).toEqual({ ok: true, value: { applied: 0 } });
  });

  test("records a relative key, applies from a copied data dir and from another cwd", async () => {
    const proposal = parseProposal({});
    if (!proposal.ok) throw new Error("proposal should parse");
    const derived = await deriveBatch(context(), proposal.value);
    if (!derived.ok) throw new Error(derived.error.message);
    const relative = path.relative(dataDir, derived.value.batchPath).split(path.sep).join("/");
    const mapPath = path.join(dataDir, "dossier-batches.json");
    const recorded = readMap(mapPath);
    expect(Object.keys(recorded)).toEqual([relative]);

    const copy = mkdtempSync(path.join(os.tmpdir(), "jobship-derive-copy-"));
    try {
      cpSync(dataDir, copy, { recursive: true });
      const moved = { dataDir: { path: copy }, env: {}, cwd: copy };
      expect(await applyDossierBatch(moved, path.join(copy, relative))).toEqual({
        ok: true,
        value: { applied: 0 },
      });
      const elsewhere = { dataDir: { path: dataDir }, env: {}, cwd: os.tmpdir() };
      expect(await applyDossierBatch(elsewhere, derived.value.batchPath)).toEqual({
        ok: true,
        value: { applied: 0 },
      });
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
  });

  test("a legacy absolute key still applies and an edited batch is batch-changed", async () => {
    const proposal = parseProposal({});
    if (!proposal.ok) throw new Error("proposal should parse");
    const derived = await deriveBatch(context(), proposal.value);
    if (!derived.ok) throw new Error(derived.error.message);
    const mapPath = path.join(dataDir, "dossier-batches.json");
    const [hash] = Object.values(readMap(mapPath));
    writeFileSync(mapPath, JSON.stringify({ [derived.value.batchPath]: hash }));
    expect((await applyDossierBatch(context(), derived.value.batchPath)).ok).toBe(true);
    writeFileSync(derived.value.batchPath, `${readFileSync(derived.value.batchPath, "utf8")} `);
    const edited = await applyDossierBatch(context(), derived.value.batchPath);
    expect(edited.ok).toBe(false);
    if (!edited.ok) expect(edited.error.code).toBe("batch-changed");
  });

  test("a data directory is required", async () => {
    const result = await deriveBatch(
      { dataDir: null, env: {}, cwd: dataDir },
      {
        facts: [],
        bullets: [],
        profile: {},
        neverClaim: [],
        answers: [],
      },
    );
    expect(result.ok).toBe(false);
  });

  test("an unknown fact reference in a bullet is refused", () => {
    const proposal = parseProposal({
      bullets: [{ id: "b", text: "t", tags: [], factIds: ["missing"] }],
    });
    if (!proposal.ok) throw new Error("proposal should parse");
    const checked = validateProposal({ path: dataDir }, proposal.value, []);
    expect(checked.ok).toBe(false);
  });

  test("removing a fact a stored bullet still cites is refused", () => {
    const stored = [{ id: "b-keep", text: "t", tags: [], factIds: ["f-gone"] }];
    const proposal = parseProposal({ removals: { facts: ["f-gone"], bullets: [] } });
    if (!proposal.ok) throw new Error("proposal should parse");
    const checked = validateProposal({ path: dataDir }, proposal.value, ["f-gone"], stored);
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.error.message).toContain("b-keep");
  });

  test("removing a fact with every citing bullet removed is accepted", () => {
    const stored = [{ id: "b-gone", text: "t", tags: [], factIds: ["f-gone"] }];
    const proposal = parseProposal({ removals: { facts: ["f-gone"], bullets: ["b-gone"] } });
    if (!proposal.ok) throw new Error("proposal should parse");
    const checked = validateProposal({ path: dataDir }, proposal.value, ["f-gone"], stored);
    expect(checked.ok).toBe(true);
  });
});

describe("loadIdentityIfPresent", () => {
  test("returns no fields when the Dossier is absent", () => {
    const empty = mkdtempSync(path.join(os.tmpdir(), "jobship-no-dossier-"));
    try {
      expect(loadIdentityIfPresent({ path: empty })).toEqual({ ok: true, value: [] });
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

function readDataFile(name: string): string {
  return readFileSync(path.join(dataDir, name), "utf8");
}

function parsedFile(name: string): Record<string, unknown> {
  const parsed: unknown = Bun.YAML.parse(readDataFile(name));
  if (!isObject(parsed)) throw new TypeError(`${name} is not a mapping`);
  return parsed;
}

function listOf(name: string, key: string): unknown[] {
  const list = parsedFile(name)[key];
  return Array.isArray(list) ? Array.from<unknown>(list) : [];
}

function loadBaseProposal(): Record<string, unknown> {
  const parsed: unknown = JSON.parse(
    readFileSync(path.join(REPO_ROOT, "fixtures/dossier/proposal.json"), "utf8"),
  );
  if (!isObject(parsed)) throw new TypeError("proposal fixture is not an object");
  return parsed;
}

async function applyProposal(raw: unknown): Promise<string> {
  const proposal = parseProposal(raw);
  if (!proposal.ok) throw new Error(proposal.error.message);
  const derived = await deriveBatch(context(), proposal.value);
  if (!derived.ok) throw new Error(derived.error.message);
  const applied = await applyDossierBatch(context(), derived.value.batchPath);
  if (!applied.ok) throw new Error(applied.error.message);
  return derived.value.batchPath;
}

describe("applyDossierBatch comment preservation", () => {
  const DERIVED_YAML = ["facts.yaml", "bullets.yaml", "profile.yaml", "never-claim.yaml"];
  const COMMENT_LINES = [
    "# ATS names: greenhouse, lever, ashby, workable, smartrecruiters (these need `jobship company add`).",
    "  # Linear only, all optional:",
    "  # states: {lead: Backlog, applied: In Progress}",
    '  # channelLabels: {linkedin: "channel:linkedin"}',
    '  # channelLabelPrefix: "channel:"',
    "  # titleFormat: role-at-company",
  ];

  test("keeps every comment and key order, parses as before, and is idempotent", async () => {
    writeFileSync(path.join(dataDir, "facts.yaml"), "# facts note\nfacts: []\n");
    writeFileSync(path.join(dataDir, "bullets.yaml"), "# bullets note\nbullets: []\n");
    const batchPath = await applyProposal(loadBaseProposal());

    const profileText = readDataFile("profile.yaml");
    for (const line of COMMENT_LINES) expect(profileText).toContain(line);
    expect(readDataFile("facts.yaml")).toContain("# facts note");
    expect(readDataFile("bullets.yaml")).toContain("# bullets note");
    const profile = parsedFile("profile.yaml");
    expect(Object.keys(profile).slice(0, 3)).toEqual(["regions", "contractTypes", "remote"]);
    expect(profile["regions"]).toEqual(["EU"]);
    const factIds = listOf("facts.yaml", "facts").map((fact) => isObject(fact) && fact["id"]);
    expect(factIds).toEqual(["checkout-latency", "ci-pipeline"]);
    expect(listOf("never-claim.yaml", "terms")).toEqual(["Kubernetes certified"]);

    const before = DERIVED_YAML.map(readDataFile);
    const again = await applyDossierBatch(context(), batchPath);
    expect(again).toEqual({ ok: true, value: { applied: 0 } });
    expect(DERIVED_YAML.map(readDataFile)).toEqual(before);
  });

  test("replacing a bullet keeps untouched entries and comments", async () => {
    writeFileSync(path.join(dataDir, "facts.yaml"), "# facts note\nfacts: []\n");
    const base = loadBaseProposal();
    await applyProposal(base);
    const stored: unknown = base["bullets"];
    const candidate: unknown = Array.isArray(stored) ? stored[0] : {};
    const first = isObject(candidate) ? candidate : {};
    const replacement = "Cut checkout latency threefold with a cache";
    await applyProposal({ ...base, bullets: [{ ...first, text: replacement }] });
    const bullets = listOf("bullets.yaml", "bullets");
    expect(bullets).toHaveLength(1);
    expect(isObject(bullets[0]) && bullets[0]["text"]).toBe(replacement);
    expect(readDataFile("facts.yaml")).toContain("# facts note");
  });

  test("removing the first row keeps the comment above the next row", async () => {
    const seeded = [
      "# leading note",
      "facts:",
      "  # about a",
      "  - id: a",
      "    text: A",
      "    tags: []",
      "    source: cv",
      "    cites: [dossier/career.md:10]",
      "  # about b",
      "  - id: b",
      "    text: B",
      "    tags: []",
      "    source: cv",
      "    cites: [dossier/career.md:11]",
      "",
    ].join("\n");
    writeFileSync(path.join(dataDir, "facts.yaml"), seeded);
    await applyProposal({ facts: [], removals: { facts: ["a"], bullets: [] } });
    const text = readDataFile("facts.yaml");
    expect(text).toContain("# about b");
    expect(text).toContain("# leading note");
    expect(text).not.toContain("id: a");
    expect(text).toContain("id: b");
  });

  test("a comment-only derived file keeps its comments", async () => {
    const proposal = parseProposal(loadBaseProposal());
    if (!proposal.ok) throw new Error(proposal.error.message);
    const derived = await deriveBatch(context(), proposal.value);
    if (!derived.ok) throw new Error(derived.error.message);
    writeFileSync(path.join(dataDir, "facts.yaml"), "# my notes\n");
    const applied = await applyDossierBatch(context(), derived.value.batchPath);
    expect(applied.ok).toBe(true);
    expect(readDataFile("facts.yaml")).toContain("# my notes");
    expect(listOf("facts.yaml", "facts")).toHaveLength(2);
  });

  test("a missing derived file starts from an empty document", async () => {
    rmSync(path.join(dataDir, "never-claim.yaml"));
    await applyProposal(loadBaseProposal());
    expect(listOf("never-claim.yaml", "terms")).toEqual(["Kubernetes certified"]);
  });
});

function entryProposal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "example-systems",
    name: "Example Systems",
    role: "Senior Backend Engineer",
    dates: "2021-2025",
    metadata: {},
    cites: ["dossier/career.md:8"],
    ...overrides,
  };
}

async function deriveRaw(raw: unknown): ReturnType<typeof deriveBatch> {
  const proposal = parseProposal(raw);
  if (!proposal.ok) throw new Error(proposal.error.message);
  return deriveBatch(context(), proposal.value);
}

describe("CV data proposal parsing", () => {
  test("accepts Entries, skills, header and their removals", () => {
    const parsed = parseProposal({
      experience: [entryProposal()],
      projects: [entryProposal({ id: "side", name: "Side" })],
      skills: [{ name: "Delivery", items: ["CI"], cites: ["dossier/career.md:11"] }],
      header: {
        name: "Jane Example",
        contact: { city: "Lisbon" },
        cites: ["dossier/identity.md:8"],
      },
      removals: {
        facts: [],
        bullets: [],
        experience: ["old"],
        projects: ["gone"],
        skills: ["Old"],
      },
    });
    expect(parsed.ok).toBe(true);
  });

  test.each([
    ["an empty entry id", { experience: [entryProposal({ id: "" })] }],
    ["an empty entry name", { projects: [entryProposal({ name: " " })] }],
    ["an entry without cites", { experience: [entryProposal({ cites: [] })] }],
    ["bad metadata", { experience: [entryProposal({ metadata: { a: 1 } })] }],
    ["a skills group without a name", { skills: [{ name: "", items: [], cites: ["x:1"] }] }],
    ["a skills group without cites", { skills: [{ name: "A", items: [] }] }],
    ["a header without a name", { header: { name: "", contact: {}, cites: ["x:1"] } }],
    ["a header without cites", { header: { name: "Jane", contact: {} } }],
    ["a non-list removal", { removals: { facts: [], bullets: [], skills: "A" } }],
  ])("rejects %s as proposal-invalid", (_label, raw) => {
    const parsed = parseProposal(raw);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.code).toBe("proposal-invalid");
  });
});

describe("CV data validation", () => {
  test("a citation naming no Dossier line fails and names the citation", async () => {
    const derived = await deriveRaw({
      experience: [entryProposal({ cites: ["dossier/career.md:99"] })],
    });
    expect(derived.ok).toBe(false);
    if (!derived.ok) {
      expect(derived.error.code).toBe("proposal-invalid");
      expect(derived.error.message).toContain("dossier/career.md:99");
    }
  });

  test("an Entry id repeated across experience and projects is refused", async () => {
    const derived = await deriveRaw({
      experience: [entryProposal()],
      projects: [entryProposal()],
    });
    expect(derived.ok).toBe(false);
    if (!derived.ok) expect(derived.error.code).toBe("proposal-invalid");
  });

  test("a skills group proposed twice is refused", async () => {
    const group = { name: "Delivery", items: ["CI"], cites: ["dossier/career.md:11"] };
    const derived = await deriveRaw({ skills: [group, group] });
    expect(derived.ok).toBe(false);
    if (!derived.ok) expect(derived.error.code).toBe("proposal-invalid");
  });

  const IDENTITY_CITE = ["dossier/identity.md:8"];
  const CAREER_CITE = ["dossier/career.md:11"];
  test.each([
    [
      "a header contact",
      { header: { name: "Jane", contact: { a: "123 Example St" }, cites: IDENTITY_CITE } },
    ],
    ["an Entry metadata value", { experience: [entryProposal({ metadata: { a: "1990-01-01" } })] }],
    ["a skills item", { skills: [{ name: "G", items: ["1990-01-01"], cites: CAREER_CITE }] }],
  ])("%s holding an identity value fails identity-leak", async (_label, raw) => {
    const derived = await deriveRaw(raw);
    expect(derived.ok).toBe(false);
    if (!derived.ok) expect(derived.error.code).toBe("identity-leak");
  });
});

describe("Entry references", () => {
  test("a bullet whose Entry is neither stored nor proposed is refused", async () => {
    const derived = await deriveRaw({
      bullets: [{ id: "b1", text: "t", tags: [], factIds: [], entry: "nowhere" }],
    });
    expect(derived.ok).toBe(false);
    if (!derived.ok) {
      expect(derived.error.code).toBe("proposal-invalid");
      expect(derived.error.message).toContain("bullet b1");
      expect(derived.error.message).toContain("nowhere");
    }
  });

  test("removing an Entry a stored bullet still uses is refused", () => {
    const stored = [{ id: "b-keep", text: "t", tags: [], factIds: [], entry: "old" }];
    const proposal = parseProposal({ removals: { facts: [], bullets: [], experience: ["old"] } });
    if (!proposal.ok) throw new Error("proposal should parse");
    const checked = validateProposal({ path: dataDir }, proposal.value, [], stored, {
      experience: ["old"],
      projects: [],
    });
    expect(checked.ok).toBe(false);
    if (!checked.ok) {
      expect(checked.error.message).toContain("b-keep");
      expect(checked.error.message).toContain("old");
    }
  });

  test("removing an Entry and the bullets using it in one batch is accepted", () => {
    const stored = [{ id: "b-gone", text: "t", tags: [], factIds: [], entry: "old" }];
    const proposal = parseProposal({
      removals: { facts: [], bullets: ["b-gone"], experience: ["old"] },
    });
    if (!proposal.ok) throw new Error("proposal should parse");
    const checked = validateProposal({ path: dataDir }, proposal.value, [], stored, {
      experience: ["old"],
      projects: [],
    });
    expect(checked.ok).toBe(true);
  });
});

describe("CV data derive and apply", () => {
  test("the fixture proposal writes Entries, skills and header and re-derives empty", async () => {
    const batchPath = await applyProposal(loadBaseProposal());
    const bank = loadFactBank({ path: dataDir });
    if (!bank.ok) throw new Error(bank.error.message);
    expect(bank.value.experience?.map((entry) => entry.id)).toEqual(["example-systems"]);
    expect(bank.value.skills?.map((group) => group.name)).toEqual(["Delivery"]);
    expect(bank.value.profile?.name).toBe("Jane Example");
    expect(bank.value.facts).toHaveLength(2);

    const again = await deriveRaw(loadBaseProposal());
    if (!again.ok) throw new Error(again.error.message);
    expect(again.value.items).toEqual([]);
    const before = readDataFile("facts.yaml");
    expect(await applyDossierBatch(context(), batchPath)).toEqual({
      ok: true,
      value: { applied: 0 },
    });
    expect(readDataFile("facts.yaml")).toBe(before);
  });

  test("fact items carry no section field and CV data items name theirs", async () => {
    const derived = await deriveRaw(loadBaseProposal());
    if (!derived.ok) throw new Error(derived.error.message);
    const raw: unknown = JSON.parse(readFileSync(derived.value.batchPath, "utf8"));
    const items = isObject(raw) && Array.isArray(raw["items"]) ? raw["items"] : [];
    const sections = items.map((item) => (isObject(item) ? item["section"] : null));
    expect(sections.filter((section) => section === undefined)).toHaveLength(items.length - 3);
    expect(sections.filter((section) => typeof section === "string").toSorted()).toEqual([
      "experience",
      "header",
      "skills",
    ]);
    expect(await applyDossierBatch(context(), derived.value.batchPath)).toEqual({
      ok: true,
      value: { applied: items.length },
    });
  });

  test("an Entry update keeps unrelated keys and comments in facts.yaml", async () => {
    writeFileSync(
      path.join(dataDir, "facts.yaml"),
      [
        "# facts note",
        "facts: []",
        "custom: keep-me",
        "experience:",
        "  # my entry",
        "  - id: example-systems",
        "    name: Example Systems",
        "    metadata: {}",
        "",
      ].join("\n"),
    );
    const derived = await deriveRaw({ experience: [entryProposal()] });
    if (!derived.ok) throw new Error(derived.error.message);
    expect(derived.value.items.map((item) => [item.op, item.id])).toEqual([
      ["update", "example-systems"],
    ]);
    await applyDossierBatch(context(), derived.value.batchPath);
    const text = readDataFile("facts.yaml");
    expect(text).toContain("# facts note");
    expect(text).toContain("# my entry");
    expect(text).toContain("custom: keep-me");
    expect(text).toContain("dates: 2021-2025");
    const [stored] = listOf("facts.yaml", "experience");
    expect(isObject(stored) && stored["role"]).toBe("Senior Backend Engineer");
  });

  test("an Entry stored under experience cannot be proposed under projects", async () => {
    await applyProposal(loadBaseProposal());
    const derived = await deriveRaw({ projects: [entryProposal()] });
    expect(derived.ok).toBe(false);
    if (!derived.ok) {
      expect(derived.error.code).toBe("proposal-invalid");
      expect(derived.error.message).toContain("example-systems");
    }
  });

  test("moving an Entry to projects with its experience removal is accepted", async () => {
    await applyProposal(loadBaseProposal());
    const derived = await deriveRaw({
      projects: [entryProposal()],
      removals: { facts: [], bullets: [], experience: ["example-systems"] },
    });
    if (!derived.ok) throw new Error(derived.error.message);
    await applyDossierBatch(context(), derived.value.batchPath);
    expect(listOf("facts.yaml", "experience")).toEqual([]);
    expect(listOf("facts.yaml", "projects")).toHaveLength(1);
  });

  test("a header update keeps comments inside the stored header", async () => {
    writeFileSync(
      path.join(dataDir, "facts.yaml"),
      [
        "facts: []",
        "profile:",
        "  name: Jane Example",
        "  contact:",
        "    # how recruiters reach me",
        "    email: old@mail.example",
        "    city: Lisbon",
        "  cites:",
        "    - dossier/identity.md:8",
        "",
      ].join("\n"),
    );
    const derived = await deriveRaw({
      header: {
        name: "Jane Example",
        contact: { email: "jane@mail.example", city: "Lisbon" },
        cites: ["dossier/identity.md:8"],
      },
    });
    if (!derived.ok) throw new Error(derived.error.message);
    expect(await applyDossierBatch(context(), derived.value.batchPath)).toEqual({
      ok: true,
      value: { applied: 1 },
    });
    const text = readDataFile("facts.yaml");
    expect(text).toContain("# how recruiters reach me");
    expect(text).toContain("email: jane@mail.example");
    expect(text).not.toContain("old@mail.example");
  });

  test("removals delete an Entry and a skills group", async () => {
    await applyProposal(loadBaseProposal());
    const derived = await deriveRaw({
      bullets: [],
      removals: {
        facts: [],
        bullets: ["b-checkout-latency"],
        experience: ["example-systems"],
        skills: ["Delivery"],
      },
    });
    if (!derived.ok) throw new Error(derived.error.message);
    expect(derived.value.items.map((item) => [item.section ?? item.file, item.op])).toEqual([
      ["experience", "remove"],
      ["skills", "remove"],
      ["bullets.yaml", "remove"],
    ]);
    await applyDossierBatch(context(), derived.value.batchPath);
    expect(listOf("facts.yaml", "experience")).toEqual([]);
    expect(listOf("facts.yaml", "skills")).toEqual([]);
  });
});
