export type AnswerScope = string;

export type AnswerResult =
  | { readonly status: "answer"; readonly text: string; readonly provenance: string }
  | { readonly status: "abstain" };

export interface IntendedField {
  readonly name: string;
  readonly kind: "text" | "file";
  readonly value: string;
}

export interface FieldDump {
  readonly name: string;
  readonly value: string;
}

type VerifyFindingClass = "missing" | "value-mismatch" | "file-name-mismatch";

export interface VerifyFinding {
  readonly field: string;
  readonly class: VerifyFindingClass;
  readonly expected: string;
  readonly actual: string | null;
}

export interface NeedsItem {
  readonly blockerId: string;
  readonly detail: string;
  readonly at: string;
}

export interface NeedsGroup {
  readonly key: string;
  readonly scope: "field" | "section" | "application";
  readonly items: readonly NeedsItem[];
}
