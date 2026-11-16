import { definePlugin, defineRule } from "@oxlint/plugins";
import type { Comment } from "@oxlint/plugins";

import { baselineLocalRules } from "./baseline/oxlint-plugin.ts";

/**
 * Prefixes of comments that tools read. They are exempt from
 * `no-non-doc-comments` because removing them changes tool behavior.
 */
const toolDirectivePrefixes: readonly string[] = [
  "oxlint-disable",
  "oxlint-enable",
  "eslint-disable",
  "eslint-enable",
  "@ts-expect-error",
  "@ts-ignore",
  "@ts-nocheck",
  "@ts-check",
  "istanbul ignore",
  "c8 ignore",
  "v8 ignore",
  "oxfmt-ignore",
  "prettier-ignore",
  "#__PURE__",
  "@__PURE__",
  "#__NO_SIDE_EFFECTS__",
  "@__NO_SIDE_EFFECTS__",
];

/**
 * Prefixes that are directives only in a block comment, such as a
 * `global name` block. In a line comment the same words open ordinary prose,
 * so they are not exempt there.
 */
const blockOnlyDirectivePrefixes: readonly string[] = ["eslint ", "global ", "globals "];

const tripleSlashDirectivePattern = /^\/\s*<(reference|amd-module|amd-dependency)\b/;

/**
 * A JSDoc block is a block comment opened with exactly `/**`.
 */
function isDocBlock(comment: Comment): boolean {
  return (
    comment.type === "Block" && comment.value.startsWith("*") && !comment.value.startsWith("**")
  );
}

/**
 * Whether the comment is read by a tool rather than by people.
 */
function isToolDirective(comment: Comment): boolean {
  if (comment.type === "Line" && tripleSlashDirectivePattern.test(comment.value)) {
    return true;
  }
  const directiveText = comment.value.trim();
  if (toolDirectivePrefixes.some((prefix) => directiveText.startsWith(prefix))) {
    return true;
  }
  return (
    comment.type === "Block" &&
    blockOnlyDirectivePrefixes.some((prefix) => directiveText.startsWith(prefix))
  );
}

const noNonDocComments = defineRule({
  meta: {
    type: "suggestion",
    docs: {
      description: "Allow only JSDoc blocks and tool directive comments.",
    },
    messages: {
      nonDocComment:
        "Only JSDoc blocks on declarations and tool directives are allowed. Rename or extract instead of explaining inline.",
    },
    schema: [],
  },
  create(context) {
    return {
      Program() {
        for (const comment of context.sourceCode.getAllComments()) {
          if (comment.type === "Shebang" || isDocBlock(comment) || isToolDirective(comment)) {
            continue;
          }
          context.report({ node: comment, messageId: "nonDocComment" });
        }
      },
    };
  },
});

/**
 * Project-local Oxlint rules: the aokit baseline rules plus the jobship-only
 * `no-non-doc-comments`, loaded as a jsPlugin under the `local` alias.
 */
export default definePlugin({
  meta: { name: "local" },
  rules: {
    ...baselineLocalRules,
    "no-non-doc-comments": noNonDocComments,
  },
});
