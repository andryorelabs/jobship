import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Readable } from "node:stream";

import type { CommandContext } from "../core/commands.ts";
import { recordFromPayload, run, selfTestEnvelope } from "./command.ts";
import { decideGuard, snapshotScope } from "./decide.ts";
import type { SelfTestResult } from "./self-test.ts";
import { lookupLabel } from "./snapshot.ts";

const CTX: CommandContext = { dataDir: null, env: {}, cwd: "/tmp" };
const SESSION = "coverage-session-command";
const SERVER = "chrome-devtools";

function snapshotPayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    session_id: SESSION,
    tool_name: `mcp__${SERVER}__take_snapshot`,
    tool_response: "uid=7_1 button Apply now",
    ...overrides,
  });
}

describe("recordFromPayload", () => {
  test("records labels from an MCP snapshot response", () => {
    recordFromPayload(snapshotPayload());
    expect(lookupLabel(snapshotScope(SESSION, SERVER), "7_1")).toBe("button Apply now");
  });

  test("ignores payloads it cannot attribute to an MCP session", () => {
    const scope = snapshotScope("ignored-session", SERVER);
    recordFromPayload("not json");
    recordFromPayload("[]");
    recordFromPayload(snapshotPayload({ session_id: "" }));
    recordFromPayload(snapshotPayload({ session_id: 5 }));
    recordFromPayload(snapshotPayload({ tool_name: 5 }));
    recordFromPayload(snapshotPayload({ tool_name: "Bash", session_id: "ignored-session" }));
    recordFromPayload(snapshotPayload({ tool_name: "mcp__", session_id: "ignored-session" }));
    expect(lookupLabel(scope, "7_1")).toBeNull();
  });
});

describe("selfTestEnvelope", () => {
  test("reports success with the cases", () => {
    const cases: SelfTestResult["cases"] = [
      { name: "a", pass: true, expected: "deny", actual: "deny", matcherCovers: true, tool: "t" },
    ];
    const envelope = selfTestEnvelope({ pass: true, cases });
    expect(envelope.ok && envelope.data).toEqual({ cases });
  });

  test("reports failing cases with the matcher state", () => {
    const envelope = selfTestEnvelope({
      pass: false,
      cases: [
        { name: "a", pass: true, expected: "deny", actual: "deny", matcherCovers: true, tool: "t" },
        {
          name: "b",
          pass: false,
          expected: "deny",
          actual: "allow",
          matcherCovers: false,
          tool: "u",
        },
      ],
    });
    expect(envelope.ok).toBe(false);
    expect(!envelope.ok && envelope.error.message).toContain("failing cases: b");
    expect(!envelope.ok && envelope.error.message).toContain("FAIL b: expected deny, actual allow");
  });
});

async function runExpectingExit(argv: string[]): Promise<void> {
  try {
    await run(argv, CTX);
  } catch (error) {
    if (error instanceof Error && error.message === "exit") return;
    throw error;
  }
  throw new Error("run returned without exiting");
}

function feed(text: string): void {
  Object.defineProperty(process, "stdin", {
    value: Readable.from([Buffer.from(text)]),
    configurable: true,
  });
}

describe("run", () => {
  let originalStdin: PropertyDescriptor | undefined;
  let exitCodes: number[] = [];

  beforeEach(() => {
    exitCodes = [];
    originalStdin = Object.getOwnPropertyDescriptor(process, "stdin");
    spyOn(process, "exit").mockImplementation((code?: number) => {
      exitCodes.push(code ?? 0);
      throw new Error("exit");
    });
  });

  afterEach(() => {
    if (originalStdin !== undefined) Object.defineProperty(process, "stdin", originalStdin);
    spyOn(process, "exit").mockRestore();
  });

  test("--self-test returns the envelope of the bundled hooks", async () => {
    const envelope = await run(["--self-test"], CTX);
    expect(envelope.ok).toBe(true);
  });

  test("--record stores the snapshot and exits zero", async () => {
    feed(snapshotPayload({ tool_response: "uid=8_2 link Next" }));
    await runExpectingExit(["--record"]);
    expect(exitCodes).toEqual([0]);
    expect(lookupLabel(snapshotScope(SESSION, SERVER), "8_2")).toBe("link Next");
  });

  test("--record exits zero on unreadable input", async () => {
    Object.defineProperty(process, "stdin", {
      value: Readable.from([42], { objectMode: true }),
      configurable: true,
    });
    await runExpectingExit(["--record"]);
    expect(exitCodes).toEqual([0]);
  });

  test("the default mode prints a deny for a submit key and exits zero", async () => {
    feed(
      JSON.stringify({
        session_id: "s",
        tool_name: "mcp__chrome-devtools__press_key",
        tool_input: { key: "Enter" },
      }),
    );
    await runExpectingExit([]);
    expect(exitCodes).toEqual([0]);
  });

  test("the default mode stays silent when nothing is objectionable", async () => {
    feed(JSON.stringify({ session_id: "s", tool_name: "Read", tool_input: {} }));
    await runExpectingExit([]);
    expect(exitCodes).toEqual([0]);
  });
});

const never = (): null => null;

const fillWith = (toolInput: unknown): string =>
  decideGuard(
    { session_id: "s", tool_name: "mcp__chrome-devtools__fill", tool_input: toolInput },
    never,
  ).decision;

describe("decideGuard scalar fields", () => {
  test("denies a click when no lookup is supplied", () => {
    const decision = decideGuard({
      session_id: "s",
      tool_name: "mcp__chrome-devtools__click",
      tool_input: { uid: "1_1" },
    });
    expect(decision.decision).toBe("deny");
  });

  test("allows fill with non-string values", () => {
    expect(fillWith({ uid: "1_1", value: 42 })).toBe("allow");
  });

  test("denies deeply nested values", () => {
    expect(fillWith({ a: { b: { c: { d: { e: { f: { g: "x" } } } } } } })).toBe("deny");
  });
});
