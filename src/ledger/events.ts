import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  truncateSync,
} from "node:fs";
import path from "node:path";

import { withLock } from "../core/fs.ts";
import { errorMessage, isObject } from "../core/narrow.ts";
import type { DataDir, HuntEvent } from "../core/types.ts";

const EVENTS_FILE = "events.jsonl";
const NEWLINE = 0x0a;

type DistributiveOmit<Union, Keys extends string> = Union extends unknown
  ? Omit<Union, Keys>
  : never;

export type NewEvent = DistributiveOmit<HuntEvent, "id" | "at">;

export function eventsPath(dir: DataDir): string {
  return path.join(dir.path, EVENTS_FILE);
}

export function readJsonLines(file: string): unknown[] {
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "");
  const parsed: unknown[] = [];
  for (const [index, line] of lines.entries()) {
    try {
      parsed.push(JSON.parse(line));
    } catch (error) {
      if (index === lines.length - 1) continue;
      throw new Error(
        `${path.basename(file)} line ${index + 1} is not valid JSON: ${errorMessage(error)}`,
        { cause: error },
      );
    }
  }
  return parsed;
}

function endsWithNewline(file: string, size: number): boolean {
  const descriptor = openSync(file, "r");
  try {
    const buffer = Buffer.alloc(1);
    readSync(descriptor, buffer, 0, 1, size - 1);
    return buffer.readUInt8(0) === NEWLINE;
  } finally {
    closeSync(descriptor);
  }
}

/** Drops a partial last line left by an interrupted append; reads only the last byte of a whole file. */
export function discardUncommittedTail(file: string): void {
  if (!existsSync(file)) return;
  const { size } = statSync(file);
  if (size === 0 || endsWithNewline(file, size)) return;
  const content = readFileSync(file, "utf8");
  truncateSync(file, Buffer.byteLength(content.slice(0, content.lastIndexOf("\n") + 1)));
}

function isHuntEvent(value: unknown): value is HuntEvent {
  return isObject(value) && typeof value.kind === "string" && typeof value.id === "string";
}

export async function appendEvent(dir: DataDir, event: NewEvent): Promise<HuntEvent> {
  const stored = { ...event, id: randomUUID(), at: new Date().toISOString() } as HuntEvent;
  await withLock(dir.path, () => {
    mkdirSync(dir.path, { recursive: true });
    discardUncommittedTail(eventsPath(dir));
    appendFileSync(eventsPath(dir), `${JSON.stringify(stored)}\n`);
    return Promise.resolve();
  });
  return stored;
}

export async function readEvents(dir: DataDir, key?: string): Promise<HuntEvent[]> {
  const lines = await withLock(dir.path, () => Promise.resolve(readJsonLines(eventsPath(dir))));
  const events = lines.filter(isHuntEvent);
  return key === undefined ? events : events.filter((event) => event.key === key);
}
