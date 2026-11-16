import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { runSetup } from "./setup.ts";
import {
  ensureTypst,
  installTypst,
  pdftotextInstallHint,
  resolveTypst,
  systemInstallDeps,
  toolStatus,
  TYPST_VERSION,
  type Downloader,
  type Extractor,
  type InstallDeps,
} from "./tools.ts";

let root = "";
let env: Record<string, string | undefined> = {};

const LINUX = { os: "linux", arch: "x64" };
const ARCHIVE_BYTES = new TextEncoder().encode("synthetic archive");
const ARCHIVE_SHA = new Bun.CryptoHasher("sha256").update(ARCHIVE_BYTES).digest("hex");

const fakeExtract: Extractor = (archive, destination) => {
  const folder = path.join(destination, path.basename(archive).replace(/\.tar\.xz$/, ""));
  mkdirSync(folder, { recursive: true });
  writeFileSync(path.join(folder, "typst"), "#!/bin/sh\n");
  return Promise.resolve({ ok: true, value: undefined });
};

const okDownload: Downloader = () => Promise.resolve({ ok: true, value: ARCHIVE_BYTES });

const failingDownload: Downloader = () =>
  Promise.resolve({
    ok: false,
    error: { code: "tool-download-failed", message: "offline" },
  });

const forbiddenDownload: Downloader = () => Promise.reject(new Error("must not download"));

function deps(overrides: Partial<InstallDeps> = {}): InstallDeps {
  return { platform: LINUX, download: okDownload, extract: fakeExtract, ...overrides };
}

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "jobship-tools-"));
  env = { JOBSHIP_CACHE_DIR: path.join(root, "cache"), PATH: path.join(root, "empty-bin") };
  mkdirSync(path.join(root, "empty-bin"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("installTypst", () => {
  test("aborts on a checksum mismatch and leaves nothing cached", async () => {
    const result = await installTypst(env, deps());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("tool-checksum-mismatch");
    expect(resolveTypst(env)).toBeNull();
    const tools = path.join(root, "cache", "tools");
    expect(existsSync(tools) ? readdirSync(tools) : []).toEqual([]);
  });

  test("returns a hint on an unsupported platform", async () => {
    const result = await installTypst(env, deps({ platform: { os: "freebsd", arch: "x64" } }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("tool-unsupported-platform");
      expect(result.error.message).toContain("mise use -g typst");
    }
  });

  test("surfaces a download failure with the manual hint", async () => {
    const result = await installTypst(env, deps({ download: failingDownload }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("brew install typst");
  });
});

function placeTypst(cacheRoot: string): string {
  const binary = path.join(cacheRoot, "tools", `typst-${TYPST_VERSION}`, "typst");
  mkdirSync(path.dirname(binary), { recursive: true });
  writeFileSync(binary, "");
  return binary;
}

describe("cache dir after the rename", () => {
  test("JOBSHIP_CACHE_DIR selects the cache dir", () => {
    const binary = placeTypst(path.join(root, "new-cache"));
    const custom = { ...env, JOBSHIP_CACHE_DIR: path.join(root, "new-cache") };
    expect(resolveTypst(custom)).toEqual({ path: binary, source: "cache" });
  });

  test("defaults to ~/.cache/jobship", () => {
    const binary = placeTypst(path.join(root, ".cache", "jobship"));
    expect(resolveTypst({ HOME: root, PATH: env.PATH })).toEqual({
      path: binary,
      source: "cache",
    });
  });
});

describe("installTypst success", () => {
  test("verifies, extracts and caches the binary atomically", async () => {
    const assets = { "linux-x64": { asset: "typst-test.tar.xz", sha256: ARCHIVE_SHA } };
    const result = await installTypst(env, deps({ assets }));
    const cached = path.join(root, "cache", "tools", `typst-${TYPST_VERSION}`, "typst");
    expect(result).toEqual({ ok: true, value: cached });
    expect(statSync(cached).mode & 0o111).not.toBe(0);
    expect(readdirSync(path.join(root, "cache", "tools"))).toEqual([`typst-${TYPST_VERSION}`]);
  });
});

describe("ensureTypst", () => {
  test("prefers typst on PATH and never downloads", async () => {
    const bin = path.join(root, "bin");
    mkdirSync(bin);
    const fake = path.join(bin, "typst");
    writeFileSync(fake, "#!/bin/sh\n", { mode: 0o755 });
    const result = await ensureTypst({ ...env, PATH: bin }, deps({ download: forbiddenDownload }));
    expect(result).toEqual({ ok: true, value: fake });
  });

  test("reuses the cached binary without downloading", async () => {
    const cached = path.join(root, "cache", "tools", `typst-${TYPST_VERSION}`, "typst");
    mkdirSync(path.dirname(cached), { recursive: true });
    writeFileSync(cached, "#!/bin/sh\n");
    const result = await ensureTypst(env, deps({ download: forbiddenDownload }));
    expect(result).toEqual({ ok: true, value: cached });
    expect(resolveTypst(env)?.source).toBe("cache");
  });
});

describe("toolStatus and setup", () => {
  test("reports missing tools with the platform install hint", () => {
    const status = toolStatus(env, LINUX);
    expect(status.typst).toMatchObject({ found: false, source: "missing", path: null });
    expect(status.pdftotext.found).toBe(false);
    expect(status.pdftotext.installHint).toBe("sudo apt install poppler-utils");
    expect(pdftotextInstallHint({ os: "darwin", arch: "arm64" })).toBe("brew install poppler");
  });

  test("setup fails with cv-tool-missing when pdftotext is absent", async () => {
    const cached = path.join(root, "cache", "tools", `typst-${TYPST_VERSION}`, "typst");
    mkdirSync(path.dirname(cached), { recursive: true });
    writeFileSync(cached, "#!/bin/sh\n");
    const envelope = await runSetup(env, deps(), LINUX);
    expect(envelope.ok).toBe(false);
    if (!envelope.ok) {
      expect(envelope.error.code).toBe("cv-tool-missing");
      expect(envelope.error.recoveryAction).toContain("sudo apt install poppler-utils");
    }
  });

  test("setup succeeds when both tools are present", async () => {
    const bin = path.join(root, "bin");
    mkdirSync(bin);
    for (const name of ["typst", "pdftotext"])
      writeFileSync(path.join(bin, name), "#!/bin/sh\n", { mode: 0o755 });
    const envelope = await runSetup({ ...env, PATH: bin }, deps(), LINUX);
    expect(envelope.ok).toBe(true);
    if (envelope.ok)
      expect(envelope.data).toMatchObject({ typst: { found: true, source: "path" } });
  });
});

const SYNTHETIC_ASSETS = { "linux-x64": { asset: "typst-test.tar.xz", sha256: ARCHIVE_SHA } };

const failingExtract: Extractor = () =>
  Promise.resolve({ ok: false, error: { code: "tool-extract-failed", message: "bad tar" } });
const emptyExtract: Extractor = () => Promise.resolve({ ok: true, value: undefined });
const throwingExtract: Extractor = () => Promise.reject(new Error("disk on fire"));

describe("installTypst failure paths", () => {
  test("surfaces an extraction failure with the manual hint", async () => {
    const result = await installTypst(
      env,
      deps({ assets: SYNTHETIC_ASSETS, extract: failingExtract }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("tool-extract-failed");
      expect(result.error.message).toContain("bad tar; install typst yourself");
    }
  });

  test("reports a missing binary inside the archive", async () => {
    const result = await installTypst(
      env,
      deps({ assets: SYNTHETIC_ASSETS, extract: emptyExtract }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("typst binary missing");
  });

  test("turns a throwing extractor into tool-install-failed and cleans the staging dir", async () => {
    const result = await installTypst(
      env,
      deps({ assets: SYNTHETIC_ASSETS, extract: throwingExtract }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("tool-install-failed");
      expect(result.error.message).toContain("disk on fire");
    }
    expect(readdirSync(path.join(root, "cache", "tools"))).toEqual([]);
  });
});

describe("system downloader", () => {
  const { download } = systemInstallDeps();

  test("refuses a non-https url without fetching", async () => {
    const fetchSpy = spyOn(globalThis, "fetch");
    const result = await download("http://example.invalid/typst");
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("refusing non-https url");
  });

  test("returns the response bytes on success", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(new Response("payload"));
    const result = await download("https://example.invalid/typst");
    fetchSpy.mockRestore();
    expect(result.ok).toBe(true);
    if (result.ok) expect(new TextDecoder().decode(result.value)).toBe("payload");
  });

  test("reports a non-ok status", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("no", { status: 404 }),
    );
    const result = await download("https://example.invalid/typst");
    fetchSpy.mockRestore();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("answered 404");
  });

  test("reports a network error", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    const result = await download("https://example.invalid/typst");
    fetchSpy.mockRestore();
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error).toEqual({ code: "tool-download-failed", message: "offline" });
  });
});

describe("system extractor", () => {
  const { extract } = systemInstallDeps();

  test("unpacks a real tar.xz archive", async () => {
    const source = path.join(root, "src");
    mkdirSync(source);
    writeFileSync(path.join(source, "typst"), "binary");
    const archive = path.join(root, "bundle.tar.xz");
    expect(Bun.spawnSync(["tar", "-cJf", archive, "-C", source, "typst"]).exitCode).toBe(0);
    const destination = path.join(root, "out");
    mkdirSync(destination);
    expect(await extract(archive, destination)).toEqual({ ok: true, value: undefined });
    expect(existsSync(path.join(destination, "typst"))).toBe(true);
  });

  test("reports tar's exit code and stderr for a corrupt archive", async () => {
    const archive = path.join(root, "broken.tar.xz");
    writeFileSync(archive, "not an archive");
    const destination = path.join(root, "out");
    mkdirSync(destination);
    const result = await extract(archive, destination);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("tar exited");
  });

  test("reports a spawn failure", async () => {
    const originalPath = process.env.PATH;
    process.env.PATH = path.join(root, "empty-bin");
    try {
      const result = await extract(path.join(root, "x.tar.xz"), root);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("tool-extract-failed");
    } finally {
      process.env.PATH = originalPath;
    }
  });
});

describe("setup without typst", () => {
  test("fails cv-tool-missing with the manual recovery action when the install fails", async () => {
    const envelope = await runSetup(env, deps({ download: failingDownload }), LINUX);
    expect(envelope.ok).toBe(false);
    if (!envelope.ok) {
      expect(envelope.error.code).toBe("cv-tool-missing");
      expect(envelope.error.recoveryAction).toContain("mise, cargo or brew");
    }
  });

  test("defaults to the system install deps and the current platform", async () => {
    const bin = path.join(root, "bin");
    mkdirSync(bin);
    for (const name of ["typst", "pdftotext"])
      writeFileSync(path.join(bin, name), "#!/bin/sh\n", { mode: 0o755 });
    expect((await runSetup({ ...env, PATH: bin })).ok).toBe(true);
  });
});
