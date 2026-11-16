import { readFileSync } from "node:fs";
import path from "node:path";

import type { CommandContext } from "../core/commands.ts";
import { failure, success, type Envelope } from "../core/envelope.ts";
import { errorMessage } from "../core/narrow.ts";
import { parseContacts, pruneContacts, readContacts, recordContacts } from "./store.ts";

const USAGE =
  "usage: contact record --lead <key> --file <json> | contact list --lead <key> | contact prune";

function flagValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  return value === undefined || value.startsWith("--") ? undefined : value;
}

function usage(message: string): Envelope<never> {
  return failure("usage", `${message}; ${USAGE}`, { recoverable: false });
}

async function record(argv: readonly string[], ctx: CommandContext): Promise<Envelope<unknown>> {
  const lead = flagValue(argv, "--lead");
  const file = flagValue(argv, "--file");
  if (lead === undefined || file === undefined) return usage("--lead and --file are required");
  if (ctx.dataDir === null) return failure("data-dir-not-found", "no data dir resolved");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path.resolve(ctx.cwd, file), "utf8"));
  } catch (error) {
    return failure("not-found", `cannot read ${file}: ${errorMessage(error)}`);
  }
  const contacts = parseContacts(parsed);
  if (!contacts.ok) return failure(contacts.error.code, contacts.error.message);
  const recorded = await recordContacts(ctx.dataDir, lead, contacts.value);
  if (!recorded.ok) return failure(recorded.error.code, recorded.error.message);
  return success({ lead, recorded: recorded.value });
}

async function list(argv: readonly string[], ctx: CommandContext): Promise<Envelope<unknown>> {
  const lead = flagValue(argv, "--lead");
  if (lead === undefined) return usage("--lead is required");
  if (ctx.dataDir === null) return failure("data-dir-not-found", "no data dir resolved");
  const contacts = await readContacts(ctx.dataDir, lead);
  if (!contacts.ok) return failure(contacts.error.code, contacts.error.message);
  return success({ lead, contacts: contacts.value });
}

async function prune(ctx: CommandContext): Promise<Envelope<unknown>> {
  if (ctx.dataDir === null) return failure("data-dir-not-found", "no data dir resolved");
  const deleted = await pruneContacts(ctx.dataDir);
  if (!deleted.ok) return failure(deleted.error.code, deleted.error.message);
  return success({ deleted: deleted.value });
}

export function run(argv: string[], ctx: CommandContext): Promise<Envelope<unknown>> {
  const [subcommand, ...rest] = argv;
  if (subcommand === "record") return record(rest, ctx);
  if (subcommand === "list") return list(rest, ctx);
  if (subcommand === "prune") return prune(ctx);
  return Promise.resolve(usage("unknown or missing subcommand"));
}
