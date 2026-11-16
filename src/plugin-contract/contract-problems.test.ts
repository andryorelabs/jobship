import { describe, expect, test } from "bun:test";

import { validateDocument } from "./contract.ts";

describe("validateDocument problems", () => {
  test("flags a skill without a name", () => {
    const problems = validateDocument("skill", "s", "---\ndescription: d\n---\nbody\n");
    expect(problems).toContain("s: frontmatter lacks name");
  });

  test("flags a document without a description", () => {
    const problems = validateDocument("agent", "a", "---\nname: a\n---\nbody\n");
    expect(problems).toContain("a: frontmatter lacks description");
  });

  test("a command needs no name but still needs a description", () => {
    const problems = validateDocument("command", "c", "---\nfoo: bar\n---\nbody\n");
    expect(problems).toEqual(["c: frontmatter lacks description"]);
  });

  test("flags a document without frontmatter", () => {
    expect(validateDocument("skill", "s", "no frontmatter")).toEqual(["s: missing frontmatter"]);
  });

  test("flags unknown CLI commands and unknown fixed subcommands", () => {
    const body = "---\ndescription: d\n---\nRun `jobship nope` then `jobship cv bogus`.\n";
    const problems = validateDocument("command", "c", body);
    expect(problems).toContain('c: unknown CLI command "jobship nope"');
    expect(problems).toContain('c: unknown CLI command "jobship cv bogus"');
  });
});
