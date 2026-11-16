import { EXIT_CODES } from "./exit-codes.ts";

type InterruptSource = {
  on(signal: "SIGINT", listener: () => void): unknown;
};

/** Exits with the interrupted code (130) when SIGINT arrives. */
export function installInterruptHandler(
  source: InterruptSource,
  exit: (code: number) => void,
): void {
  source.on("SIGINT", () => {
    exit(EXIT_CODES.interrupted);
  });
}
