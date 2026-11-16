export interface Fact {
  readonly id: string;
  readonly text: string;
  readonly tags: readonly string[];
  /** The arithmetic and assumptions behind an estimated figure in `text`. */
  readonly estimate?: string;
}

export interface Profile {
  readonly name: string;
  readonly contact: Readonly<Record<string, string>>;
}

export interface Entry {
  readonly id: string;
  readonly name: string;
  readonly role?: string;
  readonly dates?: string;
  readonly metadata: Readonly<Record<string, string>>;
}

export interface SkillGroup {
  readonly name: string;
  readonly items: readonly string[];
}

export interface FactBank {
  readonly facts: readonly Fact[];
  readonly profile?: Profile;
  readonly experience?: readonly Entry[];
  readonly projects?: readonly Entry[];
  readonly skills?: readonly SkillGroup[];
}

interface VariantRule {
  readonly all?: readonly string[];
  readonly any?: readonly string[];
  readonly none?: readonly string[];
}

export type Variant = VariantRule & { readonly name: string };

export interface Bullet {
  readonly id: string;
  readonly text: string;
  readonly tags: readonly string[];
  readonly factIds: readonly string[];
  readonly entry?: string;
  readonly order?: number;
}

type LintRule =
  | "never-claim"
  | "identity-leak"
  | "repeated-phrase"
  | "unbacked-number"
  | "unlabeled-estimate"
  | "placeholder";

export interface LintFinding {
  readonly rule: LintRule;
  readonly term: string;
  readonly line: number;
  readonly column: number;
  readonly message: string;
}

export interface Coverage {
  readonly covered: { requirement: string; factIds: string[] }[];
  readonly missing: string[];
}
