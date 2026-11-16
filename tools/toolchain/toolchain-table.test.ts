import { describe, expect, test } from "bun:test";

import { readRootManifest, stringEntriesOf } from "./package-manifest.ts";

/**
 * The toolchain version table from aokit `docs/standards/tooling.md` (E15),
 * restricted to the rows that apply to jobship. `typescript` 6 and
 * `.node-version` are not used here (ADR-0007).
 */
const toolchainTable: Readonly<Record<string, string>> = {
  oxlint: "1.92.0",
  "@oxlint/plugins": "1.92.0",
  oxfmt: "0.75.0",
  "oxlint-tsgolint": "7.0.2005",
  typescript7: "npm:typescript@7.1.0-beta",
  "@types/bun": "1.4.4",
};

describe("toolchain table", () => {
  test.each(Object.entries(toolchainTable))("%s is pinned to %s", async (name, version) => {
    const devDependencies = stringEntriesOf(await readRootManifest(), "devDependencies");
    expect(devDependencies.get(name)).toBe(version);
  });

  test("packageManager and engines pin bun 1.4.4", async () => {
    const manifest = await readRootManifest();
    expect(manifest["packageManager"]).toBe("bun@1.4.4");
    expect(stringEntriesOf(manifest, "engines").get("bun")).toBe("1.4.4");
  });

  test("jobship has no typescript 6 alias and no .node-version", async () => {
    const devDependencies = stringEntriesOf(await readRootManifest(), "devDependencies");
    expect(devDependencies.has("typescript")).toBe(false);
    expect(await Bun.file(".node-version").exists()).toBe(false);
  });

  test("lint:fix and cache:clear scripts exist", async () => {
    const scripts = stringEntriesOf(await readRootManifest(), "scripts");
    expect(scripts.has("lint:fix")).toBe(true);
    expect(scripts.has("cache:clear")).toBe(true);
  });
});
