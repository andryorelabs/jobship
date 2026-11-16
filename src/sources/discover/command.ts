import type { CommandContext } from "../../core/commands.ts";
import { failure, success, type Envelope } from "../../core/envelope.ts";
import { DEFAULT_LIMIT, runDiscover } from "./discover.ts";
import { findCandidates } from "./finders.ts";

const USAGE = "usage: jobship discover [--limit <n>] [--keyword <text>]";

interface ParsedArgs { readonly limit: number; readonly keyword?: string }

function parseArgs(argv: readonly string[]): ParsedArgs | null {
  let limit = DEFAULT_LIMIT;
  let keyword: string | undefined;
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (value === undefined) return null;
    if (flag === "--limit") {
      if (!/^\d+$/.test(value) || Number(value) < 1) return null;
      limit = Number(value);
    } else if (flag === "--keyword") {
      keyword = value;
    } else return null;
  }
  return keyword === undefined ? { limit } : { limit, keyword };
}

export async function run(argv: string[], ctx: CommandContext): Promise<Envelope<unknown>> {
  const args = parseArgs(argv);
  if (args === null) return failure("usage", USAGE, { recoverable: false });
  if (ctx.dataDir === null) {
    return failure("data-dir-not-found", "discover needs a data directory", {
      recoveryAction:
        "pass --data <dir>, set JOBSHIP_HOME, or run from a directory containing jobship.json",
    });
  }
  const result = await runDiscover(
    ctx.dataDir,
    {
      findCandidates,
      fetch: (input, init) => fetch(input, init),
      now: new Date(),
      env: ctx.env,
    },
    args,
  );
  if (!result.ok) return failure(result.error.code, result.error.message);
  return success(result.value);
}
