import { colorEnabled } from "./color.ts";

export const BANNER_TEXT =
  "   /|\\\n  /_|_\\    jobship\n \\_____/   Search less. Decide better.\n";

export const BANNER_ANSI =
  "\u001b[94m   /|\\\u001b[0m\n" +
  "\u001b[94m  /_|_\\\u001b[0m    \u001b[1mjobship\u001b[0m\n" +
  "\u001b[94m \\_____/\u001b[0m   \u001b[2mSearch less. Decide better.\u001b[0m\n";

/**
 * Writes the banner to a stream only when it is a TTY, using the plain text
 * variant when color is off (`NO_COLOR`, `--no-color`, `TERM=dumb`). Never throws.
 */
export function writeBanner(
  stream: { isTTY?: boolean; write(chunk: string): unknown },
  env: Record<string, string | undefined>,
  argv: readonly string[] = [],
): void {
  if (stream.isTTY !== true) return;
  const plain = !colorEnabled(env, stream, argv);
  try {
    stream.write(plain ? BANNER_TEXT : BANNER_ANSI);
  } catch {
    return;
  }
}

/**
 * Writes the banner for no-args, `--help` and `help` invocations only, judged
 * by the first argument after the program name.
 */
export function writeBannerForArgs(
  args: readonly string[],
  stream: { isTTY?: boolean; write(chunk: string): unknown },
  env: Record<string, string | undefined>,
): void {
  const [firstArg] = args;
  if (firstArg === undefined || firstArg === "--help" || firstArg === "help") {
    writeBanner(stream, env, args);
  }
}
