import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const root = path.join(import.meta.dir, "..");

function readJson(relative: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(path.join(root, relative), "utf8"));
  if (typeof parsed !== "object" || parsed === null)
    throw new Error(`${relative} is not an object`);
  return { ...parsed };
}

describe("plugin manifest", () => {
  test("plugin.json carries the version and marketplace.json lists the plugin", () => {
    const manifest = readJson(".claude-plugin/plugin.json");
    expect(manifest.name).toBe("jobship");
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+/);
    const marketplace = readJson(".claude-plugin/marketplace.json");
    expect(JSON.stringify(marketplace.plugins)).toContain('"name":"jobship"');
    expect(JSON.stringify(marketplace)).not.toContain("version");
  });

  test("the launcher exists and is executable", () => {
    expect(statSync(path.join(root, "bin/jobship")).mode & 0o111).not.toBe(0);
  });

  test("init and doctor commands wrap the CLI", () => {
    for (const name of ["init", "doctor"]) {
      const body = readFileSync(path.join(root, "commands", `${name}.md`), "utf8");
      expect(body.startsWith("---\ndescription: ")).toBe(true);
      expect(body).toContain(`jobship ${name}`);
    }
  });
});

describe("repo tooling", () => {
  test("selfCheck runs check and test", () => {
    const config = readJson("emet.config.json");
    expect(JSON.stringify(config.commands)).toContain(
      '"selfCheck":["bun run check","bun run test"]',
    );
  });

  test("the check script runs typecheck and lint", () => {
    const scripts = readJson("package.json").scripts;
    expect(JSON.stringify(scripts)).toContain("bun run typecheck && bun run lint");
  });

  test("tsconfig enables the required strict flags", () => {
    const options = readJson("tsconfig.json").compilerOptions;
    for (const flag of [
      "strict",
      "noUncheckedIndexedAccess",
      "exactOptionalPropertyTypes",
      "verbatimModuleSyntax",
    ]) {
      expect(JSON.stringify(options)).toContain(`"${flag}":true`);
    }
  });

  test("CI runs check and test, and release verifies the tag against plugin.json", () => {
    const ci = readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8");
    expect(ci).toContain("run: bun run check");
    expect(ci).toContain("run: bun run test");
    const release = readFileSync(path.join(root, ".github/workflows/release.yml"), "utf8");
    expect(release).toContain("SHA256SUMS");
    expect(release).toContain(".claude-plugin/plugin.json");
    for (const target of ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"]) {
      expect(release).toContain(`jobship-${target}`);
    }
  });

  test("every template named by init exists", () => {
    for (const name of [
      "jobship.json.tmpl",
      "profile.yaml",
      "facts.yaml",
      "bullets.yaml",
      "never-claim.yaml",
      "dossier/career.md",
      "dossier/search.md",
      "dossier/presence.md",
      "dossier/identity.md",
    ]) {
      expect(existsSync(path.join(root, "templates", name))).toBe(true);
    }
  });
});

function copyLine(heading: string): string {
  const copy = readFileSync(path.join(root, "docs/brand/copy.md"), "utf8");
  const match = new RegExp(`^## ${heading}\\n\\n\`\`\`text\\n([^\\n]+)\\n\`\`\``, "m").exec(copy);
  if (match?.[1] === undefined) throw new Error(`docs/brand/copy.md has no "${heading}" block`);
  return match[1];
}

describe("manifest identity fields", () => {
  const repository = "https://github.com/andryorelabs/jobship";
  const author = { name: "Andry Orellana", email: "hello@andryore.dev" };

  test("plugin.json carries author, homepage, repository and license", () => {
    const manifest = readJson(".claude-plugin/plugin.json");
    expect(manifest.author, "plugin.json author").toEqual(author);
    expect(manifest.homepage, "plugin.json homepage").toBe(`${repository}#readme`);
    expect(manifest.repository, "plugin.json repository").toBe(repository);
    expect(manifest.license, "plugin.json license").toBe("MIT");
  });

  test("the marketplace plugin entry carries author, homepage, repository and license", () => {
    const marketplace = readJson(".claude-plugin/marketplace.json");
    const entries = marketplace.plugins;
    if (!Array.isArray(entries)) throw new Error("marketplace.json plugins is not an array");
    const entry: unknown = entries[0];
    expect(entry, "marketplace.json plugin entry").toMatchObject({
      author,
      homepage: repository,
      repository,
      license: "MIT",
    });
  });
});

describe("brand copy on the manifests", () => {
  test("package.json description equals the copy.md package description", () => {
    expect(readJson("package.json").description, "package.json description").toBe(
      copyLine("package description"),
    );
  });

  test("package.json keywords include jobship", () => {
    const manifest = readJson("package.json");
    expect(JSON.stringify(manifest.keywords), "package.json keywords").toContain('"jobship"');
  });

  test("plugin.json description equals the copy.md plugin description", () => {
    expect(readJson(".claude-plugin/plugin.json").description, "plugin.json description").toBe(
      copyLine("plugin description"),
    );
  });

  test("marketplace.json descriptions equal the plugin description and the owner is the org", () => {
    const marketplace = readJson(".claude-plugin/marketplace.json");
    const line = copyLine("plugin description");
    expect(marketplace.owner, "marketplace.json owner").toEqual({ name: "andryorelabs" });
    expect(JSON.stringify(marketplace.plugins), "marketplace.json plugin description").toContain(
      JSON.stringify(line),
    );
    expect(JSON.stringify(marketplace.metadata), "marketplace.json metadata").toContain(
      JSON.stringify(line),
    );
  });
});

function frontmatter(file: string): Record<string, string> {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(readFileSync(file, "utf8"));
  if (match?.[1] === undefined) throw new Error(`${file} has no frontmatter`);
  const fields: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const separator = line.indexOf(":");
    if (separator > 0) fields[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return fields;
}

function listDirectory(relative: string): string[] {
  return readdirSync(path.join(root, relative)).toSorted();
}

describe("plugin contract", () => {
  test("every skill's name equals its directory and its description says when to use it", () => {
    const directories = listDirectory("skills").filter((entry) =>
      existsSync(path.join(root, "skills", entry, "SKILL.md")),
    );
    expect(directories.length).toBeGreaterThan(0);
    for (const directory of directories) {
      const fields = frontmatter(path.join(root, "skills", directory, "SKILL.md"));
      expect(fields.name, `skills/${directory} name`).toBe(directory);
      expect(fields.description, `skills/${directory} description`).toContain("Use when");
    }
  });

  test("hooks.json registers the Guard on PreToolUse and the recorder on PostToolUse", () => {
    const hooks = readJson("hooks/hooks.json").hooks;
    if (typeof hooks !== "object" || hooks === null) throw new Error("hooks.json has no hooks");
    const events = new Map(Object.entries(hooks));
    const pre = JSON.stringify(events.get("PreToolUse"));
    const post = JSON.stringify(events.get("PostToolUse"));
    expect(pre, "PreToolUse").toMatch(/^\[\{"matcher":"mcp__[^"]*","hooks":\[\{"type":"command"/);
    expect(pre, "PreToolUse").toContain('jobship\\" guard');
    expect(post, "PostToolUse").toContain('"matcher":"mcp__.*__take_snapshot"');
    expect(post, "PostToolUse").toContain("guard --record");
  });

  test("every agent pins model and effort", () => {
    for (const file of listDirectory("agents").filter((entry) => entry.endsWith(".md"))) {
      const fields = frontmatter(path.join(root, "agents", file));
      expect(fields.model, `agents/${file} model`).toBeTruthy();
      expect(fields.effort, `agents/${file} effort`).toBeTruthy();
    }
  });

  test("agents that read untrusted input list a restricted tools allowlist", () => {
    const reader = frontmatter(path.join(root, "agents/posting-reader.md"));
    expect(reader.tools, "posting-reader tools").toBe("WebFetch");
    for (const file of listDirectory("agents").filter((entry) => entry.endsWith(".md"))) {
      const fields = frontmatter(path.join(root, "agents", file));
      expect(fields.tools, `agents/${file} tools`).toBeTruthy();
      expect(fields.tools, `agents/${file} tools`).not.toMatch(/Bash|Write|Edit/);
    }
  });

  test("plugin.json has bugs and its homepage equals package.json's", () => {
    const manifest = readJson(".claude-plugin/plugin.json");
    expect(manifest.bugs, "plugin.json bugs").toBe(
      "https://github.com/andryorelabs/jobship/issues",
    );
    expect(manifest.homepage, "plugin.json homepage").toBe(readJson("package.json").homepage);
  });
});
