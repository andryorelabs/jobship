export const CHANNELS = ["linkedin", "email"] as const;
type Channel = (typeof CHANNELS)[number];

export interface Draft {
  readonly channel: Channel;
  readonly body: string;
  readonly addressee?: string;
  readonly company?: string;
}

export interface Recipient {
  readonly name: string;
}

export interface OutreachEntry {
  readonly channel: Channel;
  readonly recipient: string;
  readonly key?: string;
}

type LintRule =
  | "too-long"
  | "empty"
  | "placeholder"
  | "stock-phrase"
  | "wrong-name"
  | "wrong-company";

export interface LintFinding {
  readonly rule: LintRule;
  readonly message: string;
}
