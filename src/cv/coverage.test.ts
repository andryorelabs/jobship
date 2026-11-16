import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { CommandContext } from "../core/commands.ts";
import type { InstallDeps } from "../core/tools.ts";
import type { DataDir, Result } from "../core/types.ts";
import { buildCv, createSystemRunner, readCvText, type TypstRunner } from "./build.ts";
import { run, runWith } from "./command.ts";
import { loadBullets, loadFactBank, loadNeverClaim, loadVariants } from "./facts.ts";

const examples = path.join(import.meta.dir, "../../examples/cv");
let root = "";
let dir: DataDir = { path: "" };

function context(overrides: Partial<CommandContext> = {}): CommandContext {
  return { dataDir: dir, env: {}, cwd: root, ...overrides };
}

function okRunner(text = "text"): TypstRunner {
  return {
    compile: () => Promise.resolve({ ok: true, value: undefined }),
    extractText: () => Promise.resolve({ ok: true, value: text }),
  };
}

function failure(code: string): Result<never> {
  return { ok: false, error: { code, message: `${code} happened` } };
}

function write(file: string, content: string): void {
  writeFileSync(path.join(root, file), content);
}

function message(result: Result<unknown>): string {
  return result.ok ? "ok" : `${result.error.code}: ${result.error.message}`;
}

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "jobship-cv-cov-"));
  dir = { path: root };
  for (const file of ["facts.yaml", "bullets.yaml", "never-claim.yaml"]) {
    cpSync(path.join(examples, file), path.join(root, file));
  }
  mkdirSync(path.join(root, "cv"));
  cpSync(path.join(examples, "template.typ"), path.join(root, "cv", "template.typ"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("loadFactBank validation", () => {
  const cases: [string, string, string][] = [
    ["a missing file", "", "is missing"],
    ["invalid YAML", "facts: [unclosed", "not valid YAML"],
    ["a non-mapping document", "- a\n- b\n", "must be a mapping"],
    ["facts that are not a list", "facts: nope\n", "facts must be a list"],
    ["a fact without text", "facts:\n  - id: a\n", "needs string id and text"],
    ["a fact with invalid tags", "facts:\n  - id: a\n    text: t\n    tags: x\n", "invalid tags"],
    [
      "a fact with a blank estimate",
      "facts:\n  - id: a\n    text: t\n    estimate: ' '\n",
      "estimate",
    ],
    ["a profile without a name", "facts: []\nprofile:\n  contact: {}\n", "profile needs"],
    [
      "a profile with invalid contact",
      "facts: []\nprofile:\n  name: n\n  contact: x\n",
      "contact must map",
    ],
    ["experience that is not a list", "facts: []\nexperience: x\n", "experience must be a list"],
    ["an entry without a name", "facts: []\nexperience:\n  - id: e\n", "needs string id and name"],
    [
      "an entry with an invalid role",
      "facts: []\nexperience:\n  - id: e\n    name: n\n    role: 3\n",
      "invalid role",
    ],
    [
      "an entry with invalid dates",
      "facts: []\nexperience:\n  - id: e\n    name: n\n    dates: 3\n",
      "invalid dates",
    ],
    [
      "an entry with invalid metadata",
      "facts: []\nexperience:\n  - id: e\n    name: n\n    metadata: x\n",
      "invalid metadata",
    ],
    ["skills that are not a list", "facts: []\nskills: x\n", "skills must be a list"],
    ["a skill group without a name", "facts: []\nskills:\n  - items: [a]\n", "needs a string name"],
    [
      "a skill group with invalid items",
      "facts: []\nskills:\n  - name: n\n    items: x\n",
      "invalid items",
    ],
    ["projects that are not a list", "facts: []\nprojects: x\n", "projects must be a list"],
  ];
  for (const [name, content, expected] of cases) {
    test(`rejects ${name}`, () => {
      if (content === "") rmSync(path.join(root, "facts.yaml"));
      else write("facts.yaml", content);
      const result = loadFactBank(dir);
      expect(result.ok).toBe(false);
      expect(message(result)).toContain(expected);
    });
  }

  test("accepts numeric metadata, null sections and a full structure", () => {
    write(
      "facts.yaml",
      [
        "facts:",
        "  - id: a",
        "    text: t",
        "    estimate: about 10",
        "profile:",
        "  name: n",
        "  contact:",
        "    phone: 5",
        "experience:",
        "  - id: e",
        "    name: n",
        "    role: r",
        "    dates: d",
        "    metadata:",
        "      years: 3",
        "projects:",
        "  - id: p",
        "    name: pn",
        "skills:",
        "  - name: s",
        "",
      ].join("\n"),
    );
    const result = loadFactBank(dir);
    if (!result.ok) throw new Error(message(result));
    expect(result.value.profile?.contact).toEqual({ phone: "5" });
    expect(result.value.experience?.[0]?.metadata).toEqual({ years: "3" });
    expect(result.value.skills?.[0]?.items).toEqual([]);
    expect(result.value.facts[0]?.estimate).toBe("about 10");
  });
});

describe("loadBullets, loadVariants and loadNeverClaim validation", () => {
  test("rejects bullets that are malformed", () => {
    const cases: [string, string][] = [
      ["bullets:\n  - id: a\n", "needs string id and text"],
      ["bullets:\n  - id: a\n    text: t\n    tags: x\n", "invalid tags or facts"],
      ["bullets:\n  - id: a\n    text: t\n    entry: 3\n", "invalid entry"],
      ["bullets:\n  - id: a\n    text: t\n    order: x\n", "invalid order"],
      ["bullets: x\n", "bullets must be a list"],
    ];
    for (const [content, expected] of cases) {
      write("bullets.yaml", content);
      expect(message(loadBullets(dir))).toContain(expected);
    }
  });

  test("rejects variants that are malformed", () => {
    const cases: [string, string][] = [
      ["bullets: []\nvariants: x\n", "variants must map"],
      ["bullets: []\nvariants:\n  v: x\n", "must be a mapping"],
      ["bullets: []\nvariants:\n  v:\n    all: x\n", "invalid all, any or none"],
    ];
    for (const [content, expected] of cases) {
      write("bullets.yaml", content);
      expect(message(loadVariants(dir))).toContain(expected);
    }
    rmSync(path.join(root, "bullets.yaml"));
    expect(message(loadVariants(dir))).toContain("is missing");
  });

  test("rejects non-string never-claim terms", () => {
    write("never-claim.yaml", "terms:\n  - 3\n");
    expect(message(loadNeverClaim(dir))).toContain("terms must be strings");
    rmSync(path.join(root, "never-claim.yaml"));
    expect(message(loadNeverClaim(dir))).toContain("is missing");
  });

  test("accepts bullets with a null optional entry and order", () => {
    write("bullets.yaml", "bullets:\n  - id: a\n    text: t\n    entry: null\n    order: null\n");
    const result = loadBullets(dir);
    expect(result.ok && result.value[0]).toEqual({ id: "a", text: "t", tags: [], factIds: [] });
  });
});

describe("buildCv failure paths", () => {
  test("propagates a Fact bank, bullets or variants load failure", async () => {
    rmSync(path.join(root, "facts.yaml"));
    expect(message(await buildCv(dir, { runner: okRunner() }))).toContain("cv-data-invalid");
    cpSync(path.join(examples, "facts.yaml"), path.join(root, "facts.yaml"));
    rmSync(path.join(root, "bullets.yaml"));
    expect(message(await buildCv(dir, { runner: okRunner() }))).toContain("cv-data-invalid");
    write("bullets.yaml", "bullets: []\nvariants: x\n");
    expect(message(await buildCv(dir, { runner: okRunner() }))).toContain("variants must map");
  });

  test("an undefined variant is rejected, an empty selection is cv-empty", async () => {
    expect(message(await buildCv(dir, { name: "ghost", runner: okRunner() }))).toContain(
      "unknown-variant",
    );
    expect(message(await buildCv(dir, { tags: ["nothing"], runner: okRunner() }))).toContain(
      "cv-empty",
    );
  });

  test("a Bullet citing no fact id or a missing fact id fails", async () => {
    write("bullets.yaml", "bullets:\n  - id: b\n    text: t\n    tags: [x]\n");
    expect(message(await buildCv(dir, { runner: okRunner() }))).toContain("bullet-unbacked");
    write("bullets.yaml", "bullets:\n  - id: b\n    text: t\n    facts: [nope]\n");
    expect(message(await buildCv(dir, { runner: okRunner() }))).toContain("bullet-fact-missing");
  });

  test("a Bullet whose entry is missing fails", async () => {
    write(
      "bullets.yaml",
      "bullets:\n  - id: b\n    text: t\n    facts: [f-mentoring]\n    entry: e-ghost\n",
    );
    expect(message(await buildCv(dir, { runner: okRunner() }))).toContain("bullet-entry-missing");
  });

  test("a missing template fails", async () => {
    rmSync(path.join(root, "cv", "template.typ"));
    expect(message(await buildCv(dir, { runner: okRunner() }))).toContain("cv-template-missing");
  });

  test("fails when the payload cannot be written", async () => {
    writeFileSync(path.join(root, "cv", "out"), "a file where a directory belongs");
    expect(message(await buildCv(dir, { runner: okRunner() }))).toContain("cv-write-failed");
  });

  test("fails when the extracted text cannot be written", async () => {
    const runner: TypstRunner = {
      compile: () => Promise.resolve({ ok: true, value: undefined }),
      extractText() {
        mkdirSync(path.join(root, "cv", "out", "cv.txt"), { recursive: true });
        return Promise.resolve({ ok: true, value: "text" });
      },
    };
    expect(message(await buildCv(dir, { runner }))).toContain("cv-write-failed");
  });

  test("propagates compile and extract failures", async () => {
    const compileFails: TypstRunner = {
      compile: () => Promise.resolve(failure("cv-tool-failed")),
      extractText: () => Promise.resolve({ ok: true, value: "" }),
    };
    expect(message(await buildCv(dir, { runner: compileFails }))).toContain("cv-tool-failed");
    const extractFails: TypstRunner = {
      compile: () => Promise.resolve({ ok: true, value: undefined }),
      extractText: () => Promise.resolve(failure("cv-tool-missing")),
    };
    expect(message(await buildCv(dir, { runner: extractFails }))).toContain("cv-tool-missing");
  });

  test("a known variant with a selector builds without the unknown-variant check", async () => {
    const result = await buildCv(dir, { name: "backend", runner: okRunner() });
    expect(result.ok).toBe(true);
  });

  test("readCvText fails for a missing file", () => {
    expect(message(readCvText(path.join(root, "missing.txt")))).toContain("cv-text-missing");
  });
});

function request() {
  return {
    root: path.join(root, "cv"),
    template: path.join(root, "cv", "template.typ"),
    dataFile: path.join(root, "cv", "out", "cv.json"),
    output: path.join(root, "cv", "out", "cv.pdf"),
  };
}

describe("createSystemRunner", () => {
  let bin = "";
  const deps: InstallDeps = {
    platform: { os: "plan9", arch: "mips" },
    download: () => Promise.resolve(failure("tool-download-failed")),
    extract: () => Promise.resolve(failure("tool-extract-failed")),
  };

  function script(name: string, body: string): void {
    const file = path.join(bin, name);
    writeFileSync(file, `#!/bin/sh\n${body}\n`);
    chmodSync(file, 0o755);
  }

  function environment(): Record<string, string> {
    return { PATH: bin, HOME: root, XDG_CACHE_HOME: path.join(root, "cache") };
  }

  beforeEach(() => {
    bin = path.join(root, "bin");
    mkdirSync(bin);
  });

  test("compile reports a missing typst without installing it", async () => {
    const runner = createSystemRunner(environment(), () => deps);
    const result = await runner.compile(request());
    expect(message(result)).toContain("cv-tool-missing");
  });

  test("compile runs typst and reports success", async () => {
    script("typst", "exit 0");
    const runner = createSystemRunner(environment(), () => deps);
    expect((await runner.compile(request())).ok).toBe(true);
  });

  test("compile surfaces a typst failure with its exit code and stderr", async () => {
    script("typst", "echo boom >&2; exit 3");
    const runner = createSystemRunner(environment(), () => deps);
    const result = await runner.compile(request());
    expect(message(result)).toContain("cv-tool-failed");
    expect(message(result)).toContain("exited 3: boom");
  });

  test("a tool that cannot be spawned is reported as missing", async () => {
    script("typst", "exit 0");
    writeFileSync(path.join(bin, "typst"), "#!/nonexistent/interpreter\n");
    const runner = createSystemRunner(environment(), () => deps);
    const result = await runner.compile(request());
    expect(message(result)).toContain("could not run");
  });

  test("extractText reports a missing pdftotext", async () => {
    const runner = createSystemRunner(environment(), () => deps);
    expect(message(await runner.extractText("x.pdf"))).toContain("pdftotext (poppler)");
  });

  test("extractText returns the tool output", async () => {
    script("pdftotext", "echo extracted");
    const runner = createSystemRunner(environment(), () => deps);
    const result = await runner.extractText("x.pdf");
    expect(result.ok && result.value.trim()).toBe("extracted");
  });
});

describe("cv command", () => {
  test("rejects an unknown subcommand and a missing data dir", async () => {
    expect(await runWith(["nope"], context(), okRunner())).toMatchObject({
      ok: false,
      error: { code: "usage" },
    });
    expect(await runWith(["build"], context({ dataDir: null }), okRunner())).toMatchObject({
      ok: false,
      error: { code: "data-dir-not-found" },
    });
  });

  test("a flag without a value is a usage failure and --data is skipped", async () => {
    expect(await runWith(["build", "--tag"], context(), okRunner())).toMatchObject({
      ok: false,
      error: { code: "usage" },
    });
    expect(await runWith(["build", "--tag", "--variant"], context(), okRunner())).toMatchObject({
      ok: false,
      error: { code: "usage" },
    });
    const built = await runWith(
      ["build", "--data", root, "--tag", "backend"],
      context(),
      okRunner(),
    );
    expect(built.ok).toBe(true);
  });

  test("build passes variant, requirement and template options", async () => {
    const built = await runWith(
      [
        "build",
        "--variant",
        "mine",
        "--requirement",
        "GitHub Actions, devops",
        "--template",
        "cv/template.typ",
      ],
      context(),
      okRunner(),
    );
    expect(built.ok).toBe(true);
  });

  test("lint rejects an unsafe variant and a missing text file", async () => {
    expect(await runWith(["lint", "--variant", "../x"], context(), okRunner())).toMatchObject({
      ok: false,
      error: { code: "invalid-variant" },
    });
    expect(await runWith(["lint"], context(), okRunner())).toMatchObject({
      ok: false,
      error: { code: "cv-text-missing" },
    });
  });

  test("lint passes a clean --file and propagates data load failures", async () => {
    write("clean.txt", "Reduced checkout API p95 latency from 900 ms to 300 ms.\n");
    const clean = await runWith(["lint", "--file", "clean.txt"], context(), okRunner());
    expect(clean).toMatchObject({ ok: true, data: { findings: [] } });
    rmSync(path.join(root, "facts.yaml"));
    expect(await runWith(["lint", "--file", "clean.txt"], context(), okRunner())).toMatchObject({
      ok: false,
      error: { code: "cv-data-invalid" },
    });
    cpSync(path.join(examples, "facts.yaml"), path.join(root, "facts.yaml"));
    rmSync(path.join(root, "never-claim.yaml"));
    expect(await runWith(["lint", "--file", "clean.txt"], context(), okRunner())).toMatchObject({
      ok: false,
      error: { code: "cv-data-invalid" },
    });
  });

  test("lint propagates an unreadable Dossier identity", async () => {
    write("clean.txt", "text\n");
    mkdirSync(path.join(root, "dossier", "identity.md"), { recursive: true });
    const result = await runWith(["lint", "--file", "clean.txt"], context(), okRunner());
    expect(result).toMatchObject({ ok: false });
  });

  test("coverage validates its arguments and the Fact bank", async () => {
    expect(await runWith(["coverage"], context(), okRunner())).toMatchObject({
      ok: false,
      error: { code: "usage" },
    });
    expect(await runWith(["coverage", "k"], context(), okRunner())).toMatchObject({
      ok: false,
      error: { code: "usage" },
    });
    rmSync(path.join(root, "facts.yaml"));
    expect(
      await runWith(["coverage", "k", "--requirement", "x"], context(), okRunner()),
    ).toMatchObject({ ok: false, error: { code: "cv-data-invalid" } });
  });

  test("run uses the system runner and rejects bad usage", async () => {
    expect(await run(["nope"], context())).toMatchObject({ ok: false, error: { code: "usage" } });
  });
});
