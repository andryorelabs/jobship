import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { CommandContext } from "../core/commands.ts";
import type { Envelope } from "../core/envelope.ts";
import { isObject } from "../core/narrow.ts";
import { run } from "./command.ts";

let workDir = "";

beforeEach(() => {
  workDir = mkdtempSync(path.join(os.tmpdir(), "jobship-apply-command-"));
  writeFileSync(path.join(workDir, "jobship.json"), '{"version":1}\n');
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function context(withDataDir = true): CommandContext {
  return { dataDir: withDataDir ? { path: workDir } : null, env: {}, cwd: workDir };
}

function errorCode(envelope: Envelope<unknown>): string | null {
  return envelope.ok ? null : envelope.error.code;
}

function dataOf(envelope: Envelope<unknown>): unknown {
  if (!envelope.ok) throw new Error(`expected success, got ${envelope.error.code}`);
  return envelope.data;
}

function writeJson(name: string, value: unknown): string {
  const file = path.join(workDir, name);
  writeFileSync(file, JSON.stringify(value));
  return name;
}

describe("apply command routing", () => {
  test("an unknown command or subcommand is a usage error", async () => {
    expect(errorCode(await run(["other"], context()))).toBe("usage");
    expect(errorCode(await run([], context()))).toBe("usage");
    expect(errorCode(await run(["apply"], context()))).toBe("usage");
    expect(errorCode(await run(["apply", "submit"], context()))).toBe("usage");
  });

  test("needs, answer and block need a data dir", async () => {
    expect(errorCode(await run(["needs"], context(false)))).toBe("data-dir-not-found");
    expect(errorCode(await run(["apply", "answer", "q"], context(false)))).toBe(
      "data-dir-not-found",
    );
    expect(errorCode(await run(["apply", "block", "k"], context(false)))).toBe(
      "data-dir-not-found",
    );
  });

  test("needs starts empty", async () => {
    expect(dataOf(await run(["needs"], context()))).toEqual({ groups: [] });
  });
});

describe("apply answer", () => {
  test("rejects a missing question, provenance or lead key", async () => {
    expect(errorCode(await run(["apply", "answer"], context()))).toBe("usage");
    expect(errorCode(await run(["apply", "answer", "Q?", "--save", "x"], context()))).toBe("usage");
    expect(errorCode(await run(["apply", "answer", "Q?"], context()))).toBe("usage");
  });

  test("saves, lists and finds an answer, and abstains with a blocker otherwise", async () => {
    const saved = await run(
      ["apply", "answer", "Salary", "expectation?", "--save", "90k", "--provenance", "human"],
      context(),
    );
    expect(dataOf(saved)).toEqual({ status: "saved", scope: "global", provenance: "human" });

    const listed = dataOf(await run(["apply", "answer", "--list"], context()));
    expect(JSON.stringify(listed)).toContain("90k");

    const found = await run(
      ["apply", "answer", "Salary expectation?", "--key", "acme-1"],
      context(),
    );
    expect(dataOf(found)).toMatchObject({ status: "answer", text: "90k" });

    const abstained = dataOf(
      await run(["apply", "answer", "Visa status?", "--key", "acme-1"], context()),
    );
    expect(abstained).toMatchObject({ status: "abstain" });
    expect(isObject(abstained) ? typeof abstained.blockerId : null).toBe("string");
    expect(JSON.stringify(dataOf(await run(["needs"], context())))).toContain("Visa status?");
  });

  test("a failed save returns its error", async () => {
    const result = await run(
      ["apply", "answer", "Q?", "--save", "x", "--provenance", "  "],
      context(),
    );
    expect(errorCode(result)).toBe("usage");
  });
});

describe("apply block", () => {
  test("validates the lead key, the scope and the detail", async () => {
    expect(errorCode(await run(["apply", "block"], context()))).toBe("usage");
    expect(
      errorCode(await run(["apply", "block", "k", "--scope", "page", "--detail", "d"], context())),
    ).toBe("usage");
    expect(errorCode(await run(["apply", "block", "k"], context()))).toBe("usage");
    expect(errorCode(await run(["apply", "block", "k", "--detail", "  "], context()))).toBe(
      "usage",
    );
  });

  test("records a blocker with the default field scope", async () => {
    const data = dataOf(await run(["apply", "block", "acme-1", "--detail", "captcha"], context()));
    expect(data).toMatchObject({ key: "acme-1", scope: "field" });
    const section = dataOf(
      await run(
        ["apply", "block", "acme-1", "--scope", "application", "--detail", "login"],
        context(),
      ),
    );
    expect(section).toMatchObject({ scope: "application" });
  });
});

describe("apply verify", () => {
  test("needs both files", async () => {
    expect(errorCode(await run(["apply", "verify", "--intended", "a.json"], context()))).toBe(
      "usage",
    );
  });

  test("passes when every field matches and works without a data dir", async () => {
    const intended = writeJson("intended.json", [
      { name: "email", value: "a@example.com" },
      { name: "cv", kind: "file", value: "cv.pdf" },
    ]);
    const dump = writeJson("dump.json", [
      { name: "email", value: "a@example.com" },
      { name: "cv", value: "cv.pdf" },
    ]);
    const result = await run(
      ["apply", "verify", "--intended", intended, "--dump", dump],
      context(false),
    );
    expect(dataOf(result)).toEqual({ verified: 2, findings: [] });
  });

  test("reports a mismatch as verify-mismatch", async () => {
    const intended = writeJson("intended.json", [{ name: "cv", kind: "file", value: "cv.pdf" }]);
    const dump = writeJson("dump.json", [{ name: "cv", value: "other.pdf" }]);
    const result = await run(
      ["apply", "verify", "--intended", intended, "--dump", dump],
      context(),
    );
    expect(errorCode(result)).toBe("verify-mismatch");
  });

  test("rejects malformed rows", async () => {
    const goodIntended = writeJson("good-intended.json", [{ name: "cv", value: "cv.pdf" }]);
    const goodDump = writeJson("good-dump.json", [{ name: "cv", value: "cv.pdf" }]);
    const badIntended = [
      "not an object",
      { name: 1, value: "x" },
      { name: "cv", kind: "image", value: "x" },
    ].map((row, index) => writeJson(`intended-${index}.json`, [row]));
    const badDumps = ["not an object", { name: "cv", value: 1 }].map((row, index) =>
      writeJson(`dump-${index}.json`, [row]),
    );
    const pairs = [
      ...badIntended.map((intended) => [intended, goodDump] as const),
      ...badDumps.map((dump) => [goodIntended, dump] as const),
    ];
    const results = await Promise.all(
      pairs.map(([intended, dump]) =>
        run(["apply", "verify", "--intended", intended, "--dump", dump], context()),
      ),
    );
    expect(results.map(errorCode)).toEqual(pairs.map(() => "usage"));
  });

  test("a file that is not a JSON array is an internal error, not a crash", async () => {
    const intended = writeJson("intended.json", { name: "cv" });
    const dump = writeJson("dump.json", []);
    const result = await run(
      ["apply", "verify", "--intended", intended, "--dump", dump],
      context(),
    );
    expect(errorCode(result)).toBe("internal");
  });
});
