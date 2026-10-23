import type { Answer, Questions } from "@oh-my-pi/pi-ai";
import { utf8Prefix } from "../memory.js";
import type { Rule } from "./ledger.js";
import { RULE_PROMPT, SENTENCE_PROMPT, SUPERSEDES_PROMPT, WITHDRAW_PROMPT, WITHDRAWS_PROMPT } from "./rules-prompt.js";

/** The user message as judged: bounded so one request stays within the judge's state limit. */
export const TRIAGE_MESSAGE_BYTES = 4_000;
/** Only the newest active rules are offered for replacement or withdrawal; older ones still hold. */
export const SUPERSEDE_RULE_LIMIT = 32;
/** A replacement or withdrawal target must reach this probability. */
const TARGET_PROBABILITY = 0.5;
/** At most this many sentences are judged one by one; a longer message offers only its first ones. */
export const RULE_SENTENCE_LIMIT = 12;

/** Authority comes from host attribution, never the message text. Only human messages may change this human-only ledger. */
export type RuleAuthority = "human" | "non-human" | "unknown";

/**
 * The judge's answers for one human message: `rule` and `withdraw` always, `supersedes` and `withdraws` when rules exist,
 * and `s<k>` per sentence when there are several. A missing or mistyped answer cannot authorize a mutation.
 */
export type TriageAnswers = Readonly<Record<string, Answer | undefined>>;

/** What one triage decided, with the rule's text. `none` leaves the ledger untouched. */
export type TriageDecision =
  | { readonly kind: "none" }
  | { readonly kind: "add"; readonly text: string }
  | { readonly kind: "replace"; readonly replaces: string; readonly text: string }
  | { readonly kind: "remove"; readonly removes: string };

/**
 * The message's sentences, split after `.`, `!` or `?` and at line breaks, whole and in order.
 * Only complete sentences within `TRIAGE_MESSAGE_BYTES` and `RULE_SENTENCE_LIMIT` are offered, so a rule's text is never cut.
 */
export function ruleSentences(message: string): string[] {
  const sentences: string[] = [];
  let bytes = 0;
  for (const raw of message.split(/(?<=[.!?])\s+|\n+/)) {
    const sentence = raw.trim();
    if (sentence.length === 0) continue;
    bytes += Buffer.byteLength(sentence, "utf8") + 1;
    if (bytes > TRIAGE_MESSAGE_BYTES || sentences.length === RULE_SENTENCE_LIMIT) break;
    sentences.push(sentence);
  }
  return sentences;
}

/** The rules offered for replacement and withdrawal: the newest `SUPERSEDE_RULE_LIMIT`. */
export function offeredRules(active: readonly Rule[]): Rule[] {
  return active.slice(-SUPERSEDE_RULE_LIMIT);
}

/** The judge's state: the user's words, verbatim up to the bound, and the sentences when there are several. */
export function triageState(message: string, sentences: readonly string[]): { message: string; sentences?: readonly string[] } {
  const bounded = utf8Prefix(message, TRIAGE_MESSAGE_BYTES);
  return sentences.length > 1 ? { message: bounded, sentences } : { message: bounded };
}

/**
 * Noul `rule` and `withdraw` questions, plus `supersedes` and `withdraws` choices over the offered rule ids when rules exist,
 * plus one noul `s<k>` per sentence when the message has several, so an added rule keeps only the sentences that state it.
 */
export function triageQuestions(offered: readonly Rule[], sentences: readonly string[] = []): Questions {
  const questions: Questions = {
    rule: { type: "noul", instructions: RULE_PROMPT.instructions, criteria: { ...RULE_PROMPT.criteria } },
    withdraw: { type: "noul", instructions: WITHDRAW_PROMPT.instructions, criteria: { ...WITHDRAW_PROMPT.criteria } },
  };
  if (offered.length > 0) {
    const criteria: Record<string, string | null> = { none: SUPERSEDES_PROMPT.none };
    for (const rule of offered) criteria[rule.id] = rule.text;
    questions.supersedes = {
      type: "choice",
      instructions: SUPERSEDES_PROMPT.instructions,
      criteria,
    };
    questions.withdraws = {
      type: "choice",
      instructions: WITHDRAWS_PROMPT.instructions,
      criteria: { ...criteria, none: WITHDRAWS_PROMPT.none },
    };
  }
  if (sentences.length > 1) {
    for (let index = 0; index < sentences.length; index++) {
      questions[`s${index}`] = {
        type: "noul",
        instructions: SENTENCE_PROMPT.instructions.replaceAll("{index}", String(index)),
        criteria: { ...SENTENCE_PROMPT.criteria },
      };
    }
  }
  return questions;
}

/** P(rule) of one answer; null when it is missing, mistyped or outside the finite probability range. */
function ruleProbability(answer: Answer | undefined): number | null {
  return answer?.type === "noul" && Number.isFinite(answer.noul) && answer.noul >= 0 && answer.noul <= 1 ? answer.noul : null;
}

/**
 * The probabilities behind one triage, for the metric sink: P(rule) of the whole message, and the highest P(rule) over its
 * sentences (null unless the message was judged sentence by sentence and some sentence answer is usable). Counts only.
 */
export function triageProbabilities(
  answers: TriageAnswers,
  sentences: readonly string[] = [],
): { readonly pRule: number | null; readonly pSentenceMax: number | null } {
  let pSentenceMax: number | null = null;
  if (sentences.length > 1) {
    for (let index = 0; index < sentences.length; index++) {
      const value = ruleProbability(answers[`s${index}`]);
      if (value !== null && (pSentenceMax === null || value > pSentenceMax)) pSentenceMax = value;
    }
  }
  return { pRule: ruleProbability(answers.rule), pSentenceMax };
}

/**
 * Only host-attributed humans can act. An explicit withdrawal reaching `ruleAdd` removes its listed `withdraws` target
 * at 0.5 or more; an unknown or missing withdrawal target does nothing and never becomes an added rule.
 * Otherwise add when P(rule) reaches `ruleAdd`, or replace when `supersedes` names a listed rule at 0.5 or more.
 * The caller must still require the target to be active when applying the decision after a judge wait.
 * With several sentences, the rule's text is the sentences whose own `s<k>` reaches `ruleAdd`, in order;
 * when none does, or an answer is missing, nothing changes. A single sentence keeps the whole message.
 */
export function decideTriage(
  authority: RuleAuthority,
  answers: TriageAnswers,
  offered: readonly Rule[],
  ruleAdd: number,
  message: string,
  sentences: readonly string[] = [],
): TriageDecision {
  if (authority !== "human") return { kind: "none" };
  const withdrawal = ruleProbability(answers.withdraw);
  if (withdrawal === null) return { kind: "none" };
  if (withdrawal >= ruleAdd) {
    const withdraws = answers.withdraws?.type === "choice" ? answers.withdraws : undefined;
    const target = withdraws?.choice;
    const probability = target === undefined ? undefined : withdraws?.probabilities?.[target];
    if (
      target !== undefined && target !== "none" && offered.some((rule) => rule.id === target) &&
      typeof probability === "number" && probability >= TARGET_PROBABILITY && probability <= 1
    ) {
      return { kind: "remove", removes: target };
    }
    return { kind: "none" };
  }
  const whole = ruleProbability(answers.rule);
  if (whole === null || whole < ruleAdd) return { kind: "none" };
  let text = message;
  if (sentences.length > 1) {
    const kept = sentences.filter((_, index) => {
      const probability = ruleProbability(answers[`s${index}`]);
      return probability !== null && probability >= ruleAdd;
    });
    if (kept.length === 0) return { kind: "none" };
    text = kept.join(" ");
  }
  const supersedes = answers.supersedes?.type === "choice" ? answers.supersedes : undefined;
  const target = supersedes?.choice;
  const probability = target === undefined ? undefined : supersedes?.probabilities?.[target];
  if (
    target !== undefined && target !== "none" && offered.some((rule) => rule.id === target) &&
    typeof probability === "number" && probability >= TARGET_PROBABILITY && probability <= 1
  ) {
    return { kind: "replace", replaces: target, text };
  }
  return { kind: "add", text };
}
