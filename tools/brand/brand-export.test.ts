import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";

import {
  assertRaster,
  ICO_TARGET,
  MARK_TARGETS,
  OG_TARGETS,
  readIcoEntries,
  readPngSize,
} from "./brand-export-spec.ts";
import {
  type ChromiumBrowser,
  type ChromiumPage,
  exportBrand,
  exportMarks,
  exportOg,
  findChromium,
  openChromiumRenderer,
  type PageCapture,
  type PageRenderer,
} from "./brand-export.ts";

const BRAND_DIR = join(import.meta.dir, "..", "..", "docs", "brand");
const TRUECOLOUR_WITH_ALPHA = 6;

function readBrand(path: string): Uint8Array {
  return new Uint8Array(readFileSync(join(BRAND_DIR, path)));
}

function readBrandText(path: string): string {
  return readFileSync(join(BRAND_DIR, path), "utf8");
}

/** The fenced text under a `## <heading>` of copy.md. */
function copyLine(heading: string): string {
  const pattern = new RegExp(`## ${heading}\\n\\n\`\`\`text\\n([^\\n]+)\\n\`\`\``);
  const line = pattern.exec(readBrandText("copy.md"))?.[1];
  if (line === undefined) {
    throw new Error(`copy.md has no "${heading}"`);
  }
  return line;
}

function textOf(html: string): string {
  return html
    .replaceAll(/<[^>]+>/g, " ")
    .replaceAll(/\s+/g, " ")
    .trim();
}

const scratchRoots: string[] = [];

async function scratchRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "brand-export-"));
  scratchRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    scratchRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function solidPng(width: number, height: number): Promise<Uint8Array> {
  return new Uint8Array(
    await sharp({
      create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } },
    })
      .png()
      .toBuffer(),
  );
}

/** A root whose og pages are minimal offline HTML, with `override` replacing one page's markup. */
async function ogRoot(override?: { source: string; html: string }): Promise<string> {
  const root = await scratchRoot();
  await mkdir(join(root, "docs", "brand", "og"), { recursive: true });
  await writeFile(join(root, "docs", "brand", "og", "og.css"), "body { margin: 0; }\n");
  await Promise.all(
    OG_TARGETS.map((target) =>
      writeFile(
        join(root, "docs", "brand", target.source),
        override?.source === target.source
          ? override.html
          : `<!doctype html><link rel="stylesheet" href="og.css"><p>offline</p>`,
      ),
    ),
  );
  return root;
}

/** The message `work` rejects with; fails the test when it resolves. */
async function failureOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected the export to fail");
}

async function markRoot(): Promise<string> {
  const root = await scratchRoot();
  await mkdir(join(root, "docs", "brand", "logo"), { recursive: true });
  await Promise.all(
    ["mark.svg", "mark-small.svg"].map((name) =>
      cp(join(BRAND_DIR, "logo", name), join(root, "docs", "brand", "logo", name)),
    ),
  );
  return root;
}

/** A renderer that answers every page with a correct capture unless `adjust` changes it. */
function fakeRenderer(adjust?: (url: string, capture: PageCapture) => PageCapture): {
  renderer: PageRenderer;
  captured: string[];
  closed: () => boolean;
} {
  const captured: string[] = [];
  let isClosed = false;
  const renderer: PageRenderer = {
    async capture(url, viewport) {
      captured.push(url);
      const capture = {
        png: await solidPng(viewport.width, viewport.height),
        blockedUrls: [],
        missingFonts: [],
      };
      return adjust === undefined ? capture : adjust(url, capture);
    },
    close() {
      isClosed = true;
      return Promise.resolve();
    },
  };
  return { renderer, captured, closed: () => isClosed };
}

async function listOgPngs(root: string): Promise<string[]> {
  const entries = await readdir(join(root, "docs", "brand", "og"));
  return entries.filter((entry) => !entry.endsWith(".html") && !entry.endsWith(".css")).toSorted();
}

describe("exportOg", () => {
  test("writes the four PNGs from their HTML sources and closes the renderer", async () => {
    const root = await ogRoot();
    const fake = fakeRenderer();
    await exportOg({ root, openRenderer: () => Promise.resolve(fake.renderer) });

    expect(fake.captured.map((url) => url.split("/").pop())).toEqual([
      "cover.html",
      "cover-light.html",
      "social-preview.html",
      "social-preview-light.html",
    ]);
    expect(fake.captured.every((url) => url.startsWith("file://"))).toBe(true);
    expect(await listOgPngs(root)).toEqual([
      "cover-light.png",
      "cover.png",
      "social-preview-light.png",
      "social-preview.png",
    ]);
    expect(fake.closed()).toBe(true);
  });

  test("fails before rendering when an og page names a remote URL", async () => {
    const root = await ogRoot({
      source: "og/social-preview.html",
      html: `<link rel="stylesheet" href="https://fonts.example/plex.css">`,
    });
    const fake = fakeRenderer();
    const outcome = exportOg({ root, openRenderer: () => Promise.resolve(fake.renderer) });

    expect(await failureOf(outcome)).toContain(
      "og/social-preview.html: remote URL https://fonts.example/plex.css",
    );
    expect(fake.captured).toEqual([]);
    expect(await listOgPngs(root)).toEqual([]);
  });

  test("fails when og.css names a remote URL", async () => {
    const root = await ogRoot();
    await writeFile(
      join(root, "docs", "brand", "og", "og.css"),
      "@import url(//cdn.example/a.css);",
    );

    expect(
      await failureOf(
        exportOg({ root, openRenderer: () => Promise.resolve(fakeRenderer().renderer) }),
      ),
    ).toContain("og/og.css: remote URL //cdn.example/a.css");
  });

  test("a failed write replaces no output and leaves no temp file behind", async () => {
    const root = await ogRoot();
    const ogDir = join(root, "docs", "brand", "og");
    await writeFile(join(ogDir, "cover.png"), "committed");
    await mkdir(join(ogDir, `social-preview.png.tmp-${process.pid}`));
    const fake = fakeRenderer();

    await failureOf(exportOg({ root, openRenderer: () => Promise.resolve(fake.renderer) }));

    expect(await readFile(join(ogDir, "cover.png"), "utf8")).toBe("committed");
    expect((await readdir(ogDir)).filter((entry) => entry.includes(".tmp-"))).toEqual([]);
  });

  test("fails and writes nothing when the browser blocked a non-file request", async () => {
    const root = await ogRoot();
    const fake = fakeRenderer((url, capture) =>
      url.endsWith("cover-light.html")
        ? { ...capture, blockedUrls: ["https://cdn.example/x.png"] }
        : capture,
    );

    expect(
      await failureOf(exportOg({ root, openRenderer: () => Promise.resolve(fake.renderer) })),
    ).toContain("og/cover-light.html: blocked non-file request https://cdn.example/x.png");
    expect(await listOgPngs(root)).toEqual([]);
  });

  test("fails and writes nothing when a required font did not load", async () => {
    const root = await ogRoot();
    const fake = fakeRenderer((url, capture) =>
      url.endsWith("social-preview-light.html")
        ? { ...capture, missingFonts: ['400 16px "IBM Plex Mono"'] }
        : capture,
    );
    const outcome = exportOg({ root, openRenderer: () => Promise.resolve(fake.renderer) });

    expect(await failureOf(outcome)).toContain(
      'og/social-preview-light.html: font 400 16px "IBM Plex Mono" did not load',
    );
    expect(fake.closed()).toBe(true);
    expect(await listOgPngs(root)).toEqual([]);
  });

  test("fails and writes nothing when a capture has the wrong size", async () => {
    const root = await ogRoot();
    const fake = fakeRenderer();
    const wrongSize = await solidPng(1280, 640);
    const renderer: PageRenderer = {
      capture: async (url, viewport) => {
        const capture = await fake.renderer.capture(url, viewport);
        return url.endsWith("/cover.html") ? { ...capture, png: wrongSize } : capture;
      },
      close: () => fake.renderer.close(),
    };

    expect(
      await failureOf(exportOg({ root, openRenderer: () => Promise.resolve(renderer) })),
    ).toContain("og/cover.png: expected 1280x440, got 1280x640");
    expect(await listOgPngs(root)).toEqual([]);
  });
});

describe("exportMarks", () => {
  test("re-running on an unchanged kit reproduces the committed mark PNGs and favicon byte for byte", async () => {
    const root = await markRoot();
    await exportMarks({ root });
    const outputs = [...MARK_TARGETS.map((target) => target.output), ICO_TARGET.output];
    const regenerated = await Promise.all(
      outputs.map((output) => readFile(join(root, "docs", "brand", output))),
    );
    expect(
      outputs.filter(
        (output, index) => !regenerated[index]?.equals(Buffer.from(readBrand(output))),
      ),
    ).toEqual([]);
  });

  test("fails when the favicon exceeds its byte budget", async () => {
    const root = await markRoot();
    expect(await failureOf(exportMarks({ root, icoMaxBytes: 1 }))).toContain(
      "exceeds the 1 byte budget",
    );
  });

  test("fails when mark-small.svg is missing", async () => {
    const root = await markRoot();
    await rm(join(root, "docs", "brand", "logo", "mark-small.svg"));
    expect(await failureOf(exportMarks({ root }))).toContain("mark-small.svg");
  });
});

describe("committed rasters", () => {
  test.each(MARK_TARGETS.map((target) => [target.output, target] as const))(
    "%s has its size, alpha and budget",
    (output, target) => {
      const bytes = readBrand(output);
      expect(() => {
        assertRaster(target, bytes);
      }).not.toThrow();
      expect(bytes[25]).toBe(TRUECOLOUR_WITH_ALPHA);
    },
  );

  test("favicon.ico holds the 16, 32 and 48 px PNGs, 16 px from the simplified mark", () => {
    const ico = readBrand(ICO_TARGET.output);
    const entries = readIcoEntries(ico);
    expect(ico.length).toBeLessThanOrEqual(ICO_TARGET.maxBytes);
    expect(entries.map((entry) => entry.width)).toEqual([16, 32, 48]);
    for (const entry of entries) {
      const payload = ico.slice(entry.offset, entry.offset + entry.byteLength);
      expect(readPngSize(payload)).toEqual({ width: entry.width, height: entry.width });
      expect(
        Buffer.from(payload).equals(Buffer.from(readBrand(`logo/png/mark-${entry.width}.png`))),
      ).toBe(true);
    }
  });

  test.each(OG_TARGETS.map((target) => [target.output, target] as const))(
    "%s has its size and fits its budget",
    (output, target) => {
      expect(() => {
        assertRaster(target, readBrand(output));
      }).not.toThrow();
    },
  );
});

describe("og sources", () => {
  const brandLine = copyLine("brand line");
  const plainLine = copyLine("plain line");

  test.each(OG_TARGETS.map((target) => [target.source] as const))(
    "%s shows the brand line, uses tokens only and loads local files only",
    (source) => {
      const html = readBrandText(source);
      const slogan = /<h1\b[^>]*>([\s\S]*?)<\/h1>/.exec(html)?.[1] ?? "";
      expect(textOf(slogan)).toBe(brandLine);
      expect(html).toContain('href="../tokens.css"');
      expect(html).toContain('href="../brandbook/fonts.css"');
      expect(html).not.toMatch(/#[0-9a-f]{3,8}\b/i);
      expect(html).not.toMatch(/https?:\/\/|=["']\/\//);
    },
  );

  test("the light pages use the light theme and the light lockup", () => {
    for (const source of ["og/cover-light.html", "og/social-preview-light.html"]) {
      const html = readBrandText(source);
      expect(html).toMatch(/<body class="light\b/);
      expect(html).toContain('src="../logo/lockup-horizontal.svg"');
    }
    for (const source of ["og/cover.html", "og/social-preview.html"]) {
      expect(readBrandText(source)).toContain('src="../logo/lockup-horizontal-dark.svg"');
    }
  });

  test("the social previews carry the plain line", () => {
    for (const source of ["og/social-preview.html", "og/social-preview-light.html"]) {
      expect(textOf(readBrandText(source))).toContain(plainLine);
    }
  });

  test("og.css takes every colour from tokens and loads nothing remote", () => {
    const css = readBrandText("og/og.css");
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(css).not.toMatch(/\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color-mix)\(/i);
    expect(css).not.toMatch(/https?:\/\/|url\(\s*["']?\/\//);
  });
});

describe("exportBrand", () => {
  test("writes the marks, the favicon and the og rasters in one pass", async () => {
    const root = await ogRoot();
    await cp(join(BRAND_DIR, "logo"), join(root, "docs", "brand", "logo"), { recursive: true });
    const { renderer, closed } = fakeRenderer();
    await exportBrand({ root, openRenderer: () => Promise.resolve(renderer) });
    expect(closed()).toBe(true);
    const outputs = [
      ...MARK_TARGETS.map((target) => target.output),
      ICO_TARGET.output,
      ...OG_TARGETS.map((target) => target.output),
    ];
    const written = await Promise.all(
      outputs.map((output) => readFile(join(root, "docs", "brand", output))),
    );
    expect(written.every((bytes) => bytes.length > 0)).toBe(true);
  });
});

async function fakeChromiumFiles(
  cache: string,
  entries: { directory: string; executable: string[] }[],
): Promise<void> {
  await Promise.all(
    entries.map(async ({ directory, executable }) => {
      const folder = join(cache, directory, ...executable.slice(0, -1));
      await mkdir(folder, { recursive: true });
      await writeFile(join(folder, executable.at(-1) ?? ""), "");
    }),
  );
}

describe("findChromium", () => {
  test("prefers the bundled executable when it exists", async () => {
    const root = await scratchRoot();
    const bundledPath = join(root, "bundled-chrome");
    await writeFile(bundledPath, "");
    expect(await findChromium({ bundledPath, cacheDir: join(root, "missing") })).toBe(bundledPath);
  });

  test("picks the newest Chromium or headless shell in the cache", async () => {
    const cacheDir = await scratchRoot();
    await fakeChromiumFiles(cacheDir, [
      { directory: "chromium-100", executable: ["chrome-linux64", "chrome"] },
      {
        directory: "chromium_headless_shell-200",
        executable: ["chrome-headless-shell-linux64", "chrome-headless-shell"],
      },
      { directory: "chromium-300", executable: ["chrome-linux64", "chrome"] },
      { directory: "chromium_headless_shell-400", executable: ["unrelated"] },
      { directory: "firefox-500", executable: ["firefox"] },
    ]);
    expect(await findChromium({ bundledPath: join(cacheDir, "none"), cacheDir })).toBe(
      join(cacheDir, "chromium-300", "chrome-linux64", "chrome"),
    );
  });

  test("prefers a newer headless shell over an older full build", async () => {
    const cacheDir = await scratchRoot();
    await fakeChromiumFiles(cacheDir, [
      { directory: "chromium-100", executable: ["chrome-linux64", "chrome"] },
      {
        directory: "chromium_headless_shell-200",
        executable: ["chrome-headless-shell-linux64", "chrome-headless-shell"],
      },
    ]);
    expect(await findChromium({ bundledPath: join(cacheDir, "none"), cacheDir })).toBe(
      join(
        cacheDir,
        "chromium_headless_shell-200",
        "chrome-headless-shell-linux64",
        "chrome-headless-shell",
      ),
    );
  });

  test("fails with install guidance when the cache is missing or empty", async () => {
    const root = await scratchRoot();
    const lookup = { bundledPath: join(root, "none"), cacheDir: join(root, "no-cache") };
    expect(await failureOf(findChromium(lookup))).toContain("bunx playwright install chromium");
    expect(await failureOf(findChromium({ ...lookup, cacheDir: root }))).toContain(
      "no Chromium found",
    );
  });

  test("resolves the default lookup to an existing browser or a clear failure", async () => {
    const outcome = await findChromium().then(
      (path) => path,
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    expect(outcome.length).toBeGreaterThan(0);
  });
});

const neverMatches: (url: URL) => boolean = () => false;
const ignoreRoute: Parameters<ChromiumPage["route"]>[1] = () => Promise.resolve();

async function lookupWithBrowser(): Promise<{ bundledPath: string; cacheDir: string }> {
  const root = await scratchRoot();
  const bundledPath = join(root, "chrome");
  await writeFile(bundledPath, "");
  return { bundledPath, cacheDir: root };
}

interface FakePageScript {
  fontResult: unknown;
  requestUrls: string[];
  failGoto?: boolean;
}

function fakeBrowser(script: FakePageScript): {
  browser: ChromiumBrowser;
  launches: { executablePath: string; args: string[] }[];
  contexts: unknown[];
  pagesClosed: () => number;
  browserClosed: () => boolean;
  viewports: { width: number; height: number }[];
} {
  const launches: { executablePath: string; args: string[] }[] = [];
  const contexts: unknown[] = [];
  const viewports: { width: number; height: number }[] = [];
  let pagesClosed = 0;
  let browserClosed = false;
  const browser: ChromiumBrowser = {
    newContext(options) {
      contexts.push(options);
      return Promise.resolve({
        newPage() {
          let matcher = neverMatches;
          let handler = ignoreRoute;
          const page: ChromiumPage = {
            route(nextMatcher, nextHandler) {
              matcher = nextMatcher;
              handler = nextHandler;
              return Promise.resolve();
            },
            setViewportSize(size) {
              viewports.push(size);
              return Promise.resolve();
            },
            async goto() {
              if (script.failGoto === true) {
                throw new Error("navigation failed");
              }
              await Promise.all(
                script.requestUrls
                  .filter((requestUrl) => matcher(new URL(requestUrl)))
                  .map((requestUrl) =>
                    handler({
                      request: () => ({ url: () => requestUrl }),
                      abort: () => Promise.resolve(),
                    }),
                  ),
              );
            },
            evaluate: () => Promise.resolve(script.fontResult),
            screenshot: () => Promise.resolve(new Uint8Array([1, 2, 3])),
            close() {
              pagesClosed += 1;
              return Promise.resolve();
            },
          };
          return Promise.resolve(page);
        },
      });
    },
    close() {
      browserClosed = true;
      return Promise.resolve();
    },
  };
  return {
    browser,
    launches,
    contexts,
    pagesClosed: () => pagesClosed,
    browserClosed: () => browserClosed,
    viewports,
  };
}

describe("openChromiumRenderer", () => {
  test("launches the found executable without a sandbox and captures a page", async () => {
    const lookup = await lookupWithBrowser();
    const fake = fakeBrowser({
      fontResult: [],
      requestUrls: ["file:///brand/og/og.css", "https://example.com/font.woff2"],
    });
    const renderer = await openChromiumRenderer((options) => {
      fake.launches.push(options);
      return Promise.resolve(fake.browser);
    }, lookup);
    const capture = await renderer.capture("file:///brand/og/cover.html", {
      width: 10,
      height: 20,
    });
    await renderer.close();
    expect(fake.launches).toEqual([{ executablePath: lookup.bundledPath, args: ["--no-sandbox"] }]);
    expect(fake.contexts).toEqual([{ deviceScaleFactor: 1, reducedMotion: "reduce" }]);
    expect(fake.viewports).toEqual([{ width: 10, height: 20 }]);
    expect([...capture.png]).toEqual([1, 2, 3]);
    expect(capture.blockedUrls).toEqual(["https://example.com/font.woff2"]);
    expect(capture.missingFonts).toEqual([]);
    expect(fake.pagesClosed()).toBe(1);
    expect(fake.browserClosed()).toBe(true);
  });

  test("uses Playwright's launcher by default and fails before launching without a browser", async () => {
    const root = await scratchRoot();
    expect(
      await failureOf(
        openChromiumRenderer(undefined, { bundledPath: join(root, "none"), cacheDir: root }),
      ),
    ).toContain("no Chromium found");
  });

  test("reports the fonts the page failed to load", async () => {
    const fake = fakeBrowser({ fontResult: ['700 16px "IBM Plex Sans"'], requestUrls: [] });
    const renderer = await openChromiumRenderer(
      () => Promise.resolve(fake.browser),
      await lookupWithBrowser(),
    );
    const capture = await renderer.capture("file:///x.html", { width: 1, height: 1 });
    expect(capture.missingFonts).toEqual(['700 16px "IBM Plex Sans"']);
  });

  test("rejects an unexpected font check result and still closes the page", async () => {
    const lookup = await lookupWithBrowser();
    await Promise.all(
      ["nope", [1, 2]].map(async (fontResult) => {
        const fake = fakeBrowser({ fontResult, requestUrls: [] });
        const renderer = await openChromiumRenderer(() => Promise.resolve(fake.browser), lookup);
        expect(
          await failureOf(renderer.capture("file:///x.html", { width: 1, height: 1 })),
        ).toContain("unexpected value");
        expect(fake.pagesClosed()).toBe(1);
      }),
    );
  });

  test("closes the page when navigation fails", async () => {
    const fake = fakeBrowser({ fontResult: [], requestUrls: [], failGoto: true });
    const renderer = await openChromiumRenderer(
      () => Promise.resolve(fake.browser),
      await lookupWithBrowser(),
    );
    expect(await failureOf(renderer.capture("file:///x.html", { width: 1, height: 1 }))).toBe(
      "navigation failed",
    );
    expect(fake.pagesClosed()).toBe(1);
  });
});
