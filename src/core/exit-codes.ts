/** Process exit codes of the CLI contract. */
export const EXIT_CODES = {
  ok: 0,
  findings: 1,
  usage: 2,
  internal: 3,
  interrupted: 130,
} as const;

export type ExitCodeValue = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];
