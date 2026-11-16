import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { CommandContext } from "../core/commands.ts";
import type { Profile } from "../core/types.ts";
import { readEvents } from "../ledger/events.ts";
import { run } from "./command.ts";
import { logOutreach } from "./log.ts";

const profile: Profile = {
  regions: [],
  contractTypes: ["full-time"],
  remote: "any",
  stack: { include: [], exclude: [] },
  salaryFloor: null,
  excludedCompanies: [],
  outreachDailyCap: 5,
  sources: [],
  tracker: { kind: "local" },
};

let root: string;
let ctx: CommandContext;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "outreach-cov-"));
  ctx = { dataDir: { path: root }, env: {}, cwd: root };
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const lintBase = ["lint", "--channel", "linkedin", "--recipient", "Ada Example"];

describe("outreach lint command", () => {
  test("usage failures", async () => {
    expect((await run([], ctx)).ok).toBe(false);
    expect((await run(["lint", "--channel", "sms"], ctx)).ok).toBe(false);
    expect((await run(lintBase, ctx)).ok).toBe(false);
  });

  test("unreadable draft, missing data dir and unreadable contacts", async () => {
    const args = [...lintBase, "--company", "Acme", "--file", "draft.txt"];
    const missing = await run(args, ctx);
    expect(!missing.ok && missing.error.code).toBe("not-found");
    writeFileSync(path.join(root, "draft.txt"), "Hi Ada, hello.");
    const noDir = await run([...args, "--key", "k"], { dataDir: null, env: {}, cwd: root });
    expect(!noDir.ok && noDir.error.code).toBe("data-dir-not-found");
    mkdirSync(path.join(root, "contacts", "k.json"), { recursive: true });
    const unreadable = await run([...args, "--key", "k"], ctx);
    expect(!unreadable.ok && unreadable.error.code).toBe("internal");
  });

  test("passes a clean draft with addressee and draft company", async () => {
    writeFileSync(path.join(root, "draft.txt"), "Hi Ada, hello.");
    const result = await run(
      [
        ...lintBase,
        "--company",
        "Acme",
        "--file",
        "draft.txt",
        "--addressee",
        "Ada Example",
        "--draft-company",
        "Acme",
      ],
      ctx,
    );
    expect(result.ok).toBe(true);
  });
});

describe("outreach log command", () => {
  test("usage, data-dir and profile failures", async () => {
    expect((await run(["log", "--channel", "sms"], ctx)).ok).toBe(false);
    expect((await run(["log", "--channel", "email"], ctx)).ok).toBe(false);
    const argv = ["log", "--channel", "email", "--recipient", "Ada"];
    const noDir = await run(argv, { dataDir: null, env: {}, cwd: root });
    expect(!noDir.ok && noDir.error.code).toBe("data-dir-not-found");
    const noProfile = await run(argv, ctx);
    expect(!noProfile.ok && noProfile.error.code).toBe("profile-missing");
  });

  test("logs with a lead key", async () => {
    writeFileSync(path.join(root, "profile.yaml"), JSON.stringify(profile));
    const result = await run(
      ["log", "--channel", "email", "--recipient", "Ada", "--key", "k1"],
      ctx,
    );
    expect(result.ok).toBe(true);
    const logged = (await readEvents({ path: root })).find(
      (event) => event.kind === "outreach.logged",
    );
    expect(logged).toMatchObject({ key: "k1" });
  });
});

describe("logOutreach internal errors", () => {
  test("reports a failing lock and a failing event read", async () => {
    const blocked = path.join(root, "blocked");
    writeFileSync(blocked, "x");
    const entry = { channel: "email", recipient: "Ada" } as const;
    const lockFailed = await logOutreach({ path: blocked }, profile, entry);
    expect(!lockFailed.ok && lockFailed.error.code).toBe("internal");
    mkdirSync(path.join(root, "events.jsonl"));
    const readFailed = await logOutreach({ path: root }, profile, entry);
    expect(!readFailed.ok && readFailed.error.code).toBe("internal");
  });
});
