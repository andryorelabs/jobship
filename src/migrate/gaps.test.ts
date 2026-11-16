import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { CommandContext } from "../core/commands.ts";
import { readEvents } from "../ledger/events.ts";
import type { FetchLike } from "../tracker/linear.ts";
import { run } from "./command.ts";
import { importLegacy } from "./legacy.ts";
import { importLinear } from "./linear.ts";

let root = "";
let legacyDir = "";
let ctx: CommandContext;

function write(relative: string, content: string): string {
  const target = path.join(legacyDir, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
  return target;
}

async function warningsOf(): Promise<string[]> {
  const result = await importLegacy(ctx, legacyDir);
  if (!result.ok) throw new Error(result.error.message);
  return [...result.value.warnings];
}

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "jobship-migrate-gaps-"));
  legacyDir = path.join(root, "legacy");
  const dataPath = path.join(root, "data");
  mkdirSync(dataPath);
  ctx = { dataDir: { path: dataPath }, env: { LINEAR_API_KEY: "lin_synthetic_key" }, cwd: root };
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("importLegacy edge cases", () => {
  test("fails without a data dir", async () => {
    const result = await importLegacy({ ...ctx, dataDir: null }, legacyDir);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("data-dir-not-found");
  });

  test("fails when the path is not a directory", async () => {
    const file = write("plain.txt", "x");
    const result = await importLegacy(ctx, file);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("usage");
  });

  test("warns about unreadable files in every area", async () => {
    const files = [
      write("sweeps/a.md", "x"),
      write("reviews/b.md", "x"),
      write("applications/c.md", "x"),
    ];
    for (const file of files) chmodSync(file, 0o000);
    const warnings = await warningsOf();
    for (const file of files) chmodSync(file, 0o644);
    expect(warnings.filter((warning) => warning.startsWith("cannot read"))).toHaveLength(3);
  });

  test("warns about unrecognised tables and empty files", async () => {
    const unrecognised = "| Foo | Bar |\n| --- | --- |\n| 1 | 2 |\n";
    write("sweeps/a.md", unrecognised);
    write("sweeps/empty.md", "# nothing here\n");
    write("reviews/b.md", unrecognised);
    write("reviews/empty.md", "# nothing here\n");
    write("applications/c.md", unrecognised);
    write("applications/empty.md", "# nothing here\n");
    const warnings = await warningsOf();
    expect(warnings.filter((warning) => warning.startsWith("table without"))).toHaveLength(3);
    expect(warnings.filter((warning) => warning.startsWith("no parseable"))).toHaveLength(3);
  });

  test("skips sweep leads without a company or role", async () => {
    write("sweeps/a.md", "### Mystery\n\n- **Fit:** B\n");
    const warnings = await warningsOf();
    expect(warnings.some((warning) => warning.includes("has no company or role"))).toBe(true);
  });

  test("skips rows without company and role, with and without a label", async () => {
    write("sweeps/a.md", "| Company | Role |\n| --- | --- |\n| | |\n");
    write(
      "applications/b.md",
      "| Company | Status |\n| --- | --- |\n| Foo | Applied |\n| | Applied |\n",
    );
    const warnings = await warningsOf();
    expect(warnings.some((warning) => warning.includes('"Foo"'))).toBe(true);
    expect(warnings.filter((warning) => warning.startsWith("row without"))).toHaveLength(3);
  });

  test("fills application rows from review ids", async () => {
    write(
      "reviews/r.md",
      "| ID | Title | Verdict |\n| --- | --- | --- |\n| AO-7 | Acme - SRE | keep |\n",
    );
    write(
      "applications/a.md",
      "| ID | Company | Status |\n| --- | --- | --- |\n| AO-7 | | Applied |\n",
    );
    const result = await importLegacy(ctx, legacyDir);
    expect(result.ok).toBe(true);
    const events = await readEvents(ctx.dataDir ?? { path: "" });
    expect(events.filter((event) => event.kind === "lead.created")).toHaveLength(1);
  });
});

function pageFetch(body: unknown, init?: ResponseInit): FetchLike {
  return () => Promise.resolve(new Response(JSON.stringify(body), init));
}

async function linearError(send: FetchLike): Promise<{ code: string; message: string }> {
  const result = await importLinear(ctx, { team: "HNT", fetch: send });
  if (result.ok) throw new Error("expected failure");
  return result.error;
}

describe("importLinear failures", () => {
  test("fails without a data dir", async () => {
    const result = await importLinear({ ...ctx, dataDir: null }, { team: "HNT" });
    expect(result.ok).toBe(false);
  });

  test("redacts the key from network errors", async () => {
    const error = await linearError(() => Promise.reject(new Error("boom lin_synthetic_key")));
    expect(error.code).toBe("migrate-linear-network");
    expect(error.message).toBe("boom [redacted]");
  });

  test("rejects malformed bodies", async () => {
    const notJson = await linearError(() => Promise.resolve(new Response("not json")));
    expect(notJson.code).toBe("migrate-linear-malformed");
    expect((await linearError(pageFetch([1]))).message).toBe("response is not an object");
    expect((await linearError(pageFetch({ data: {} }))).message).toBe("response has no issues");
  });

  test("surfaces GraphQL errors", async () => {
    const withMessage = await linearError(pageFetch({ errors: [{ message: "bad filter" }] }));
    expect(withMessage).toEqual({ code: "migrate-linear-graphql", message: "bad filter" });
    const opaque = await linearError(pageFetch({ errors: ["x"] }));
    expect(opaque.message).toBe("unknown error");
  });

  test("scopes by project and uses the global fetch by default", async () => {
    const spy = spyOn(globalThis, "fetch").mockImplementation(
      fetchStub(() =>
        Promise.resolve(new Response(JSON.stringify({ data: { issues: { nodes: [{ id: 1 }] } } }))),
      ),
    );
    try {
      const result = await importLinear(ctx, { team: "HNT", project: "Hunt" });
      expect(result.ok).toBe(true);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("migrate command edge cases", () => {
  test("requires a data dir", async () => {
    const envelope = await run(["legacy", legacyDir], { ...ctx, dataDir: null });
    expect(envelope.ok).toBe(false);
  });

  test("rejects flag-shaped arguments", async () => {
    expect((await run(["legacy", "--x"], ctx)).ok).toBe(false);
    expect((await run(["linear", "--team", "--project", "p"], ctx)).ok).toBe(false);
  });

  test("passes the project through and unwraps failures", async () => {
    const spy = spyOn(globalThis, "fetch").mockImplementation(
      fetchStub(() => Promise.resolve(new Response("no", { status: 500 }))),
    );
    try {
      const envelope = await run(["linear", "--team", "HNT", "--project", "Hunt"], ctx);
      expect(envelope.ok).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});

function fetchStub(respond: () => Promise<Response>): typeof fetch {
  return Object.assign(respond, { preconnect: () => undefined });
}
