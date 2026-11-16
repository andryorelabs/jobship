import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { ANSWER_KEYS, isTierDKey } from "../apply/answer-keys.ts";
import type { StoredAnswer } from "../apply/answers.ts";
import { errorMessage, isObject, isOneOf } from "../core/narrow.ts";
import { validateProfile } from "../core/profile.ts";
import type { DataDir, Profile, Result } from "../core/types.ts";
import { findIdentityLeaks } from "../cv/lint.ts";
import type { Bullet, Entry, Fact, SkillGroup } from "../cv/types.ts";
import { DOSSIER_SOURCES, dossierLineExists, type DossierSource } from "./dossier.ts";
import { loadIdentityIfPresent } from "./identity-guard.ts";

export type FactProposal = Fact & {
  readonly source: DossierSource;
  readonly cites: readonly string[];
};

type EntryProposal = Entry & { readonly cites: readonly string[] };

type SkillProposal = SkillGroup & { readonly cites: readonly string[] };

interface HeaderProposal {
  readonly name: string;
  readonly contact: Readonly<Record<string, string>>;
  readonly cites: readonly string[];
}

interface Removals {
  readonly facts: string[];
  readonly bullets: string[];
  readonly experience?: string[];
  readonly projects?: string[];
  readonly skills?: string[];
}

export interface DossierProposal {
  readonly facts: FactProposal[];
  readonly bullets: Bullet[];
  readonly profile: Partial<Profile>;
  readonly neverClaim: string[];
  readonly answers: StoredAnswer[];
  readonly experience?: EntryProposal[];
  readonly projects?: EntryProposal[];
  readonly skills?: SkillProposal[];
  readonly header?: HeaderProposal;
  readonly removals?: Removals;
}

const PROFILE_FILE = "profile.yaml";
const PROPOSABLE_PROFILE_KEYS = new Set([
  "regions",
  "contractTypes",
  "remote",
  "stack",
  "salaryFloor",
  "excludedCompanies",
  "outreachDailyCap",
  "sources",
]);

function invalid(message: string): { ok: false; error: { code: string; message: string } } {
  return { ok: false, error: { code: "proposal-invalid", message } };
}

function stringList(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const items: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return null;
    items.push(item);
  }
  return items;
}

function objectList(value: unknown, field: string): Result<Record<string, unknown>[]> {
  if (value === undefined) return { ok: true, value: [] };
  if (!Array.isArray(value) || !value.every(isObject)) {
    return invalid(`${field} must be a list of objects`);
  }
  return { ok: true, value: value.filter(isObject) };
}

function parseFacts(value: unknown): Result<FactProposal[]> {
  const rows = objectList(value, "facts");
  if (!rows.ok) return rows;
  const facts: FactProposal[] = [];
  for (const [index, row] of rows.value.entries()) {
    const { id, text, source, estimate } = row;
    const tags = stringList(row.tags);
    const cites = stringList(row.cites);
    if (typeof id !== "string" || id === "" || typeof text !== "string" || text.trim() === "") {
      return invalid(`facts[${index}] needs a non-empty string id and text`);
    }
    if (tags === null) return invalid(`fact ${id}: tags must be a list of strings`);
    if (cites === null || cites.length === 0) {
      return invalid(`fact ${id}: cites must list at least one dossier/<section>.md:<line>`);
    }
    if (!isOneOf(DOSSIER_SOURCES, source)) {
      return invalid(`fact ${id}: source must be one of ${DOSSIER_SOURCES.join(", ")}`);
    }
    if (estimate !== undefined && (typeof estimate !== "string" || estimate.trim() === "")) {
      return invalid(`fact ${id}: estimate must be a non-empty string`);
    }
    facts.push({ id, text, tags, source, cites, ...(estimate === undefined ? {} : { estimate }) });
  }
  return { ok: true, value: facts };
}

function parseBullets(value: unknown): Result<Bullet[]> {
  const rows = objectList(value, "bullets");
  if (!rows.ok) return rows;
  const bullets: Bullet[] = [];
  for (const [index, row] of rows.value.entries()) {
    const { id, text, entry, order } = row;
    const tags = stringList(row.tags);
    const factIds = stringList(row.factIds);
    if (typeof id !== "string" || id === "" || typeof text !== "string" || text.trim() === "") {
      return invalid(`bullets[${index}] needs a non-empty string id and text`);
    }
    if (tags === null || factIds === null) {
      return invalid(`bullet ${id}: tags and factIds must be lists of strings`);
    }
    if (entry !== undefined && typeof entry !== "string") {
      return invalid(`bullet ${id}: entry must be a string`);
    }
    if (order !== undefined && (typeof order !== "number" || !Number.isFinite(order))) {
      return invalid(`bullet ${id}: order must be a number`);
    }
    bullets.push({
      id,
      text,
      tags,
      factIds,
      ...(entry === undefined ? {} : { entry }),
      ...(order === undefined ? {} : { order }),
    });
  }
  return { ok: true, value: bullets };
}

function stringMap(value: unknown): Record<string, string> | null {
  if (value === undefined) return {};
  if (!isObject(value)) return null;
  const map: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") return null;
    map[key] = item;
  }
  return map;
}

function requiredCites(value: unknown, label: string): Result<string[]> {
  const cites = stringList(value);
  if (cites === null || cites.length === 0) {
    return invalid(`${label}: cites must list at least one dossier/<section>.md:<line>`);
  }
  return { ok: true, value: cites };
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function parseEntries(value: unknown, field: string): Result<EntryProposal[]> {
  const rows = objectList(value, field);
  if (!rows.ok) return rows;
  const entries: EntryProposal[] = [];
  for (const [index, row] of rows.value.entries()) {
    const { id, name, role, dates } = row;
    if (typeof id !== "string" || id === "" || typeof name !== "string" || name.trim() === "") {
      return invalid(`${field}[${index}] needs a non-empty string id and name`);
    }
    if (!optionalString(role) || !optionalString(dates)) {
      return invalid(`${field} entry ${id}: role and dates must be strings`);
    }
    const metadata = stringMap(row.metadata);
    if (metadata === null) {
      return invalid(`${field} entry ${id}: metadata must map names to strings`);
    }
    const cites = requiredCites(row.cites, `${field} entry ${id}`);
    if (!cites.ok) return cites;
    entries.push({
      id,
      name,
      ...(role === undefined ? {} : { role }),
      ...(dates === undefined ? {} : { dates }),
      metadata,
      cites: cites.value,
    });
  }
  return { ok: true, value: entries };
}

function parseSkills(value: unknown): Result<SkillProposal[]> {
  const rows = objectList(value, "skills");
  if (!rows.ok) return rows;
  const groups: SkillProposal[] = [];
  for (const [index, row] of rows.value.entries()) {
    const { name } = row;
    if (typeof name !== "string" || name.trim() === "") {
      return invalid(`skills[${index}] needs a non-empty string name`);
    }
    const items = stringList(row.items);
    if (items === null) return invalid(`skills group ${name}: items must be a list of strings`);
    const cites = requiredCites(row.cites, `skills group ${name}`);
    if (!cites.ok) return cites;
    groups.push({ name, items, cites: cites.value });
  }
  return { ok: true, value: groups };
}

function parseHeader(value: unknown): Result<HeaderProposal | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  if (!isObject(value)) return invalid("header must be an object");
  const { name } = value;
  if (typeof name !== "string" || name.trim() === "") {
    return invalid("header needs a non-empty string name");
  }
  const contact = stringMap(value.contact);
  if (contact === null) return invalid("header contact must map names to strings");
  const cites = requiredCites(value.cites, "header");
  if (!cites.ok) return cites;
  return { ok: true, value: { name, contact, cites: cites.value } };
}

function parseAnswers(value: unknown): Result<StoredAnswer[]> {
  const rows = objectList(value, "answers");
  if (!rows.ok) return rows;
  const answers: StoredAnswer[] = [];
  for (const [index, row] of rows.value.entries()) {
    const { answerKey, scope, text, provenance } = row;
    if (
      typeof answerKey !== "string" ||
      typeof scope !== "string" ||
      scope === "" ||
      typeof text !== "string" ||
      text.trim() === "" ||
      typeof provenance !== "string"
    ) {
      return invalid(`answers[${index}] needs answerKey, scope, text and provenance strings`);
    }
    if (!ANSWER_KEYS.some((entry) => entry.key === answerKey)) {
      return invalid(`answers[${index}]: unknown Answer key "${answerKey}"`);
    }
    if (isTierDKey(answerKey)) {
      return invalid(`answers[${index}]: tier D Answer key "${answerKey}" is never stored`);
    }
    answers.push({ answerKey, scope, text, provenance });
  }
  return { ok: true, value: answers };
}

function parseProfilePart(value: unknown): Result<Partial<Profile>> {
  if (value === undefined) return { ok: true, value: {} };
  if (!isObject(value)) return invalid("profile must be an object");
  const unknown = Object.keys(value).find((key) => !PROPOSABLE_PROFILE_KEYS.has(key));
  if (unknown !== undefined) return invalid(`profile.${unknown} is not a proposable Profile field`);
  return { ok: true, value };
}

function parseRemovals(value: unknown): Result<DossierProposal["removals"]> {
  if (value === undefined) return { ok: true, value: undefined };
  if (!isObject(value)) return invalid("removals must be an object");
  const facts = stringList(value.facts);
  const bullets = stringList(value.bullets);
  const experience = stringList(value.experience);
  const projects = stringList(value.projects);
  const skills = stringList(value.skills);
  if (
    facts === null ||
    bullets === null ||
    experience === null ||
    projects === null ||
    skills === null
  ) {
    return invalid("removals lists must hold id strings");
  }
  return {
    ok: true,
    value: {
      facts,
      bullets,
      ...(value.experience === undefined ? {} : { experience }),
      ...(value.projects === undefined ? {} : { projects }),
      ...(value.skills === undefined ? {} : { skills }),
    },
  };
}

/** Parses the structure of a proposal JSON document; semantic checks live in validateProposal. */
export function parseProposal(raw: unknown): Result<DossierProposal> {
  if (!isObject(raw)) return invalid("proposal must be a JSON object");
  const facts = parseFacts(raw.facts);
  if (!facts.ok) return facts;
  const bullets = parseBullets(raw.bullets);
  if (!bullets.ok) return bullets;
  const profile = parseProfilePart(raw.profile);
  if (!profile.ok) return profile;
  const neverClaim = stringList(raw.neverClaim);
  if (neverClaim === null) return invalid("neverClaim must be a list of strings");
  const answers = parseAnswers(raw.answers);
  if (!answers.ok) return answers;
  const experience = parseEntries(raw.experience, "experience");
  if (!experience.ok) return experience;
  const projects = parseEntries(raw.projects, "projects");
  if (!projects.ok) return projects;
  const skills = parseSkills(raw.skills);
  if (!skills.ok) return skills;
  const header = parseHeader(raw.header);
  if (!header.ok) return header;
  const removals = parseRemovals(raw.removals);
  if (!removals.ok) return removals;
  return {
    ok: true,
    value: {
      facts: facts.value,
      bullets: bullets.value,
      profile: profile.value,
      neverClaim,
      answers: answers.value,
      ...(raw.experience === undefined ? {} : { experience: experience.value }),
      ...(raw.projects === undefined ? {} : { projects: projects.value }),
      ...(raw.skills === undefined ? {} : { skills: skills.value }),
      ...(header.value === undefined ? {} : { header: header.value }),
      ...(removals.value === undefined ? {} : { removals: removals.value }),
    },
  };
}

function duplicate(ids: readonly string[]): string | undefined {
  return ids.find((id, index) => ids.indexOf(id) !== index);
}

function checkProfile(dir: DataDir, part: Partial<Profile>): Result<void> {
  if (Object.keys(part).length === 0) return { ok: true, value: undefined };
  const file = path.join(dir.path, PROFILE_FILE);
  let current: unknown = {};
  try {
    if (existsSync(file)) current = Bun.YAML.parse(readFileSync(file, "utf8"));
  } catch (error) {
    return invalid(`${PROFILE_FILE} is not valid YAML: ${errorMessage(error)}`);
  }
  const merged = { ...(isObject(current) ? current : {}), ...part };
  const checked = validateProfile(merged);
  return checked.ok ? { ok: true, value: undefined } : invalid(checked.error.message);
}

/**
 * Finds a bullet that would still cite a removed fact once the proposal is applied:
 * stored bullets not removed and not replaced, plus every proposed bullet.
 */
function orphanedCitation(
  proposal: DossierProposal,
  storedBullets: readonly Bullet[],
): { bullet: string; fact: string } | undefined {
  const removedFacts = new Set(proposal.removals?.facts ?? []);
  if (removedFacts.size === 0) return undefined;
  const removedBullets = new Set(proposal.removals?.bullets ?? []);
  const proposedIds = new Set(proposal.bullets.map((bullet) => bullet.id));
  const resulting = [
    ...storedBullets.filter(
      (bullet) => !removedBullets.has(bullet.id) && !proposedIds.has(bullet.id),
    ),
    ...proposal.bullets.filter((bullet) => !removedBullets.has(bullet.id)),
  ];
  for (const bullet of resulting) {
    const fact = bullet.factIds.find((id) => removedFacts.has(id));
    if (fact !== undefined) return { bullet: bullet.id, fact };
  }
  return undefined;
}

function proposedEntries(proposal: DossierProposal): EntryProposal[] {
  return [...(proposal.experience ?? []), ...(proposal.projects ?? [])];
}

/** Entry ids stored in facts.yaml, per section. */
export interface StoredEntryIds {
  readonly experience: readonly string[];
  readonly projects: readonly string[];
}

const NO_STORED_ENTRIES: StoredEntryIds = { experience: [], projects: [] };

/**
 * Finds an Entry id proposed in one section while it stays stored in the other, which
 * would leave the same Entry id under both `experience` and `projects`.
 */
function crossSectionEntry(
  proposal: DossierProposal,
  storedEntryIds: StoredEntryIds,
): string | undefined {
  const sections = [
    { proposed: proposal.experience ?? [], other: "projects" },
    { proposed: proposal.projects ?? [], other: "experience" },
  ] as const;
  for (const { proposed, other } of sections) {
    const removed = new Set(proposal.removals?.[other] ?? []);
    const stored = new Set(storedEntryIds[other].filter((id) => !removed.has(id)));
    const clash = proposed.find((entry) => stored.has(entry.id));
    if (clash !== undefined) return clash.id;
  }
  return undefined;
}

/**
 * Finds a bullet whose Entry would be missing once the proposal is applied: stored
 * Entries not removed plus proposed ones, against stored and proposed bullets that remain.
 */
function missingEntry(
  proposal: DossierProposal,
  storedBullets: readonly Bullet[],
  storedEntryIds: StoredEntryIds,
): { bullet: string; entry: string } | undefined {
  const removedEntries = new Set([
    ...(proposal.removals?.experience ?? []),
    ...(proposal.removals?.projects ?? []),
  ]);
  const entries = new Set([
    ...[...storedEntryIds.experience, ...storedEntryIds.projects].filter(
      (id) => !removedEntries.has(id),
    ),
    ...proposedEntries(proposal).map((entry) => entry.id),
  ]);
  const removedBullets = new Set(proposal.removals?.bullets ?? []);
  const proposedIds = new Set(proposal.bullets.map((bullet) => bullet.id));
  const resulting = [
    ...storedBullets.filter(
      (bullet) => !removedBullets.has(bullet.id) && !proposedIds.has(bullet.id),
    ),
    ...proposal.bullets.filter((bullet) => !removedBullets.has(bullet.id)),
  ];
  for (const bullet of resulting) {
    if (bullet.entry !== undefined && !entries.has(bullet.entry)) {
      return { bullet: bullet.id, entry: bullet.entry };
    }
  }
  return undefined;
}

function cvDataTexts(proposal: DossierProposal): { label: string; text: string }[] {
  const texts = proposedEntries(proposal).flatMap((entry) => {
    const label = `entry ${entry.id}`;
    const values = [
      entry.name,
      entry.role ?? "",
      entry.dates ?? "",
      ...Object.values(entry.metadata),
    ];
    return values.filter((text) => text !== "").map((text) => ({ label, text }));
  });
  for (const group of proposal.skills ?? []) {
    const label = `skills group ${group.name}`;
    texts.push({ label, text: group.name }, ...group.items.map((text) => ({ label, text })));
  }
  if (proposal.header !== undefined) {
    texts.push(
      { label: "header", text: proposal.header.name },
      ...Object.values(proposal.header.contact).map((text) => ({ label: "header", text })),
    );
  }
  return texts;
}

function checkCvData(dir: DataDir, proposal: DossierProposal): Result<void> {
  const repeatedEntry = duplicate(proposedEntries(proposal).map((entry) => entry.id));
  if (repeatedEntry !== undefined) return invalid(`entry id "${repeatedEntry}" is proposed twice`);
  const repeatedGroup = duplicate((proposal.skills ?? []).map((group) => group.name));
  if (repeatedGroup !== undefined) {
    return invalid(`skills group "${repeatedGroup}" is proposed twice`);
  }
  const cited: { label: string; cites: readonly string[] }[] = [
    ...proposedEntries(proposal).map((entry) => ({
      label: `entry ${entry.id}`,
      cites: entry.cites,
    })),
    ...(proposal.skills ?? []).map((group) => ({
      label: `skills group ${group.name}`,
      cites: group.cites,
    })),
    ...(proposal.header === undefined ? [] : [{ label: "header", cites: proposal.header.cites }]),
  ];
  for (const { label, cites } of cited) {
    const missing = cites.find((ref) => !dossierLineExists(dir, ref));
    if (missing !== undefined) {
      return invalid(`${label}: citation ${missing} does not name a Dossier line`);
    }
  }
  return { ok: true, value: undefined };
}

/**
 * Checks citations, identity values, Fact bank references, Answer keys and the merged
 * Profile. A tier B, C or D identity value in a fact or bullet fails `identity-leak`.
 */
export function validateProposal(
  dir: DataDir,
  proposal: DossierProposal,
  knownFactIds: readonly string[],
  storedBullets: readonly Bullet[] = [],
  storedEntryIds: StoredEntryIds = NO_STORED_ENTRIES,
): Result<void> {
  const repeatedFact = duplicate(proposal.facts.map((fact) => fact.id));
  if (repeatedFact !== undefined) return invalid(`fact id "${repeatedFact}" is proposed twice`);
  const repeatedBullet = duplicate(proposal.bullets.map((bullet) => bullet.id));
  if (repeatedBullet !== undefined)
    return invalid(`bullet id "${repeatedBullet}" is proposed twice`);
  for (const fact of proposal.facts) {
    const missing = fact.cites.find((ref) => !dossierLineExists(dir, ref));
    if (missing !== undefined) {
      return invalid(`fact ${fact.id}: citation ${missing} does not name a Dossier line`);
    }
  }
  const available = new Set([...knownFactIds, ...proposal.facts.map((fact) => fact.id)]);
  for (const bullet of proposal.bullets) {
    const unknown = bullet.factIds.find((id) => !available.has(id));
    if (unknown !== undefined) return invalid(`bullet ${bullet.id}: unknown fact "${unknown}"`);
  }
  const orphaned = orphanedCitation(proposal, storedBullets);
  if (orphaned !== undefined) {
    return invalid(
      `bullet ${orphaned.bullet} still cites removed fact "${orphaned.fact}"; remove or update the bullet too`,
    );
  }
  const cvData = checkCvData(dir, proposal);
  if (!cvData.ok) return cvData;
  const clash = crossSectionEntry(proposal, storedEntryIds);
  if (clash !== undefined) {
    return invalid(
      `entry id "${clash}" is already stored in the other section; remove it there in the same proposal`,
    );
  }
  const absent = missingEntry(proposal, storedBullets, storedEntryIds);
  if (absent !== undefined) {
    return invalid(
      `bullet ${absent.bullet} points at missing Entry "${absent.entry}"; propose the Entry or update the bullet`,
    );
  }
  const identity = loadIdentityIfPresent(dir);
  if (!identity.ok) return identity;
  const texts = [
    ...cvDataTexts(proposal),
    ...proposal.facts.map((fact) => ({ label: `fact ${fact.id}`, text: fact.text })),
    ...proposal.bullets.map((bullet) => ({ label: `bullet ${bullet.id}`, text: bullet.text })),
  ];
  for (const { label, text } of texts) {
    const [leak] = findIdentityLeaks(text, identity.value);
    if (leak !== undefined) {
      return {
        ok: false,
        error: {
          code: "identity-leak",
          message: `${label} contains the value of identity field "${leak.field}"`,
        },
      };
    }
  }
  return checkProfile(dir, proposal.profile);
}
