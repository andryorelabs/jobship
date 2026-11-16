import { describe, expect, test } from "bun:test";

import { getJsonWithRetry } from "./http.ts";

describe("http", () => {
  test("reports a response body that fails while reading", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("stream broke"));
      },
    });
    const outcome = await getJsonWithRetry(
      () => Promise.resolve(new Response(body)),
      "https://x.test/a",
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? "" : outcome.error).toContain("unreadable response from https://x.test/a");
  });

  test("backs off with the default sleep before retrying a 502", async () => {
    let calls = 0;
    const outcome = await getJsonWithRetry(() => {
      calls += 1;
      return Promise.resolve(new Response('{"a":1}', { status: calls < 2 ? 502 : 200 }));
    }, "https://x.test/a");
    expect(outcome.ok).toBe(true);
    expect(calls).toBe(2);
  });
});
