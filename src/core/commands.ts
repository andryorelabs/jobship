import type { Envelope } from "./envelope.ts";
import type { DataDir } from "./types.ts";

export interface CommandContext {
  readonly dataDir: DataDir | null;
  readonly env: Record<string, string | undefined>;
  readonly cwd: string;
}

export interface CommandModule {
  run(argv: string[], ctx: CommandContext): Promise<Envelope<unknown>>;
}

export const COMMANDS: Record<string, string> = {
  sweep: "src/sweep/command.ts",
  ingest: "src/sweep/command.ts",
  score: "src/sweep/command.ts",
  ledger: "src/ledger/command.ts",
  events: "src/ledger/command.ts",
  status: "src/ledger/command.ts",
  company: "src/sources/command.ts",
  board: "src/sources/board-command.ts",
  cv: "src/cv/command.ts",
  apply: "src/apply/command.ts",
  needs: "src/apply/command.ts",
  inbox: "src/inbox/command.ts",
  "inbox eval": "src/inbox-eval/command.ts",
  outreach: "src/outreach/command.ts",
  interview: "src/interview/command.ts",
  migrate: "src/migrate/command.ts",
  guard: "src/guard/command.ts",
  dossier: "src/dossier/command.ts",
  contact: "src/contact/command.ts",
  discover: "src/sources/discover/command.ts",
};

/** Flags each command accepts besides the global `--data`. */
export const COMMAND_FLAGS: Record<string, readonly string[]> = {
  init: ["--force", "--missing"],
  setup: [],
  doctor: [],
  sweep: ["--source", "--keyword"],
  ingest: ["--source", "--file", "--json"],
  score: ["--score", "--reason", "--liveness", "--liveness-error"],
  ledger: ["--json"],
  events: ["--json", "--key"],
  status: ["--set"],
  company: [],
  board: ["--name", "--region", "--work-mode"],
  cv: ["--file", "--requirement", "--tag", "--template", "--variant"],
  apply: [
    "--detail",
    "--dump",
    "--intended",
    "--key",
    "--list",
    "--provenance",
    "--save",
    "--scope",
  ],
  needs: [],
  inbox: ["--emails"],
  "inbox eval": ["--labels"],
  outreach: [
    "--addressee",
    "--channel",
    "--company",
    "--draft-company",
    "--file",
    "--key",
    "--recipient",
  ],
  interview: [],
  migrate: ["--project", "--team"],
  guard: ["--record", "--self-test"],
  dossier: ["--file"],
  contact: ["--lead", "--file"],
  discover: ["--limit", "--keyword"],
};

/** Flags every command accepts: the data dir, forced JSON output and no color. */
const GLOBAL_FLAGS: ReadonlySet<string> = new Set(["--data", "--json", "--no-color"]);

/** What a command does and what each of its flags means, for `--help`. */
export const COMMAND_HELP: Record<
  string,
  { readonly summary: string; readonly flags: Record<string, string> }
> = {
  init: {
    summary: "Scaffold a data dir in the working directory.",
    flags: {
      "--force": "Overwrite every scaffold file.",
      "--missing": "Write only the files that are absent.",
    },
  },
  setup: { summary: "Prepare the tools cv build needs.", flags: {} },
  doctor: { summary: "Check the data dir, the Guard and the tools.", flags: {} },
  sweep: {
    summary: "Run the Profile's Sources and create Leads.",
    flags: {
      "--source": "Run only this Source; repeatable.",
      "--keyword": "Add a search keyword; repeatable.",
    },
  },
  ingest: {
    summary: "Apply dedup and Gates to Postings from a browser Source.",
    flags: {
      "--source": "Label of the Source the Postings came from.",
      "--file": "Path to a Postings JSON file.",
      "--json": "Postings as inline JSON.",
    },
  },
  score: {
    summary: "Record a Fit score and liveness for a Lead.",
    flags: {
      "--score": "Fit score from 0 to 100.",
      "--reason": "Why the score; repeatable.",
      "--liveness": "live, closed or unknown.",
      "--liveness-error": "Error seen while checking liveness.",
    },
  },
  ledger: {
    summary: "List Postings seen or check one for duplicates.",
    flags: { "--json": "Posting JSON to check." },
  },
  events: {
    summary: "Append or list Events.",
    flags: { "--json": "Event JSON to append.", "--key": "Only Events for this key." },
  },
  status: {
    summary: "Show or set an Application state.",
    flags: { "--set": "The state to record." },
  },
  company: { summary: "Manage Company watch entries.", flags: {} },
  board: {
    summary: "Look up job boards in the catalog.",
    flags: {
      "--name": "Board name to match.",
      "--region": "Region to match.",
      "--work-mode": "Work mode to match.",
    },
  },
  cv: {
    summary: "Build, lint and tailor CVs.",
    flags: {
      "--file": "Path to the input file.",
      "--requirement": "A Posting requirement; repeatable.",
      "--tag": "A tag to select Bullets by; repeatable.",
      "--template": "The CV template to use.",
      "--variant": "The CV variant to build.",
    },
  },
  apply: {
    summary: "Verify and record an application form fill.",
    flags: {
      "--detail": "Detail level to report.",
      "--dump": "Path to the form dump.",
      "--intended": "Path to the intended answers.",
      "--key": "The Lead key.",
      "--list": "List instead of verify.",
      "--provenance": "Where each answer came from.",
      "--save": "Save the result.",
      "--scope": "Which part of the form to check.",
    },
  },
  needs: { summary: "List what each Lead still needs.", flags: {} },
  inbox: {
    summary: "Classify application replies.",
    flags: { "--emails": "Path to the emails JSON." },
  },
  "inbox eval": {
    summary: "Evaluate the reply classifier.",
    flags: { "--labels": "Path to the labelled emails." },
  },
  outreach: {
    summary: "Lint and log outreach drafts.",
    flags: {
      "--addressee": "Who the draft is for.",
      "--channel": "The outreach channel.",
      "--company": "The company of the Lead.",
      "--draft-company": "The company named in the draft.",
      "--file": "Path to the draft.",
      "--key": "The Lead key.",
      "--recipient": "The recipient name.",
    },
  },
  interview: { summary: "Prepare interview material for a Lead.", flags: {} },
  migrate: {
    summary: "Migrate an existing tracker into the event log.",
    flags: { "--project": "The source project.", "--team": "The source team." },
  },
  guard: {
    summary: "Run the Guard hook.",
    flags: {
      "--record": "Record a tool snapshot from stdin.",
      "--self-test": "Run the Guard self-test.",
    },
  },
  dossier: { summary: "Read or write the Dossier.", flags: { "--file": "Path to the section." } },
  contact: {
    summary: "Record Contacts for a Lead.",
    flags: { "--lead": "The Lead key.", "--file": "Path to the Contacts JSON." },
  },
  discover: {
    summary: "Find companies hiring in your area.",
    flags: { "--limit": "Maximum results.", "--keyword": "Add a search keyword; repeatable." },
  },
};

/** Returns the first undeclared flag in `argv` for `command`, or null. */
export function findUnknownFlag(command: string, argv: readonly string[]): string | null {
  const allowed = COMMAND_FLAGS[command] ?? [];
  for (const token of argv) {
    if (GLOBAL_FLAGS.has(token)) continue;
    if (token.startsWith("--") && !allowed.includes(token)) return token;
  }
  return null;
}

/** The argv without the global flags the command does not declare itself. */
export function withoutGlobalFlags(command: string, argv: readonly string[]): string[] {
  const owned = COMMAND_FLAGS[command] ?? [];
  return argv.filter((token) => {
    if (token === "--no-color") return false;
    return !(token === "--json" && !owned.includes("--json"));
  });
}

/** The `--help` payload for one command, or `null` when it is unknown. */
export function commandHelp(command: string): {
  usage: string;
  summary: string;
  flags: { flag: string; description: string }[];
} | null {
  const help = COMMAND_HELP[command];
  if (help === undefined) return null;
  const flags = [
    ...Object.entries(help.flags).map(([flag, description]) => ({ flag, description })),
    { flag: "--data <dir>", description: "Use this data dir." },
    ...("--json" in help.flags
      ? []
      : [{ flag: "--json", description: "Print the JSON envelope even on a terminal." }]),
    { flag: "--no-color", description: "Turn off color." },
  ];
  return {
    usage: `jobship ${command} [flags]`,
    summary: help.summary,
    flags,
  };
}

export function resolveCommand(
  argv: readonly string[],
): { path: string; file: string; rest: string[] } | null {
  const [first, second] = argv;
  if (first === undefined) return null;
  if (second !== undefined) {
    const twoWord = `${first} ${second}`;
    const file = COMMANDS[twoWord];
    if (file !== undefined) return { path: twoWord, file, rest: argv.slice(2) };
  }
  const file = COMMANDS[first];
  if (file === undefined) return null;
  return { path: first, file, rest: argv.slice(1) };
}
