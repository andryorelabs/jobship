import { EXIT_CODES, type ExitCodeValue } from "./exit-codes.ts";

export type Envelope<T> =
  | { readonly ok: true; readonly data: T }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: string;
        readonly message: string;
        readonly recoverable: boolean;
        readonly recoveryAction?: string;
      };
    };

export type ExitCode = Exclude<ExitCodeValue, typeof EXIT_CODES.interrupted>;

const EXIT_CODE_BY_ERROR: Readonly<Record<string, ExitCode>> = {
  "not-implemented": EXIT_CODES.findings,
  "already-exists": EXIT_CODES.findings,
  "unknown-command": EXIT_CODES.usage,
  usage: EXIT_CODES.usage,
  "data-dir-not-found": EXIT_CODES.usage,
  "profile-missing": EXIT_CODES.usage,
  "profile-malformed": EXIT_CODES.usage,
  internal: EXIT_CODES.internal,
};

export function success<T>(data: T): Envelope<T> {
  return { ok: true, data };
}

export function failure(
  code: string,
  message: string,
  options: { recoverable?: boolean; recoveryAction?: string } = {},
): Envelope<never> {
  const base = { code, message, recoverable: options.recoverable ?? true };
  return {
    ok: false,
    error:
      options.recoveryAction === undefined
        ? base
        : { ...base, recoveryAction: options.recoveryAction },
  };
}

export function exitCodeFor(envelope: Envelope<unknown>): ExitCode {
  if (envelope.ok) return EXIT_CODES.ok;
  return EXIT_CODE_BY_ERROR[envelope.error.code] ?? EXIT_CODES.findings;
}

export function printEnvelope(
  envelope: Envelope<unknown>,
  stream: { write(chunk: string): unknown } = process.stdout,
): void {
  stream.write(`${JSON.stringify(envelope)}\n`);
}
