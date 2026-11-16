import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";

import { withLock, writeAtomic } from "../core/fs.ts";
import { errorMessage, isObject, isOneOf } from "../core/narrow.ts";
import {
  CONTACT_CHANNELS,
  EMAIL_CONFIDENCES,
  type ApplicationState,
  type ContactDetail,
  type ContactRecentItem,
  type DataDir,
  type HuntEvent,
  type Result,
} from "../core/types.ts";
import { appendEvent, readEvents } from "../ledger/events.ts";
import { foldState } from "../ledger/state.ts";

const MAX_CONTACTS_PER_LEAD = 3;
const RETENTION_DAYS = 90;

const CONTACTS_DIRECTORY = "contacts";
const LOCK_DIRECTORY = ".contacts";
const CLOSED_STATES: ReadonlySet<ApplicationState> = new Set([
  "rejected",
  "withdrawn",
  "discarded",
  "hired",
]);
const DAY_MS = 86_400_000;
const CONTACT_FIELDS = new Set([
  "name",
  "role",
  "channel",
  "profileUrl",
  "email",
  "emailConfidence",
  "sources",
  "recentItems",
  "doNotContact",
]);

function invalid(message: string): Result<never> {
  return { ok: false, error: { code: "invalid-contact", message } };
}

function internal(error: unknown): Result<never> {
  return { ok: false, error: { code: "internal", message: errorMessage(error) } };
}

function contactsFile(dir: DataDir, key: string): string {
  return path.join(dir.path, CONTACTS_DIRECTORY, `${encodeURIComponent(key)}.json`);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function parseRecentItem(value: unknown, where: string): Result<ContactRecentItem> {
  if (!isObject(value)) return invalid(`${where} must be an object`);
  const { date, url, summary } = value;
  if (!nonEmptyString(date) || !nonEmptyString(url) || !nonEmptyString(summary)) {
    return invalid(`${where} needs non-empty date, url and summary`);
  }
  return { ok: true, value: { date, url, summary } };
}

function parseSources(value: unknown, where: string): Result<string[]> {
  if (!Array.isArray(value)) return invalid(`${where}.sources must be an array`);
  const sources: string[] = [];
  for (const source of value) {
    if (!nonEmptyString(source)) return invalid(`${where}.sources must hold non-empty strings`);
    sources.push(source);
  }
  return { ok: true, value: sources };
}

function parseRecentItems(value: unknown, where: string): Result<ContactRecentItem[]> {
  if (!Array.isArray(value)) return invalid(`${where}.recentItems must be an array`);
  const items: ContactRecentItem[] = [];
  for (const [index, entry] of value.entries()) {
    const item = parseRecentItem(entry, `${where}.recentItems[${index}]`);
    if (!item.ok) return item;
    items.push(item.value);
  }
  return { ok: true, value: items };
}

function parseOptionalText(
  record: Record<string, unknown>,
  field: "profileUrl" | "email",
  where: string,
): Result<string | undefined> {
  const value = record[field];
  if (value === undefined) return { ok: true, value: undefined };
  if (!nonEmptyString(value)) return invalid(`${where}.${field} must be a non-empty string`);
  return { ok: true, value };
}

function parseContact(value: unknown, index: number): Result<ContactDetail> {
  const where = `contact ${index + 1}`;
  if (!isObject(value)) return invalid(`${where} must be an object`);
  const unknownField = Object.keys(value).find((field) => !CONTACT_FIELDS.has(field));
  if (unknownField !== undefined) return invalid(`${where} has unknown field ${unknownField}`);
  const { name, role, channel, emailConfidence, doNotContact } = value;
  if (!nonEmptyString(name) || !nonEmptyString(role)) {
    return invalid(`${where} needs a non-empty name and role`);
  }
  if (!isOneOf(CONTACT_CHANNELS, channel)) {
    return invalid(`${where}.channel must be linkedin or email`);
  }
  if (emailConfidence !== undefined && !isOneOf(EMAIL_CONFIDENCES, emailConfidence)) {
    return invalid(`${where}.emailConfidence must be published, pattern or guess`);
  }
  if (doNotContact !== undefined && typeof doNotContact !== "boolean") {
    return invalid(`${where}.doNotContact must be a boolean`);
  }
  const profileUrl = parseOptionalText(value, "profileUrl", where);
  if (!profileUrl.ok) return profileUrl;
  const email = parseOptionalText(value, "email", where);
  if (!email.ok) return email;
  if (email.value !== undefined && emailConfidence === undefined) {
    return invalid(`${where} has an email without emailConfidence`);
  }
  if (email.value === undefined && emailConfidence !== undefined) {
    return invalid(`${where} has emailConfidence without an email`);
  }
  const sources = parseSources(value["sources"], where);
  if (!sources.ok) return sources;
  const recentItems = parseRecentItems(value["recentItems"], where);
  if (!recentItems.ok) return recentItems;
  return {
    ok: true,
    value: {
      name,
      role,
      channel,
      ...(profileUrl.value === undefined ? {} : { profileUrl: profileUrl.value }),
      ...(email.value === undefined ? {} : { email: email.value }),
      ...(emailConfidence === undefined ? {} : { emailConfidence }),
      sources: sources.value,
      recentItems: recentItems.value,
      ...(doNotContact === undefined ? {} : { doNotContact }),
    },
  };
}

/** Validates a parsed JSON document against `schema/contact.schema.json`. */
export function parseContacts(value: unknown): Result<ContactDetail[]> {
  if (!Array.isArray(value)) return invalid("contacts must be a JSON array");
  if (value.length > MAX_CONTACTS_PER_LEAD) {
    return invalid(`at most ${MAX_CONTACTS_PER_LEAD} contacts per lead, got ${value.length}`);
  }
  const contacts: ContactDetail[] = [];
  for (const [index, entry] of value.entries()) {
    const contact = parseContact(entry, index);
    if (!contact.ok) return contact;
    contacts.push(contact.value);
  }
  return { ok: true, value: contacts };
}

/** Reads the full Contact detail recorded for a Lead; empty when none. */
export function readContacts(dir: DataDir, key: string): Promise<Result<ContactDetail[]>> {
  try {
    const file = contactsFile(dir, key);
    if (!existsSync(file)) return Promise.resolve({ ok: true, value: [] });
    return Promise.resolve(parseContacts(JSON.parse(readFileSync(file, "utf8"))));
  } catch (error) {
    return Promise.resolve(internal(error));
  }
}

/** Replaces the Lead's Contacts file and appends one `contact.found` Event per Contact. */
export async function recordContacts(
  dir: DataDir,
  key: string,
  contacts: readonly ContactDetail[],
): Promise<Result<number>> {
  try {
    return await withLock(path.join(dir.path, LOCK_DIRECTORY), async () => {
      const events = await readEvents(dir, key);
      if (!events.some((event) => event.kind === "lead.created")) {
        return {
          ok: false,
          error: { code: "lead-not-found", message: `no lead.created Event for ${key}` },
        } satisfies Result<number>;
      }
      mkdirSync(path.join(dir.path, CONTACTS_DIRECTORY), { recursive: true });
      writeAtomic(contactsFile(dir, key), `${JSON.stringify(contacts, null, 2)}\n`);
      await contacts.reduce<Promise<unknown>>(
        (previous, contact) =>
          previous.then(() =>
            appendEvent(dir, {
              kind: "contact.found",
              key,
              name: contact.name,
              role: contact.role,
              channel: contact.channel,
            }),
          ),
        Promise.resolve(),
      );
      return { ok: true, value: contacts.length } satisfies Result<number>;
    });
  } catch (error) {
    return internal(error);
  }
}

function closedAt(events: readonly HuntEvent[]): string | null {
  const state = foldState(events);
  if (state === null || !CLOSED_STATES.has(state)) return null;
  const closing = events.filter(
    (event) =>
      (event.kind === "status.changed" && event.to === state) ||
      (event.kind === "posting.dismissed" && state === "discarded"),
  );
  return closing.at(-1)?.at ?? null;
}

/** Deletes Contacts files of Leads closed more than 90 days ago; returns the deleted keys. */
export async function pruneContacts(
  dir: DataDir,
  now: Date = new Date(),
): Promise<Result<string[]>> {
  try {
    return await withLock(path.join(dir.path, LOCK_DIRECTORY), async () => {
      const folder = path.join(dir.path, CONTACTS_DIRECTORY);
      if (!existsSync(folder)) return { ok: true, value: [] } satisfies Result<string[]>;
      const events = await readEvents(dir);
      const byKey = new Map<string, HuntEvent[]>();
      for (const event of events) {
        if (event.key === undefined) continue;
        byKey.set(event.key, [...(byKey.get(event.key) ?? []), event]);
      }
      const deleted: string[] = [];
      for (const name of readdirSync(folder).filter((entry) => entry.endsWith(".json"))) {
        const key = decodeURIComponent(name.slice(0, -".json".length));
        const leadEvents = byKey.get(key);
        if (leadEvents === undefined) continue;
        const closed = closedAt(leadEvents);
        if (closed === null) continue;
        if (now.getTime() - Date.parse(closed) <= RETENTION_DAYS * DAY_MS) continue;
        rmSync(path.join(folder, name));
        deleted.push(key);
      }
      return { ok: true, value: deleted } satisfies Result<string[]>;
    });
  } catch (error) {
    return internal(error);
  }
}
