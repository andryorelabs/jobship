import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { Document, isMap, isSeq, parseDocument, type YAMLSeq } from "yaml";
import { listAnswers, type StoredAnswer } from "../apply/answers.ts";
import { approvalHash, batchKey, IdempotencyMap, lookupBatchHash } from "../core/approval.ts";
import type { CommandContext } from "../core/commands.ts";
import { withLock, writeAtomic } from "../core/fs.ts";
import { errorMessage, isObject, isOneOf } from "../core/narrow.ts";
import type { DataDir, Result } from "../core/types.ts";
import { loadBullets, loadFactBank, loadNeverClaim } from "../cv/facts.ts";
import type { Bullet } from "../cv/types.ts";
import { DOSSIER_SOURCES } from "./dossier.ts";
import { validateProposal, type DossierProposal, type FactProposal } from "./proposal.ts";

const DERIVED_FILES = [
  "facts.yaml",
  "bullets.yaml",
  "profile.yaml",
  "never-claim.yaml",
  "answers.json",
] as const;
type DerivedFile = (typeof DERIVED_FILES)[number];

const OPERATIONS = ["add", "update", "remove"] as const;
type Operation = (typeof OPERATIONS)[number];

const SECTIONS = ["facts", "experience", "projects", "skills", "header"] as const;
type Section = (typeof SECTIONS)[number];

/**
 * One difference between a proposal and the current derived files. `section` names the
 * part of facts.yaml a change targets; its absence means `facts`.
 */
type DerivedChange = {
  readonly file: DerivedFile;
  readonly section?: Section;
  readonly op: Operation;
  readonly id: string;
  readonly value: unknown;
};

const HEADER_ID = "header";

const BATCH_DIRECTORY = "dossier/batches";
const BATCH_HASHES_FILE = "dossier-batches.json";
const LOCK_DIRECTORY = ".dossier";
const BATCH_VERSION = 1;

function fail(
  code: string,
  message: string,
): { ok: false; error: { code: string; message: string } } {
  return { ok: false, error: { code, message } };
}

function readYamlMapping(dir: DataDir, file: string): Record<string, unknown> {
  const target = path.join(dir.path, file);
  if (!existsSync(target)) return {};
  const parsed: unknown = Bun.YAML.parse(readFileSync(target, "utf8"));
  return isObject(parsed) ? parsed : {};
}

function rowsOf(document: Record<string, unknown>, key: string): Record<string, unknown>[] {
  const list = document[key];
  return Array.isArray(list) ? list.filter(isObject) : [];
}

function canonical(value: unknown): string {
  return JSON.stringify(value);
}

function bulletRow(bullet: Bullet): Record<string, unknown> {
  return {
    id: bullet.id,
    text: bullet.text,
    tags: bullet.tags,
    facts: bullet.factIds,
    ...(bullet.entry === undefined ? {} : { entry: bullet.entry }),
    ...(bullet.order === undefined ? {} : { order: bullet.order }),
  };
}

function storedFactRow(row: Record<string, unknown>): string {
  const tags = Array.isArray(row["tags"]) ? row["tags"] : [];
  const cites = Array.isArray(row["cites"]) ? row["cites"] : [];
  return canonical([
    row["id"],
    row["text"],
    tags,
    row["source"] ?? null,
    cites,
    row["estimate"] ?? null,
  ]);
}

function proposedFactRow(fact: FactProposal): string {
  return canonical([fact.id, fact.text, fact.tags, fact.source, fact.cites, fact.estimate ?? null]);
}

function bulletKey(bullet: Bullet): string {
  return canonical([
    bullet.id,
    bullet.text,
    bullet.tags,
    bullet.factIds,
    bullet.entry ?? null,
    bullet.order ?? null,
  ]);
}

function answerSlot(answer: { answerKey: string; scope: string }): string {
  return `${answer.answerKey}|${answer.scope}`;
}

function diffFacts(dir: DataDir, proposal: DossierProposal): DerivedChange[] {
  const stored = new Map(
    rowsOf(readYamlMapping(dir, "facts.yaml"), "facts").map((row) => [row["id"], row]),
  );
  const changes: DerivedChange[] = [];
  for (const fact of proposal.facts) {
    const current = stored.get(fact.id);
    if (current === undefined)
      changes.push({ file: "facts.yaml", op: "add", id: fact.id, value: fact });
    else if (storedFactRow(current) !== proposedFactRow(fact)) {
      changes.push({ file: "facts.yaml", op: "update", id: fact.id, value: fact });
    }
  }
  for (const id of proposal.removals?.facts ?? []) {
    if (stored.has(id)) changes.push({ file: "facts.yaml", op: "remove", id, value: null });
  }
  return changes;
}

function sortedMap(value: unknown): [string, unknown][] {
  return isObject(value) ? Object.entries(value).toSorted(([a], [b]) => a.localeCompare(b)) : [];
}

function listOrEmpty(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function entryKey(row: Record<string, unknown>): string {
  return canonical([
    row["id"],
    row["name"],
    row["role"] ?? null,
    row["dates"] ?? null,
    sortedMap(row["metadata"]),
    listOrEmpty(row["cites"]),
  ]);
}

function skillKey(row: Record<string, unknown>): string {
  return canonical([row["name"], listOrEmpty(row["items"]), listOrEmpty(row["cites"])]);
}

function headerKey(row: Record<string, unknown>): string {
  return canonical([row["name"], sortedMap(row["contact"]), listOrEmpty(row["cites"])]);
}

function diffRows<T extends { readonly cites: readonly string[] }>(
  section: Section,
  stored: Map<unknown, Record<string, unknown>>,
  proposed: readonly T[],
  idOf: (row: T) => string,
  keyOfStored: (row: Record<string, unknown>) => string,
  keyOfProposed: (row: T) => string,
  removed: readonly string[],
): DerivedChange[] {
  const changes: DerivedChange[] = [];
  for (const row of proposed) {
    const id = idOf(row);
    const current = stored.get(id);
    const base = { file: "facts.yaml" as const, section, id, value: row };
    if (current === undefined) changes.push({ ...base, op: "add" });
    else if (keyOfStored(current) !== keyOfProposed(row)) changes.push({ ...base, op: "update" });
  }
  for (const id of removed) {
    if (stored.has(id)) {
      changes.push({ file: "facts.yaml", section, op: "remove", id, value: null });
    }
  }
  return changes;
}

function diffCvData(dir: DataDir, proposal: DossierProposal): DerivedChange[] {
  const document = readYamlMapping(dir, "facts.yaml");
  const byKey = (key: string, idKey: string): Map<unknown, Record<string, unknown>> =>
    new Map(rowsOf(document, key).map((row) => [row[idKey], row]));
  const entryDiff = (section: "experience" | "projects"): DerivedChange[] =>
    diffRows(
      section,
      byKey(section, "id"),
      proposal[section] ?? [],
      (entry) => entry.id,
      entryKey,
      (entry) => entryKey({ ...entry }),
      proposal.removals?.[section] ?? [],
    );
  const skills = diffRows(
    "skills",
    byKey("skills", "name"),
    proposal.skills ?? [],
    (group) => group.name,
    skillKey,
    (group) => skillKey({ ...group }),
    proposal.removals?.skills ?? [],
  );
  const stored = document["profile"];
  const header = proposal.header;
  const headerChanges: DerivedChange[] = [];
  if (header !== undefined) {
    const base = { file: "facts.yaml" as const, section: "header" as const, id: HEADER_ID };
    if (!isObject(stored)) headerChanges.push({ ...base, op: "add", value: header });
    else if (headerKey(stored) !== headerKey({ ...header })) {
      headerChanges.push({ ...base, op: "update", value: header });
    }
  }
  return [...entryDiff("experience"), ...entryDiff("projects"), ...skills, ...headerChanges];
}

function diffBullets(proposal: DossierProposal, current: Bullet[]): DerivedChange[] {
  const stored = new Map(current.map((bullet) => [bullet.id, bullet]));
  const changes: DerivedChange[] = [];
  for (const bullet of proposal.bullets) {
    const existing = stored.get(bullet.id);
    if (existing === undefined)
      changes.push({ file: "bullets.yaml", op: "add", id: bullet.id, value: bullet });
    else if (bulletKey(existing) !== bulletKey(bullet)) {
      changes.push({ file: "bullets.yaml", op: "update", id: bullet.id, value: bullet });
    }
  }
  for (const id of proposal.removals?.bullets ?? []) {
    if (stored.has(id)) changes.push({ file: "bullets.yaml", op: "remove", id, value: null });
  }
  return changes;
}

function diffProfile(dir: DataDir, proposal: DossierProposal): DerivedChange[] {
  const current = readYamlMapping(dir, "profile.yaml");
  return Object.entries(proposal.profile).flatMap<DerivedChange>(([key, value]) => {
    if (!Object.hasOwn(current, key))
      return [{ file: "profile.yaml" as const, op: "add" as const, id: key, value }];
    if (canonical(current[key]) === canonical(value)) return [];
    return [{ file: "profile.yaml" as const, op: "update" as const, id: key, value }];
  });
}

function diffNeverClaim(proposal: DossierProposal, current: string[]): DerivedChange[] {
  return [...new Set(proposal.neverClaim)]
    .filter((term) => !current.includes(term))
    .map((term) => ({
      file: "never-claim.yaml" as const,
      op: "add" as const,
      id: term,
      value: term,
    }));
}

function diffAnswers(proposal: DossierProposal, current: StoredAnswer[]): DerivedChange[] {
  const stored = new Map(current.map((answer) => [answerSlot(answer), answer]));
  return proposal.answers.flatMap<DerivedChange>((answer) => {
    const existing = stored.get(answerSlot(answer));
    const id = answerSlot(answer);
    if (existing === undefined)
      return [{ file: "answers.json" as const, op: "add" as const, id, value: answer }];
    if (existing.text === answer.text && existing.provenance === answer.provenance) return [];
    return [{ file: "answers.json" as const, op: "update" as const, id, value: answer }];
  });
}

function renderBatch(items: readonly DerivedChange[]): string {
  return `${JSON.stringify({ version: BATCH_VERSION, items }, null, 2)}\n`;
}

function currentFactIds(dir: DataDir): Result<string[]> {
  if (!existsSync(path.join(dir.path, "facts.yaml"))) return { ok: true, value: [] };
  const bank = loadFactBank(dir);
  return bank.ok ? { ok: true, value: bank.value.facts.map((fact) => fact.id) } : bank;
}

function currentEntryIds(dir: DataDir): Result<string[]> {
  if (!existsSync(path.join(dir.path, "facts.yaml"))) return { ok: true, value: [] };
  const bank = loadFactBank(dir);
  if (!bank.ok) return bank;
  const entries = [...(bank.value.experience ?? []), ...(bank.value.projects ?? [])];
  return { ok: true, value: entries.map((entry) => entry.id) };
}

function currentBullets(dir: DataDir): Result<Bullet[]> {
  return existsSync(path.join(dir.path, "bullets.yaml"))
    ? loadBullets(dir)
    : { ok: true, value: [] };
}

function currentNeverClaim(dir: DataDir): Result<string[]> {
  return existsSync(path.join(dir.path, "never-claim.yaml"))
    ? loadNeverClaim(dir)
    : { ok: true, value: [] };
}

function requireDataDir(ctx: CommandContext): Result<DataDir> {
  if (ctx.dataDir === null) return fail("data-dir-not-found", "no data directory found");
  return { ok: true, value: ctx.dataDir };
}

/**
 * Validates `proposal`, diffs it against the current derived files and writes an
 * Approval batch holding only the differences. Facts and bullets the proposal does not
 * mention are kept; they are removed only when listed in `removals`.
 */
export function deriveBatch(
  ctx: CommandContext,
  proposal: DossierProposal,
): Promise<Result<DerivedBatch>> {
  return Promise.resolve(deriveSync(ctx, proposal));
}

type DerivedBatch = { batchPath: string; hash: string; items: DerivedChange[] };

function deriveSync(ctx: CommandContext, proposal: DossierProposal): Result<DerivedBatch> {
  const located = requireDataDir(ctx);
  if (!located.ok) return located;
  const dir = located.value;
  try {
    const factIds = currentFactIds(dir);
    if (!factIds.ok) return factIds;
    const bullets = currentBullets(dir);
    if (!bullets.ok) return bullets;
    const neverClaim = currentNeverClaim(dir);
    if (!neverClaim.ok) return neverClaim;
    const entryIds = currentEntryIds(dir);
    if (!entryIds.ok) return entryIds;
    const valid = validateProposal(dir, proposal, factIds.value, bullets.value, entryIds.value);
    if (!valid.ok) return valid;
    const items = [
      ...diffFacts(dir, proposal),
      ...diffCvData(dir, proposal),
      ...diffBullets(proposal, bullets.value),
      ...diffProfile(dir, proposal),
      ...diffNeverClaim(proposal, neverClaim.value),
      ...diffAnswers(proposal, listAnswers(dir)),
    ];
    const content = renderBatch(items);
    const hash = approvalHash(content);
    const batchPath = path.join(dir.path, BATCH_DIRECTORY, `batch-${hash.slice(0, 16)}.json`);
    writeAtomic(batchPath, content);
    new IdempotencyMap(path.join(dir.path, BATCH_HASHES_FILE)).record(
      batchKey(dir.path, batchPath),
      hash,
    );
    return { ok: true, value: { batchPath, hash, items } };
  } catch (error) {
    return fail("dossier-derive-failed", errorMessage(error));
  }
}

function parseChange(value: unknown): DerivedChange | null {
  if (!isObject(value)) return null;
  const { file, op, id } = value;
  if (!isOneOf(DERIVED_FILES, file) || !isOneOf(OPERATIONS, op) || typeof id !== "string")
    return null;
  const section = value["section"];
  if (section === undefined) return { file, op, id, value: value["value"] };
  if (!isOneOf(SECTIONS, section) || file !== "facts.yaml") return null;
  return { file, section, op, id, value: value["value"] };
}

function parseBatch(content: string): DerivedChange[] | null {
  const parsed: unknown = JSON.parse(content);
  if (!isObject(parsed) || !Array.isArray(parsed["items"])) return null;
  const items: DerivedChange[] = [];
  for (const raw of parsed["items"]) {
    const item = parseChange(raw);
    if (item === null) return null;
    items.push(item);
  }
  return items;
}

type Rendered = { readonly content: string; readonly applied: number };

function loadDocument(dir: DataDir, file: string): Document {
  const target = path.join(dir.path, file);
  if (!existsSync(target)) return new Document({});
  const document = parseDocument(readFileSync(target, "utf8"));
  if (document.errors.length > 0) throw new Error(document.errors[0]?.message);
  if (document.contents === null) {
    const fresh = new Document({});
    fresh.commentBefore = document.commentBefore;
    fresh.comment = document.comment;
    return fresh;
  }
  return isMap(document.contents) ? document : new Document({});
}

function sequenceAt(document: Document, key: string): YAMLSeq {
  const existing = document.get(key, true);
  if (isSeq(existing)) {
    existing.flow = false;
    return existing;
  }
  const created = document.createNode([]);
  document.set(key, created);
  return created;
}

function findRowIndex(sequence: YAMLSeq, id: string, idKey: string): number {
  return sequence.items.findIndex((item) => isMap(item) && item.get(idKey) === id);
}

/**
 * Adds, merges or removes one row. `clearable` names optional keys a row replaces as a
 * whole: a key the new row leaves out is deleted from the stored row.
 */
function upsertRow(
  document: Document,
  sequence: YAMLSeq,
  change: DerivedChange,
  row: Record<string, unknown>,
  clearable: readonly string[],
  idKey: string,
): boolean {
  const index = findRowIndex(sequence, change.id, idKey);
  if (change.op === "remove") {
    if (index === -1) return false;
    sequence.items.splice(index, 1);
    return true;
  }
  if (index === -1) {
    sequence.add(document.createNode(row));
    return true;
  }
  const existing = sequence.items[index];
  if (!isMap(existing)) return false;
  const current: unknown = existing.toJS(document);
  const cleared = clearable.filter((name) => !(name in row) && existing.has(name));
  const merged = { ...(isObject(current) ? current : {}), ...row };
  for (const name of cleared) delete merged[name];
  if (canonical(merged) === canonical(current)) return false;
  for (const [name, value] of Object.entries(row)) existing.set(name, value);
  for (const name of cleared) existing.delete(name);
  return true;
}

function serialize(document: Document): string {
  return document.toString({ lineWidth: 0 });
}

type RowShape = {
  readonly toRow: (value: unknown) => Record<string, unknown>;
  readonly clearable: readonly string[];
  readonly idKey: string;
};

function applyRows(
  document: Document,
  key: string,
  changes: readonly DerivedChange[],
  shape: RowShape,
): number {
  const sequence = sequenceAt(document, key);
  let applied = 0;
  for (const change of changes) {
    const row = change.op === "remove" ? {} : shape.toRow(change.value);
    if (upsertRow(document, sequence, change, row, shape.clearable, shape.idKey)) applied += 1;
  }
  return applied;
}

function renderBullets(dir: DataDir, changes: readonly DerivedChange[]): Rendered {
  const document = loadDocument(dir, "bullets.yaml");
  const applied = applyRows(document, "bullets", changes, {
    toRow: toBulletRow,
    clearable: [],
    idKey: "id",
  });
  return { content: serialize(document), applied };
}

function applyHeader(document: Document, changes: readonly DerivedChange[]): number {
  let applied = 0;
  for (const change of changes) {
    if (change.op === "remove") continue;
    const row = toHeaderRow(change.value);
    const current: unknown = document.get("profile", true);
    const currentValue: unknown = isMap(current) ? current.toJS(document) : undefined;
    if (canonical(currentValue) === canonical(row)) continue;
    document.set("profile", document.createNode(row));
    applied += 1;
  }
  return applied;
}

const FACT_SECTIONS: Record<Exclude<Section, "header">, RowShape & { readonly key: string }> = {
  facts: { key: "facts", toRow: toFactRow, clearable: ["estimate"], idKey: "id" },
  experience: { key: "experience", toRow: toEntryRow, clearable: ["role", "dates"], idKey: "id" },
  projects: { key: "projects", toRow: toEntryRow, clearable: ["role", "dates"], idKey: "id" },
  skills: { key: "skills", toRow: toSkillRow, clearable: [], idKey: "name" },
};

function renderFacts(dir: DataDir, changes: readonly DerivedChange[]): Rendered {
  const document = loadDocument(dir, "facts.yaml");
  let applied = 0;
  for (const section of SECTIONS) {
    const sectionChanges = changes.filter((change) => (change.section ?? "facts") === section);
    if (sectionChanges.length === 0) continue;
    applied +=
      section === "header"
        ? applyHeader(document, sectionChanges)
        : applyRows(document, FACT_SECTIONS[section].key, sectionChanges, FACT_SECTIONS[section]);
  }
  return { content: serialize(document), applied };
}

function renderProfile(dir: DataDir, changes: readonly DerivedChange[]): Rendered {
  const document = loadDocument(dir, "profile.yaml");
  let applied = 0;
  for (const change of changes) {
    const current: unknown = document.get(change.id, true);
    const currentValue: unknown =
      isMap(current) || isSeq(current) ? current.toJS(document) : document.get(change.id);
    if (canonical(currentValue) === canonical(change.value)) continue;
    document.set(change.id, change.value);
    applied += 1;
  }
  return { content: serialize(document), applied };
}

function renderNeverClaim(dir: DataDir, changes: readonly DerivedChange[]): Rendered {
  const document = loadDocument(dir, "never-claim.yaml");
  const sequence = sequenceAt(document, "terms");
  const stored: unknown = sequence.toJS(document);
  const terms = new Set<unknown>(Array.isArray(stored) ? stored : []);
  let applied = 0;
  for (const change of changes) {
    if (terms.has(change.id)) continue;
    sequence.add(change.id);
    terms.add(change.id);
    applied += 1;
  }
  return { content: serialize(document), applied };
}

function toStoredAnswer(value: unknown): StoredAnswer {
  if (!isObject(value)) throw new TypeError("answer item is not an object");
  const { answerKey, scope, text, provenance } = value;
  if (
    typeof answerKey !== "string" ||
    typeof scope !== "string" ||
    typeof text !== "string" ||
    typeof provenance !== "string"
  ) {
    throw new TypeError("answer item is malformed");
  }
  return { answerKey, scope, text, provenance };
}

function renderAnswers(dir: DataDir, changes: readonly DerivedChange[]): Rendered {
  const rows = listAnswers(dir);
  let applied = 0;
  for (const change of changes) {
    const answer = toStoredAnswer(change.value);
    const index = rows.findIndex((row) => answerSlot(row) === answerSlot(answer));
    if (index === -1) rows.push(answer);
    else if (canonical(rows[index]) === canonical(answer)) continue;
    else rows[index] = answer;
    applied += 1;
  }
  return { content: `${JSON.stringify(rows, null, 2)}\n`, applied };
}

function toFactRow(value: unknown): Record<string, unknown> {
  if (
    !isObject(value) ||
    !Array.isArray(value["cites"]) ||
    !isOneOf(DOSSIER_SOURCES, value["source"])
  ) {
    throw new TypeError("fact item is malformed");
  }
  return {
    id: value["id"],
    text: value["text"],
    tags: value["tags"],
    source: value["source"],
    cites: value["cites"],
    ...(typeof value["estimate"] === "string" ? { estimate: value["estimate"] } : {}),
  };
}

function stringEntries(value: unknown): Record<string, string> {
  if (!isObject(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, String(item)]));
}

function toEntryRow(value: unknown): Record<string, unknown> {
  if (
    !isObject(value) ||
    typeof value["id"] !== "string" ||
    typeof value["name"] !== "string" ||
    !Array.isArray(value["cites"])
  ) {
    throw new TypeError("entry item is malformed");
  }
  return {
    id: value["id"],
    name: value["name"],
    ...(typeof value["role"] === "string" ? { role: value["role"] } : {}),
    ...(typeof value["dates"] === "string" ? { dates: value["dates"] } : {}),
    metadata: stringEntries(value["metadata"]),
    cites: value["cites"],
  };
}

function toSkillRow(value: unknown): Record<string, unknown> {
  if (
    !isObject(value) ||
    typeof value["name"] !== "string" ||
    !Array.isArray(value["items"]) ||
    !Array.isArray(value["cites"])
  ) {
    throw new TypeError("skills item is malformed");
  }
  return { name: value["name"], items: value["items"].map(String), cites: value["cites"] };
}

function toHeaderRow(value: unknown): Record<string, unknown> {
  if (!isObject(value) || typeof value["name"] !== "string" || !Array.isArray(value["cites"])) {
    throw new TypeError("header item is malformed");
  }
  return { name: value["name"], contact: stringEntries(value["contact"]), cites: value["cites"] };
}

function toBulletRow(value: unknown): Record<string, unknown> {
  if (!isObject(value) || typeof value["id"] !== "string" || !Array.isArray(value["factIds"])) {
    throw new TypeError("bullet item is malformed");
  }
  return bulletRow({
    id: value["id"],
    text: String(value["text"]),
    tags: Array.isArray(value["tags"]) ? value["tags"].map(String) : [],
    factIds: value["factIds"].map(String),
    ...(typeof value["entry"] === "string" ? { entry: value["entry"] } : {}),
    ...(typeof value["order"] === "number" ? { order: value["order"] } : {}),
  });
}

function renderAll(dir: DataDir, items: readonly DerivedChange[]): Map<DerivedFile, Rendered> {
  const rendered = new Map<DerivedFile, Rendered>();
  for (const file of DERIVED_FILES) {
    const changes = items.filter((item) => item.file === file);
    if (changes.length === 0) continue;
    if (file === "facts.yaml") rendered.set(file, renderFacts(dir, changes));
    else if (file === "bullets.yaml") rendered.set(file, renderBullets(dir, changes));
    else if (file === "profile.yaml") rendered.set(file, renderProfile(dir, changes));
    else if (file === "never-claim.yaml") rendered.set(file, renderNeverClaim(dir, changes));
    else rendered.set(file, renderAnswers(dir, changes));
  }
  return rendered;
}

function applyItems(dir: DataDir, items: readonly DerivedChange[]): Result<{ applied: number }> {
  const rendered = renderAll(dir, items);
  let applied = 0;
  for (const [file, output] of rendered) {
    if (output.applied === 0) continue;
    writeAtomic(path.join(dir.path, file), output.content);
    applied += output.applied;
  }
  return { ok: true, value: { applied } };
}

/**
 * Applies an Approval batch under a lock. An edited batch fails `batch-changed` before
 * any derived file is touched; applying an already applied batch changes nothing.
 */
export async function applyDossierBatch(
  ctx: CommandContext,
  batchPath: string,
): Promise<Result<{ applied: number }>> {
  const located = requireDataDir(ctx);
  if (!located.ok) return located;
  const dir = located.value;
  const resolved = path.resolve(ctx.cwd, batchPath);
  try {
    if (!existsSync(resolved)) return fail("batch-not-found", `no batch file at ${resolved}`);
    const content = readFileSync(resolved, "utf8");
    const expected = lookupBatchHash(
      new IdempotencyMap(path.join(dir.path, BATCH_HASHES_FILE)),
      dir.path,
      resolved,
    );
    if (expected === null)
      return fail("batch-changed", `${resolved} was not derived by this data dir`);
    if (approvalHash(content) !== expected) {
      return fail("batch-changed", `${resolved} changed after it was derived; derive again`);
    }
    const items = parseBatch(content);
    if (items === null) return fail("batch-changed", `${resolved} is not a valid batch`);
    return await withLock(path.join(dir.path, LOCK_DIRECTORY), () =>
      Promise.resolve(applyItems(dir, items)),
    );
  } catch (error) {
    return fail("dossier-apply-failed", errorMessage(error));
  }
}
