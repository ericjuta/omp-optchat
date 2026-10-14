/**
 * The judge wording of rules triage: the whole-message rule question, the supersedes choice and the per-sentence rule
 * question. rules.ts reads these; the rules eval (evals/rules) tunes this file. A string here changes what the judge is
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

/** The noul `s<k>` question per sentence of a message with several; `{index}` becomes the sentence's index k. */
export const SENTENCE_PROMPT: RuleQuestionPrompt = {
  instructions: "State field sentences[{index}] itself states a standing instruction or preference meant to hold for future replies.",
  criteria: {
    true: "this sentence states a rule or preference that should keep applying in later turns",
    false: "this sentence is a one-off request, a question, context, or ordinary task content",
  },
};
