import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import type { OxlintConfig } from "oxlint";

import configuration from "../../oxlint.config.ts";
import { createLocalRuleLinter } from "./lint-fixture.ts";

const config: OxlintConfig = configuration;
const baselineDirectory = join(import.meta.dir, "baseline");

/**
 * SHA-256 of the two aokit `oxc` Module 1.3.0 files under `baseline/`. A change
 * to either file means a new copy from aokit, so the hashes move with it.
 */
const baselineFileHashes: Readonly<Record<string, string>> = {
  "oxlintrc.json": "6bd5a9a9bba098034e37e01e777294c2ccdeb6ecb943d30484a805737685d6c4",
  "oxlint-plugin.ts": "d3e07434368484ef519aa5f023542a2534252e427f113901738791a06ecc4322",
};

function isRuleTable(candidate: unknown): candidate is Record<string, unknown> {
  return typeof candidate === "object" && candidate !== null && !Array.isArray(candidate);
}

async function readBaselineRules(): Promise<{
  rules: Record<string, unknown>;
  testRules: Record<string, unknown>;
}> {
  const baseline: unknown = await Bun.file(join(baselineDirectory, "oxlintrc.json")).json();
  if (!isRuleTable(baseline)) {
    throw new Error("baseline oxlintrc.json is not an object");
  }
  const { rules, overrides } = baseline;
  const firstOverride: unknown = Array.isArray(overrides) ? overrides[0] : undefined;
  const testRules = isRuleTable(firstOverride) ? firstOverride.rules : undefined;
  if (!isRuleTable(rules) || !isRuleTable(testRules)) {
    throw new Error("baseline oxlintrc.json has no rules");
  }
  return { rules, testRules };
}

describe("the copied aokit baseline", () => {
  test.each(Object.entries(baselineFileHashes))("%s is unchanged", async (fileName, hash) => {
    const text = await Bun.file(join(baselineDirectory, fileName)).text();
    expect(new Bun.CryptoHasher("sha256").update(text).digest("hex")).toBe(hash);
  });

  test("the active baseline rules match the baseline setting", async () => {
    const { rules } = await readBaselineRules();
    for (const [ruleName, setting] of Object.entries(rules)) {
      expect(config.rules?.[ruleName] as unknown).toEqual(setting);
    }
  });

  test("the active baseline test rules match the baseline setting", async () => {
    const { testRules } = await readBaselineRules();
    const override = config.overrides?.find((entry) => entry.files.includes("**/*.test.ts"));
    for (const [ruleName, setting] of Object.entries(testRules)) {
      expect(override?.rules?.[ruleName] as unknown).toEqual(setting);
    }
  });
});

describe("local/no-unawaited-async-matcher", () => {
  test("reports a bare resolves assertion and accepts an awaited one", async () => {
    const linter = await createLocalRuleLinter("no-unawaited-async-matcher");
    try {
      const bare = await linter.lint("expect(Promise.resolve(1)).resolves.toBe(1);\n");
      const awaited = await linter.lint(
        "async function check() {\n  await expect(Promise.resolve(1)).resolves.toBe(1);\n}\n",
      );
      expect(bare).toHaveLength(1);
      expect(awaited).toEqual([]);
    } finally {
      await linter.dispose();
    }
  });
});
