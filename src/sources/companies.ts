import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { writeAtomic, withLock } from "../core/fs.ts";
import { errorMessage, isObject } from "../core/narrow.ts";
import type { DataDir, Result } from "../core/types.ts";
import type { AtsRef } from "./detect.ts";

const COMPANIES_FILE = "companies.json";

type CompanyOrigin = "manual" | "discovered";

export type SavedCompany = AtsRef & {
  readonly origin: CompanyOrigin;
  readonly checkedAt?: string;
};

export function readCompanies(dir: DataDir): Result<SavedCompany[]> {
  const file = path.join(dir.path, COMPANIES_FILE);
  if (!existsSync(file)) return { ok: true, value: [] };
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    const list = isObject(parsed) ? parsed["companies"] : undefined;
    if (!Array.isArray(list)) throw new Error("expected an object with a companies array");
    const entries: SavedCompany[] = [];
    for (const entry of list) {
      if (
        !isObject(entry) ||
        typeof entry["ats"] !== "string" ||
        typeof entry["slug"] !== "string"
      ) {
        throw new Error("every company needs string ats and slug fields");
      }
      const origin = entry["origin"];
      if (origin !== undefined && origin !== "manual" && origin !== "discovered") {
        throw new Error("company origin must be manual or discovered");
      }
      const checkedAt = entry["checkedAt"];
      if (checkedAt !== undefined && typeof checkedAt !== "string") {
        throw new Error("company checkedAt must be a string");
      }
      entries.push({
        ats: entry["ats"],
        slug: entry["slug"],
        origin: origin ?? "manual",
        ...(checkedAt === undefined ? {} : { checkedAt }),
      });
    }
    return { ok: true, value: entries };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "companies-malformed",
        message: `${COMPANIES_FILE} is invalid: ${errorMessage(error)}`,
      },
    };
  }
}

export type AddOutcome = { readonly added: boolean; readonly company: SavedCompany };

/**
 * Replaces the Saved companies with what `update` derives from the current list, reading and
 * writing inside one lock so a concurrent `company add` is never lost.
 */
export async function updateCompanies(
  dir: DataDir,
  update: (current: readonly SavedCompany[]) => SavedCompany[],
): Promise<Result<SavedCompany[]>> {
  return withLock<Result<SavedCompany[]>>(dir.path, () => {
    const current = readCompanies(dir);
    if (!current.ok) return Promise.resolve(current);
    const companies = update(current.value);
    writeAtomic(path.join(dir.path, COMPANIES_FILE), `${JSON.stringify({ companies }, null, 2)}\n`);
    return Promise.resolve({ ok: true as const, value: companies });
  });
}

export async function addCompany(dir: DataDir, company: AtsRef): Promise<Result<AddOutcome>> {
  const saved: SavedCompany = { ats: company.ats, slug: company.slug, origin: "manual" };
  return withLock<Result<AddOutcome>>(dir.path, () => {
    const current = readCompanies(dir);
    if (!current.ok) return Promise.resolve(current);
    const known = current.value.some(
      (entry) => entry.ats === company.ats && entry.slug === company.slug,
    );
    if (!known) {
      const next = [...current.value, saved];
      writeAtomic(
        path.join(dir.path, COMPANIES_FILE),
        `${JSON.stringify({ companies: next }, null, 2)}\n`,
      );
    }
    return Promise.resolve({ ok: true as const, value: { added: !known, company: saved } });
  });
}
