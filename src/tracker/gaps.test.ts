import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { IdempotencyMap } from "../core/approval.ts";
import type { HuntEvent, Lead, Posting, TrackerAdapter } from "../core/types.ts";
import { checkLinearConnection } from "./check.ts";
import { createTracker, projectEvents } from "./index.ts";
import { createLinearTracker, DEFAULT_LINEAR_MAPPING, type FetchLike } from "./linear.ts";

const API_KEY = "lin_api_synthetic_secret_key";

let dir = { path: "" };

beforeEach(() => {
  dir = { path: mkdtempSync(path.join(os.tmpdir(), "jobship-tracker-gaps-")) };
});

afterEach(() => {
  rmSync(dir.path, { recursive: true, force: true });
});

const posting: Posting = {
  id: "1",
  source: "lever",
  url: "https://example.test/jobs/1",
  company: "Acme",
  title: "SRE",
};

const lead: Lead = { key: "acme|sre", posting, eligibility: "eligible" };

const TEAM = {
  data: {
    teams: {
      nodes: [
        {
          id: "team-1",
          states: { nodes: [{ id: "st-1", name: "Backlog" }] },
          labels: { nodes: [{ id: "lb-1", name: "channel:lever" }] },
        },
      ],
    },
  },
};

function operationOf(init: RequestInit): string {
  const body = typeof init.body === "string" ? init.body : "";
  return /(?:query|mutation) (\w+)/.exec(body)?.[1] ?? "";
}

function scripted(responses: Record<string, () => Response>): FetchLike {
  return (_input, init) => {
    const respond = responses[operationOf(init)];
    return Promise.resolve(
      respond === undefined ? Response.json({ errors: [{ message: "unscripted" }] }) : respond(),
    );
  };
}

function linear(send: FetchLike): TrackerAdapter {
  return createLinearTracker({
    apiKey: API_KEY,
    team: "HNT",
    idempotency: new IdempotencyMap(path.join(dir.path, "map.json")),
    fetch: send,
  });
}

async function failureCode(operation: Promise<{ ok: boolean }>): Promise<string> {
  const result = (await operation) as { ok: boolean; error?: { code: string } };
  return result.error?.code ?? "ok";
}

describe("linear tracker failures", () => {
  test("reports HTTP failures and malformed bodies", async () => {
    const http = linear(() => Promise.resolve(new Response("x", { status: 502 })));
    expect(await failureCode(http.find("k"))).toBe("tracker-linear-http");
    const malformed = linear(() => Promise.resolve(new Response("not json")));
    expect(await failureCode(malformed.find("k"))).toBe("tracker-linear-malformed");
  });

  test("reports a missing team", async () => {
    const tracker = linear(
      scripted({ Team: () => Response.json({ data: { teams: { nodes: [] } } }) }),
    );
    expect(await failureCode(tracker.find("k"))).toBe("tracker-linear-no-team");
  });

  test("reports a missing state", async () => {
    const tracker = createLinearTracker({
      apiKey: API_KEY,
      team: "HNT",
      idempotency: new IdempotencyMap(path.join(dir.path, "map.json")),
      mapping: {
        ...DEFAULT_LINEAR_MAPPING,
        states: { ...DEFAULT_LINEAR_MAPPING.states, lead: "Nowhere" },
      },
      fetch: scripted({
        Team: () => Response.json(TEAM),
        FindIssue: () => Response.json({ data: { issues: { nodes: [] } } }),
      }),
    });
    expect(await failureCode(tracker.upsertLead(lead))).toBe("tracker-linear-no-state");
  });

  test("reports label and issue creation without an id", async () => {
    const base = {
      Team: () => Response.json(TEAM),
      FindIssue: () => Response.json({ data: { issues: { nodes: [{}] } } }),
    };
    const labelless = linear(scripted({ ...base, CreateLabel: () => Response.json({ data: {} }) }));
    const newSource: Lead = { ...lead, posting: { ...posting, source: "ashby" } };
    expect(await failureCode(labelless.upsertLead(newSource))).toBe("tracker-linear-malformed");
    const issueless = linear(scripted({ ...base, CreateIssue: () => Response.json({ data: {} }) }));
    expect(await failureCode(issueless.upsertLead(lead))).toBe("tracker-linear-malformed");
  });

  test("reports an unknown issue when changing status or commenting", async () => {
    const tracker = linear(
      scripted({
        Team: () => Response.json(TEAM),
        FindIssue: () => Response.json({ data: { issues: { nodes: [] } } }),
      }),
    );
    expect(await failureCode(tracker.setStatus("k", "applied"))).toBe("tracker-not-found");
  });

  test("reuses an issue found by its marker", async () => {
    const tracker = linear(
      scripted({
        Team: () => Response.json(TEAM),
        FindIssue: () => Response.json({ data: { issues: { nodes: [{ id: "issue-9" }] } } }),
      }),
    );
    expect(await tracker.upsertLead(lead)).toEqual({ ok: true, value: "issue-9" });
    expect(await tracker.find(lead.key)).toEqual({ ok: true, value: "issue-9" });
  });

  test("uses the global fetch by default", async () => {
    const spy = spyOn(globalThis, "fetch").mockImplementation(
      fetchStub(() => Promise.resolve(Response.json({ data: { teams: { nodes: [] } } }))),
    );
    try {
      const tracker = createLinearTracker({
        apiKey: API_KEY,
        team: "HNT",
        idempotency: new IdempotencyMap(path.join(dir.path, "map.json")),
      });
      expect(await failureCode(tracker.find("k"))).toBe("tracker-linear-no-team");
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("checkLinearConnection failures", () => {
  const options = { apiKey: API_KEY, team: "HNT", mapping: DEFAULT_LINEAR_MAPPING };

  test("reports malformed JSON and non-object bodies", async () => {
    const notJson = await checkLinearConnection({
      ...options,
      fetch: () => Promise.resolve(new Response("not json")),
    });
    expect(notJson.ok).toBe(false);
    const notObject = await checkLinearConnection({
      ...options,
      fetch: () => Promise.resolve(Response.json([1])),
    });
    expect(notObject.ok ? [] : notObject.error.problems).toEqual([
      "Linear returned a malformed response",
    ]);
  });

  test("reports GraphQL errors with and without a message", async () => {
    const withMessage = await checkLinearConnection({
      ...options,
      fetch: () => Promise.resolve(Response.json({ errors: [{ message: "bad" }] })),
    });
    expect(withMessage.ok ? [] : withMessage.error.problems).toEqual([
      "Linear rejected the request: bad",
    ]);
    const opaque = await checkLinearConnection({
      ...options,
      fetch: () => Promise.resolve(Response.json({ errors: [1] })),
    });
    expect(opaque.ok ? [] : opaque.error.problems).toEqual([
      "Linear rejected the request: unknown error",
    ]);
  });

  test("uses the global fetch by default", async () => {
    const spy = spyOn(globalThis, "fetch").mockImplementation(
      fetchStub(() => Promise.resolve(Response.json({ data: { teams: { nodes: [] } } }))),
    );
    try {
      const result = await checkLinearConnection(options);
      expect(result.ok ? [] : result.error.problems).toEqual(["team HNT not found"]);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("local tracker edge cases", () => {
  test("reports a missing file for status changes and comments", async () => {
    const tracker = createTracker({ kind: "local" }, dir);
    expect(await failureCode(tracker.setStatus("absent", "applied"))).toBe("tracker-not-found");
    expect(await failureCode(tracker.comment("absent", "hi"))).toBe("tracker-not-found");
  });

  test("tolerates unparseable frontmatter and falls back to the key as title", async () => {
    const root = path.join(dir.path, "applications");
    mkdirSync(root, { recursive: true });
    writeFileSync(
      path.join(root, "k.md"),
      "---\nplain: not json\nflag: true\nignored\n---\n\n# k\n\n## Events\n\n- first\n",
    );
    const tracker = createTracker({ kind: "local" }, dir);
    const result = await tracker.comment("k", "second");
    expect(result.ok).toBe(true);
    const content = readFileSync(path.join(root, "k.md"), "utf8");
    expect(content).toContain('plain: "not json"');
    expect(content).toContain('flag: "true"');
    expect(content).toContain("# k\n");
    expect(content).toContain("- second");
  });

  test("converts thrown errors into failures", async () => {
    const root = path.join(dir.path, "applications");
    mkdirSync(root, { recursive: true });
    const tracker = createTracker({ kind: "local" }, dir);
    chmodSync(root, 0o500);
    try {
      expect(await failureCode(tracker.upsertLead(lead))).toBe("tracker-local-failed");
    } finally {
      chmodSync(root, 0o700);
    }
  });
});

const STAMP = { at: "2026-01-01T00:00:00Z", key: "acme|sre" } as const;

describe("projectEvents", () => {
  test("describes every comment-worthy event kind", async () => {
    const comments: string[] = [];
    const tracker: TrackerAdapter = {
      upsertLead: () => Promise.resolve({ ok: true, value: "id" }),
      setStatus: () => Promise.resolve({ ok: true, value: undefined }),
      comment: (_key, text) => {
        comments.push(text);
        return Promise.resolve({ ok: true, value: undefined });
      },
      find: () => Promise.resolve({ ok: true, value: null }),
    };
    const events: HuntEvent[] = [
      { ...STAMP, id: "e1", kind: "lead.created", posting, eligibility: "eligible" },
      { ...STAMP, id: "e2", kind: "blocker.opened", blockerId: "b1", scope: "field", detail: "d" },
      { ...STAMP, id: "e3", kind: "blocker.resolved", blockerId: "b1" },
      { ...STAMP, id: "e4", kind: "cv.built", variant: "v1", path: "p", hash: "h" },
      { ...STAMP, id: "e5", kind: "email.classified", messageId: "m1", classification: "offer" },
      { ...STAMP, id: "e6", kind: "outreach.logged", channel: "email", recipient: "a@b.test" },
      { ...STAMP, id: "e7", kind: "contact.found", name: "Pat", role: "EM", channel: "linkedin" },
      { ...STAMP, id: "e8", kind: "posting.seen", posting, eligibility: "eligible" },
    ];
    const result = await projectEvents(tracker, dir, events);
    expect(result.ok).toBe(true);
    expect(comments).toEqual([
      "blocker opened b1 [field]: d",
      "blocker resolved b1",
      "cv built v1 h",
      "email m1 classified offer",
      "outreach via email to a@b.test",
      "contact found Pat (EM) via linkedin",
    ]);
  });

  test("converts thrown errors into a projection failure", async () => {
    const tracker: TrackerAdapter = {
      upsertLead: () => Promise.resolve({ ok: true, value: "id" }),
      setStatus: () => Promise.resolve({ ok: true, value: undefined }),
      comment: () => Promise.resolve({ ok: true, value: undefined }),
      find: () => Promise.reject(new Error("exploded")),
    };
    const events: HuntEvent[] = [
      { ...STAMP, id: "e1", kind: "lead.created", posting, eligibility: "eligible" },
    ];
    const result = await projectEvents(tracker, dir, events);
    expect(result).toEqual({
      ok: false,
      error: { code: "tracker-projection-failed", message: "exploded" },
    });
  });
});

function fetchStub(respond: () => Promise<Response>): typeof fetch {
  return Object.assign(respond, { preconnect: () => undefined });
}
