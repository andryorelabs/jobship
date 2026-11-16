import type { SourceAdapter, TrackerAdapter } from "../core/types.ts";
import type { FetchFunction } from "../sources/index.ts";

export interface SweepOptions {
  readonly only?: readonly string[];
  readonly keywords?: readonly string[];
  readonly adapters?: Readonly<Record<string, SourceAdapter>>;
  readonly tracker?: TrackerAdapter;
  readonly fetch?: FetchFunction;
  readonly now?: () => number;
}

export interface SkippedBoard {
  readonly source: string;
  readonly reason: string;
}

export interface SourceCounts {
  readonly seen: number;
  readonly known: number;
  readonly new: number;
  readonly dismissed: number;
}

export interface TrackerSummary {
  readonly created: number;
  readonly updated: number;
  readonly error?: string;
}

export type SourceReport = SourceCounts & {
  readonly source: string;
  readonly status: "ok" | "empty" | "failed" | "misconfigured";
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
};

export interface SweepReport {
  readonly sources: readonly SourceReport[];
  readonly failed: readonly { readonly source: string; readonly errors: readonly string[] }[];
  readonly empty: readonly string[];
  readonly misconfigured: readonly string[];
  readonly skipped: readonly SkippedBoard[];
  readonly totals: SourceCounts;
  readonly leads: readonly string[];
  readonly tracker: TrackerSummary;
}

export type IngestReport = SourceCounts & {
  readonly source: string;
  readonly leads: readonly string[];
  readonly tracker: TrackerSummary;
};

export interface ScoreInput {
  readonly score: number;
  readonly reasons: readonly string[];
  readonly liveness?: string;
  readonly livenessError?: string;
}
