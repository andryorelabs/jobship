const typesOnly = "type declarations only; nothing to execute, so Bun leaves it out of the table";
const entryPoint =
  "process entry point that reads real stdin or exits the process; its logic lives in a sibling module that tests load";
const oxlintPlugin = "loaded by oxlint as a JS plugin, never by bun test";

/**
 * Modules that never show up in the coverage table of a full `bun run test`, each with the reason.
 * Add a test that loads the module instead of adding an entry; remove an entry as soon as a test
 * loads the module.
 */
export const coverageExemptions: Readonly<Record<string, string>> = {
  "src/apply/types.ts": typesOnly,
  "src/cv/types.ts": typesOnly,
  "src/e2e/stub-fetch.preload.ts":
    "test preload loaded by the end-to-end flow test through the bun preload option of a spawned process",
  "src/migrate/types.ts": typesOnly,
  "src/sweep/types.ts": typesOnly,
  "tools/claude/main.ts": entryPoint,
  "tools/coverage/run-tests.ts": entryPoint,
  "tools/oxlint/baseline/oxlint-plugin.ts": oxlintPlugin,
  "tools/oxlint/local-plugin.ts": oxlintPlugin,
  "tools/pre-push/main.ts": entryPoint,
};
