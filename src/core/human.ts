import type { Envelope } from "./envelope.ts";
import { isObject } from "./narrow.ts";

export type OutputMode = "human" | "json";

/**
 * Picks the output mode: `--json` forces JSON, a TTY on stdout means human lines, and
 * anything else (a pipe, a file) means JSON, whatever stderr is.
 */
export function resolveOutputMode(
  argv: readonly string[],
  stdout: { readonly isTTY?: boolean },
): OutputMode {
  if (argv.includes("--json")) return "json";
  return stdout.isTTY === true ? "human" : "json";
}

function renderEntry(key: string, entry: unknown, indent: string): string[] {
  if (typeof entry === "string" && entry.includes("\n")) {
    return [`${indent}${key}:`, ...entry.split("\n").map((line) => `${indent}  ${line}`)];
  }
  if (isObject(entry) || Array.isArray(entry)) {
    const nested = renderValue(entry, `${indent}  `);
    return nested.length === 0 ? [`${indent}${key}: -`] : [`${indent}${key}:`, ...nested];
  }
  return [`${indent}${key}: ${String(entry)}`];
}

function renderValue(value: unknown, indent: string): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item): string[] => {
      if (isObject(item) || Array.isArray(item)) {
        return [`${indent}-`, ...renderValue(item, `${indent}  `)];
      }
      return [`${indent}- ${String(item)}`];
    });
  }
  if (isObject(value)) {
    return Object.entries(value).flatMap(([key, entry]) => renderEntry(key, entry, indent));
  }
  return [`${indent}${String(value)}`];
}

/** Renders an envelope as readable lines, without a trailing newline. */
export function renderHuman(envelope: Envelope<unknown>): string {
  if (envelope.ok) {
    if (typeof envelope.data === "string") return envelope.data;
    return renderValue(envelope.data, "").join("\n");
  }
  const lines = [`error: ${envelope.error.message} (${envelope.error.code})`];
  if (envelope.error.recoveryAction !== undefined) {
    lines.push(`next: ${envelope.error.recoveryAction}`);
  }
  return lines.join("\n");
}
