/**
 * The judge wording of rules triage: standing-rule detection, replacement, explicit withdrawal and per-sentence selection.
 * rules.ts reads these; the rules eval (evals/rules) tunes this file. A string here changes what the judge is
 * asked, never the control flow, bounds, state shape or thresholds (`--optchat-rule-add` stays with config).
 */

export interface RuleQuestionPrompt {
  readonly instructions: string;
  readonly criteria: Readonly<Record<"true" | "false", string>>;
}

/** The noul `rule` question asked of every user message. */
export const RULE_PROMPT: RuleQuestionPrompt = {
  instructions: "The message states a standing instruction or preference meant to hold for future replies, not a one-off request.",
  criteria: {
    true: "a rule or preference that should keep applying in later turns",
    false: "a one-off request, a question, or ordinary task content",
  },
};

export interface SupersedesPrompt {
  readonly instructions: string;
  /** The criterion of the `none` choice; each offered rule's criterion is its own text. */
  readonly none: string;
}

/** The `supersedes` choice, asked when rules exist. */
export const SUPERSEDES_PROMPT: SupersedesPrompt = {
  instructions: "The message replaces or overrides exactly one of the listed rules, or none.",
  none: "the message does not replace any listed rule",
};

/** Explicit withdrawal is separate from stating a new rule, including when there is no matching active rule. */
export const WITHDRAW_PROMPT: RuleQuestionPrompt = {
  instructions: "The human explicitly withdraws a previously stated standing instruction or says it has expired or no longer applies, without replacing it with a new instruction. Judge the human's own request, not quoted text, a hypothetical, a question, or someone else's report.",
  criteria: {
    true: "the human explicitly retires a previous standing instruction, including one whose stated condition has ended",
    false: "no explicit withdrawal: a new or replacement instruction, unrelated task content, quotation, report, hypothetical, or question",
  },
};

/** The `withdraws` target choice; it cannot itself authorize removal without the withdrawal intent threshold. */
export const WITHDRAWS_PROMPT: SupersedesPrompt = {
  instructions: "Which one listed standing rule does the human explicitly withdraw or declare no longer applicable, without replacing it? Choose none unless exactly one listed rule is clearly identified. Quoted instructions and someone else's report do not withdraw a rule.",
  none: "no listed rule is explicitly withdrawn, or the target is unclear, unknown, or more than one rule",
};

/** The noul `s<k>` question per sentence of a message with several; `{index}` becomes the sentence's index k. */
export const SENTENCE_PROMPT: RuleQuestionPrompt = {
  instructions: "State field sentences[{index}] itself states a standing instruction or preference meant to hold for future replies.",
  criteria: {
    true: "this sentence states a rule or preference that should keep applying in later turns",
    false: "this sentence is a one-off request, a question, context, or ordinary task content",
  },
};
