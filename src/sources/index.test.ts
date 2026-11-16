import { afterEach, describe, expect, test } from "bun:test";

import { sources } from "./index.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("default sources", () => {
  test("use the global fetch", async () => {
    let calls = 0;
    globalThis.fetch = Object.assign(
      () => {
        calls += 1;
        return Promise.resolve(
          new Response('{"jobs":[]}', { headers: { "content-type": "application/json" } }),
        );
      },
      { preconnect: () => undefined },
    );
    const result = await sources.greenhouse?.fetch({ slug: "acme" });
    expect(calls).toBe(1);
    expect(result?.errors).toEqual([]);
  });
});
