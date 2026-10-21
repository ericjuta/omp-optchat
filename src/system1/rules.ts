import type { Answer, Questions } from "@oh-my-pi/pi-ai";
import { utf8Prefix } from "../memory.js";
import type { Rule } from "./ledger.js";
import { RULE_PROMPT, SENTENCE_PROMPT, SUPERSEDES_PROMPT } from "./rules-prompt.js";

/** The user message as judged: bounded so one request stays within the judge's state limit. */
export const TRIAGE_MESSAGE_BYTES = 4_000;
/** Only the newest active rules are offered to `supersedes`; older ones still hold, but cannot be replaced. */
export const SUPERSEDE_RULE_LIMIT = 32;
/** A `supersedes` choice must reach this probability to replace a rule. */
const REPLACE_PROBABILITY = 0.5;
/** At most this many sentences are judged one by one; a longer message offers only its first ones. */
export const RULE_SENTENCE_LIMIT = 12;

/**
 * The judge's answers for one user message: `rule` always, `supersedes` when rules exist, `s<k>` per sentence when there are several.
 * A missing or mistyped answer counts as probability 0.
 */
export type TriageAnswers = Readonly<Record<string, Answer | undefined>>;

/** What one triage decided, with the rule's text. `none` leaves the ledger untouched. */
export type TriageDecision =
  | { readonly kind: "none" }
  | { readonly kind: "add"; readonly text: string }
  | { readonly kind: "replace"; readonly replaces: string; readonly text: string };

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

/** The rules offered to `supersedes`: the newest `SUPERSEDE_RULE_LIMIT`. */
export function offeredRules(active: readonly Rule[]): Rule[] {
  return active.slice(-SUPERSEDE_RULE_LIMIT);
}

/** The judge's state: the user's words, verbatim up to the bound, and the sentences when there are several. */
export function triageState(message: string, sentences: readonly string[]): { message: string; sentences?: readonly string[] } {
  const bounded = utf8Prefix(message, TRIAGE_MESSAGE_BYTES);
  return sentences.length > 1 ? { message: bounded, sentences } : { message: bounded };
}

/**
 * One noul `rule` question, plus a choice `supersedes` over `none` and the offered rule ids when rules exist,
 * plus one noul `s<k>` per sentence when the message has several, so the rule keeps only the sentences that state it.
 */
export function triageQuestions(offered: readonly Rule[], sentences: readonly string[] = []): Questions {
  const questions: Questions = {
    rule: { type: "noul", instructions: RULE_PROMPT.instructions, criteria: { ...RULE_PROMPT.criteria } },
  };
  if (offered.length > 0) {
    const criteria: Record<string, string | null> = { none: SUPERSEDES_PROMPT.none };
    for (const rule of offered) criteria[rule.id] = rule.text;
    questions.supersedes = {
      type: "choice",
      instructions: SUPERSEDES_PROMPT.instructions,
      criteria,
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

/** P(rule) of one answer; null when it is missing, mistyped or not a finite number. */
function ruleProbability(answer: Answer | undefined): number | null {
  return answer?.type === "noul" && Number.isFinite(answer.noul) ? answer.noul : null;
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
 * Add when P(rule) reaches `ruleAdd`. Replace instead when `supersedes` names a listed rule at 0.5 or more.
 * A message that fails the rule threshold never changes the ledger, whatever `supersedes` says.
 * With several sentences, the rule's text is the sentences whose own `s<k>` reaches `ruleAdd`, in order;
 * when none does, or an answer is missing, nothing changes. A single sentence keeps the whole message.
 */
export function decideTriage(
  answers: TriageAnswers,
  offered: readonly Rule[],
  ruleAdd: number,
  message: string,
  sentences: readonly string[] = [],
): TriageDecision {
  const whole = answers.rule;
  if (!(whole?.type === "noul" && whole.noul >= ruleAdd)) return { kind: "none" };
  let text = message;
  if (sentences.length > 1) {
    const kept = sentences.filter((_, index) => {
      const answer = answers[`s${index}`];
      return answer?.type === "noul" && answer.noul >= ruleAdd;
    });
    if (kept.length === 0) return { kind: "none" };
    text = kept.join(" ");
  }
  const supersedes = answers.supersedes?.type === "choice" ? answers.supersedes : undefined;
  const target = supersedes?.choice;
  if (
    target !== undefined && target !== "none" && offered.some((rule) => rule.id === target) &&
    (supersedes?.probabilities[target] ?? 0) >= REPLACE_PROBABILITY
  ) {
    return { kind: "replace", replaces: target, text };
  }
  return { kind: "add", text };
}
