type TerminalStream = { readonly isTTY?: boolean };
type Env = Readonly<Record<string, string | undefined>>;

/**
 * Decides whether output to `stream` may use ANSI color. `--no-color`, `NO_COLOR` and
 * `TERM=dumb` switch it off, `FORCE_COLOR` (anything but `0`) switches it on, and otherwise
 * it follows whether the stream is a TTY.
 */
export function colorEnabled(env: Env, stream: TerminalStream, argv: readonly string[]): boolean {
  if (argv.includes("--no-color")) return false;
  const noColor = env["NO_COLOR"];
  if (noColor !== undefined && noColor !== "") return false;
  const forceColor = env["FORCE_COLOR"];
  if (forceColor !== undefined && forceColor !== "") return forceColor !== "0";
  if (env["TERM"] === "dumb") return false;
  return stream.isTTY === true;
}
