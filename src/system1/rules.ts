import type { Answer, Questions } from "@oh-my-pi/pi-ai";
import { utf8Prefix } from "../memory.js";
import type { Rule } from "./ledger.js";

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
    rule: {
      type: "noul",
      instructions: "The message states a standing instruction or preference meant to hold for future replies, not a one-off request.",
      criteria: {
        true: "a rule or preference that should keep applying in later turns",
        false: "a one-off request, a question, or ordinary task content",
      },
    },
  };
  if (offered.length > 0) {
    const criteria: Record<string, string | null> = { none: "the message does not replace any listed rule" };
    for (const rule of offered) criteria[rule.id] = rule.text;
    questions.supersedes = {
      type: "choice",
      instructions: "The message replaces or overrides exactly one of the listed rules, or none.",
      criteria,
    };
  }
  if (sentences.length > 1) {
    for (let index = 0; index < sentences.length; index++) {
      questions[`s${index}`] = {
        type: "noul",
        instructions: `State field sentences[${index}] itself states a standing instruction or preference meant to hold for future replies.`,
        criteria: {
          true: "this sentence states a rule or preference that should keep applying in later turns",
          false: "this sentence is a one-off request, a question, context, or ordinary task content",
        },
      };
    }
  }
  return questions;
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
