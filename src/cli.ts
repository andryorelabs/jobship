import { writeBannerForArgs } from "./core/banner.ts";
import { colorEnabled } from "./core/color.ts";
import {
  COMMAND_HELP,
  COMMANDS,
  commandHelp,
  findUnknownFlag,
  resolveCommand,
  withoutGlobalFlags,
  type CommandContext,
  type CommandModule,
} from "./core/commands.ts";
import { resolveDataDir } from "./core/data-dir.ts";
import { runDoctor } from "./core/doctor.ts";
import { readSetting } from "./core/env.ts";
import { exitCodeFor, failure, printEnvelope, success, type Envelope } from "./core/envelope.ts";
import { EXIT_CODES } from "./core/exit-codes.ts";
import { renderHuman, resolveOutputMode, type OutputMode } from "./core/human.ts";
import { runInit } from "./core/init.ts";
import { errorMessage } from "./core/narrow.ts";
import { runSetup } from "./core/setup.ts";
import { installInterruptHandler } from "./core/shutdown.ts";
import {
  readCacheFile,
  refreshUpdateCache,
  spawnDetached,
  UPDATE_CHECK_COMMAND,
  updateCheckDisabled,
  updateNoticeLine,
  writeCacheFile,
} from "./core/update-notice.ts";

declare const JOBSHIP_BUILD_VERSION: string | undefined;

const MODULE_LOADERS: Readonly<Record<string, () => Promise<CommandModule>>> = {
  "src/sweep/command.ts": () => import("./sweep/command.ts"),
  "src/ledger/command.ts": () => import("./ledger/command.ts"),
  "src/sources/command.ts": () => import("./sources/command.ts"),
  "src/sources/board-command.ts": () => import("./sources/board-command.ts"),
  "src/cv/command.ts": () => import("./cv/command.ts"),
  "src/apply/command.ts": () => import("./apply/command.ts"),
  "src/inbox/command.ts": () => import("./inbox/command.ts"),
  "src/inbox-eval/command.ts": () => import("./inbox-eval/command.ts"),
  "src/outreach/command.ts": () => import("./outreach/command.ts"),
  "src/interview/command.ts": () => import("./interview/command.ts"),
  "src/migrate/command.ts": () => import("./migrate/command.ts"),
  "src/guard/command.ts": () => import("./guard/command.ts"),
  "src/dossier/command.ts": () => import("./dossier/command.ts"),
  "src/contact/command.ts": () => import("./contact/command.ts"),
  "src/sources/discover/command.ts": () => import("./sources/discover/command.ts"),
};

export const MODULE_FILES: readonly string[] = Object.keys(MODULE_LOADERS);

function withoutDataFlag(argv: readonly string[]): string[] {
  const index = argv.indexOf("--data");
  if (index === -1) return [...argv];
  return [...argv.slice(0, index), ...argv.slice(index + 2)];
}

function buildVersion(): string {
  if (typeof JOBSHIP_BUILD_VERSION === "string") return JOBSHIP_BUILD_VERSION;
  return "0.0.0-dev";
}

const USAGE_LINES: readonly string[] = [
  "usage: jobship <command> [flags]",
  "global flags: --data <dir>, --json, --no-color, --version, --help",
  "run jobship <command> --help for the flags of one command",
];

function usageEnvelope(): Envelope<unknown> {
  const commands = ["init", "setup", "doctor", ...Object.keys(COMMANDS)];
  const summaries = Object.fromEntries(
    commands.map((name) => [name, COMMAND_HELP[name]?.summary ?? ""]),
  );
  return success({ usage: USAGE_LINES.join("\n"), commands, summaries });
}

function helpEnvelope(argv: readonly string[]): Envelope<unknown> | null {
  if (!argv.includes("--help")) return null;
  const rest = withoutDataFlag(argv);
  const [first] = rest;
  const resolved = resolveCommand(rest);
  const path = resolved?.path ?? first;
  if (path === undefined) return null;
  const help = commandHelp(path);
  return help === null ? null : success(help);
}

function needsDataDir(path: string, rest: readonly string[]): boolean {
  if (path === "guard" || path === "inbox eval") return false;
  if (path === "apply") return rest[0] !== "verify";
  if (path === "outreach") return rest[0] !== "lint";
  return true;
}

export async function dispatch(
  argv: string[],
  env: Record<string, string | undefined>,
  cwd: string,
): Promise<Envelope<unknown>> {
  const [first] = argv;
  if (first === "--version") return success({ version: buildVersion() });
  if (first === undefined || first === "--help" || first === "help") return usageEnvelope();
  const help = helpEnvelope(argv);
  if (help !== null) return help;
  const dataDir = resolveDataDir(argv, env, cwd);
  const ctx: CommandContext = { dataDir: dataDir.ok ? dataDir.value : null, env, cwd };
  if (first === "init" || first === "setup" || first === "doctor") {
    const unknownEntryFlag = findUnknownFlag(first, withoutDataFlag(argv.slice(1)));
    if (unknownEntryFlag !== null) {
      return failure("usage", `unknown flag ${unknownEntryFlag} for "${first}"`, {
        recoverable: false,
      });
    }
  }
  if (first === "init") return runInit(withoutGlobalFlags("init", argv.slice(1)), cwd, env);
  if (first === "setup") return runSetup(env);
  if (first === "doctor") {
    const hasExplicitSource = argv.includes("--data") || readSetting(env, "HOME") !== undefined;
    if (!dataDir.ok && hasExplicitSource) {
      return failure(dataDir.error.code, dataDir.error.message);
    }
    return await runDoctor(ctx);
  }
  const command = resolveCommand(withoutDataFlag(argv));
  if (command === null) {
    return failure("unknown-command", `unknown command "${argv.slice(0, 2).join(" ")}"`, {
      recoveryAction: "run jobship without arguments to see the version, or see the README",
    });
  }
  const unknownFlag = findUnknownFlag(command.path, command.rest);
  if (unknownFlag !== null) {
    return failure("usage", `unknown flag ${unknownFlag} for "${command.path}"`, {
      recoverable: false,
    });
  }
  if (!dataDir.ok && needsDataDir(command.path, command.rest)) {
    return failure(dataDir.error.code, dataDir.error.message);
  }
  const load = MODULE_LOADERS[command.file];
  if (load === undefined) {
    return failure("internal", `no loader registered for ${command.file}`, { recoverable: false });
  }
  const sharedModule = Object.values(COMMANDS).filter((file) => file === command.file).length > 1;
  const moduleArgv = sharedModule ? [command.path, ...command.rest] : command.rest;
  return (await load()).run(withoutGlobalFlags(command.path, withoutDataFlag(moduleArgv)), ctx);
}

type OutputStream = { readonly isTTY?: boolean; write(chunk: string): unknown };

/**
 * Writes the envelope in the chosen mode: the JSON envelope for `json`, readable lines for
 * `human`, with the error label colored when color is on.
 */
export function writeOutput(
  envelope: Envelope<unknown>,
  mode: OutputMode,
  stream: OutputStream,
  color: boolean,
): void {
  if (mode === "json") {
    printEnvelope(envelope, stream);
    return;
  }
  const text = renderHuman(envelope);
  const painted =
    color && !envelope.ok ? text.replace(/^error:/, "\u001b[31merror:\u001b[0m") : text;
  stream.write(`${painted}\n`);
}

/** The output mode for this invocation. The Guard always speaks JSON. */
export function outputModeFor(argv: readonly string[], stdout: OutputStream): OutputMode {
  if (argv[0] === "guard") return "json";
  return resolveOutputMode(argv, stdout);
}

/** Everything `runMain` touches outside the process: streams, clock, disk and network. */
export type MainIo = {
  readonly env: Record<string, string | undefined>;
  readonly cwd: string;
  readonly stdout: OutputStream;
  readonly stderr: OutputStream;
  readonly version: string;
  readonly now: () => number;
  readonly fetchImpl: (url: string, init: { signal: AbortSignal }) => Promise<Response>;
  readonly readCacheText: (file: string) => string | null;
  readonly writeCacheText: (file: string, text: string) => void;
  readonly spawnRefresh: () => void;
};

/**
 * Runs one CLI invocation against injected edges and returns the exit code. The update
 * notice appears only in human mode; the detached refresh is the only thing that fetches.
 */
export async function runMain(args: string[], io: MainIo): Promise<number> {
  if (args[0] === UPDATE_CHECK_COMMAND) {
    if (updateCheckDisabled(io.env)) return EXIT_CODES.ok;
    await refreshUpdateCache(io);
    return EXIT_CODES.ok;
  }
  let envelope: Envelope<unknown>;
  try {
    envelope = await dispatch(args, io.env, io.cwd);
  } catch (error) {
    envelope = failure("internal", errorMessage(error), { recoverable: false });
  }
  const mode = outputModeFor(args, io.stdout);
  writeBannerForArgs(args, io.stderr, io.env);
  writeOutput(envelope, mode, io.stdout, colorEnabled(io.env, io.stdout, args));
  if (mode === "human") {
    const line = updateNoticeLine({
      env: io.env,
      currentVersion: io.version,
      now: io.now,
      readCacheText: io.readCacheText,
      writeCacheText: io.writeCacheText,
      spawnRefresh: io.spawnRefresh,
    });
    if (line !== null) io.stderr.write(`${line}\n`);
  }
  return exitCodeFor(envelope);
}

function refreshCommand(): string[] {
  if (typeof JOBSHIP_BUILD_VERSION === "string") return [process.execPath, UPDATE_CHECK_COMMAND];
  return [process.execPath, import.meta.path, UPDATE_CHECK_COMMAND];
}

if (import.meta.main) {
  installInterruptHandler(process, (code) => process.exit(code));
  process.exitCode = await runMain(process.argv.slice(2), {
    env: process.env,
    cwd: process.cwd(),
    stdout: process.stdout,
    stderr: process.stderr,
    version: buildVersion(),
    now: Date.now,
    fetchImpl: fetch,
    readCacheText: readCacheFile,
    writeCacheText: writeCacheFile,
    spawnRefresh: () => {
      spawnDetached(refreshCommand());
    },
  });
}
