import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadFactBank } from "./facts.ts";

let dataDir = "";

beforeEach(() => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), "jobship-facts-unit-"));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

function writeFacts(estimateLine: string | null): void {
  const lines = ["facts:", "  - id: invoice-automation", "    text: Automated invoice intake"];
  if (estimateLine !== null) lines.push(`    ${estimateLine}`);
  lines.push("    tags: [automation]", "");
  writeFileSync(path.join(dataDir, "facts.yaml"), lines.join("\n"));
}

describe("loadFactBank estimate", () => {
  test("a fact without estimate has no estimate key", () => {
    writeFacts(null);
    const bank = loadFactBank({ path: dataDir });
    if (!bank.ok) throw new Error(bank.error.message);
    expect(bank.value.facts).toEqual([
      { id: "invoice-automation", text: "Automated invoice intake", tags: ["automation"] },
    ]);
    expect("estimate" in (bank.value.facts[0] ?? {})).toBe(false);
  });

  test("a string estimate lands on the fact", () => {
    writeFacts('estimate: "1,000 PDFs/month × 3–5 min ≈ 50–85 h/month"');
    const bank = loadFactBank({ path: dataDir });
    if (!bank.ok) throw new Error(bank.error.message);
    expect(bank.value.facts[0]?.estimate).toBe("1,000 PDFs/month × 3–5 min ≈ 50–85 h/month");
  });

  test("a null estimate is treated as absent, like other optional fields", () => {
    writeFacts("estimate: null");
    const bank = loadFactBank({ path: dataDir });
    if (!bank.ok) throw new Error(bank.error.message);
    expect("estimate" in (bank.value.facts[0] ?? {})).toBe(false);
  });

  test.each(['estimate: ""', 'estimate: "   "', "estimate: 5", "estimate: [a]"])(
    "%s fails cv-data-invalid",
    (line) => {
      writeFacts(line);
      const bank = loadFactBank({ path: dataDir });
      expect(bank.ok).toBe(false);
      if (!bank.ok) {
        expect(bank.error.code).toBe("cv-data-invalid");
        expect(bank.error.message).toContain("invoice-automation");
      }
    },
  );
});
