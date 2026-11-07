import type { Answer, Questions } from "@oh-my-pi/pi-ai";
import { RANK_TERM_CHARS, utf8Prefix } from "../memory.js";
import type { Rule } from "./ledger.js";
import {
  RULE_PROMPT,
  SENTENCE_PROMPT,
  SENTENCE_SUPERSEDES_PROMPT,
  SENTENCE_WITHDRAWS_PROMPT,
  SUPERSEDES_PROMPT,
  type SupersedesPrompt,
  WITHDRAW_PROMPT,
  WITHDRAWS_PROMPT,
} from "./rules-prompt.js";

/** The user message as judged: bounded so one request stays within the judge's state limit. */
export const TRIAGE_MESSAGE_BYTES = 4_000;
/** The newest active rules are always offered for replacement or withdrawal. */
export const NEWEST_RULE_TARGETS = 16;
/** Up to this many older active rules, the ones whose words best match the judged text, are offered too. */
export const RELEVANT_RULE_TARGETS = 16;
/** A replacement or withdrawal target must reach this probability. */
const TARGET_PROBABILITY = 0.5;
/** At most this many sentences are judged one by one; a longer message offers only its first ones. */
export const RULE_SENTENCE_LIMIT = 12;

/** Authority comes from host attribution, never the message text. Only human messages may change this human-only ledger. */
export type RuleAuthority = "human" | "non-human" | "unknown";

/**
 * The judge's answers for one human message: `rule` and `withdraw` always; for a single-sentence message `supersedes` and
 * `withdraws` when rules are offered; for a message with several sentences `s<k>` per sentence, plus `r<k>` and `x<k>`
 * when rules are offered to sentence k. A missing or mistyped answer cannot authorize a mutation.
 */
export type TriageAnswers = Readonly<Record<string, Answer | undefined>>;

/** One ledger change decided for one sentence, or for a single-sentence message, with the rule's text. */
export type RuleChange =
  | { readonly kind: "add"; readonly text: string }
  | { readonly kind: "replace"; readonly replaces: string; readonly text: string }
  | { readonly kind: "remove"; readonly removes: string };

/**
 * One message's triage seen as a single outcome: `none` or one change. Production applies the `RuleChange` list;
 * the rules eval grades this per-message view (evals/rules/grade.ts).
 */
export type TriageDecision = { readonly kind: "none" } | RuleChange;

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

/**
 * The rules offered as replacement or withdrawal targets for one judged text: the newest `NEWEST_RULE_TARGETS` active
 * rules plus the `RELEVANT_RULE_TARGETS` older ones that best match the text's words, at most 32, in ledger order.
 * Relevance is `rankMessages`-style: the text's lowercased words (split on anything but letters and digits) of at least
 * RANK_TERM_CHARS characters, deduplicated, each weighing its BM25 inverse document frequency over the active rules,
 * ln((N - df + 0.5) / (df + 0.5)) floored at 0. A rule matches a word its lowercased text contains and scores the
 * weights of its matches; only scores above 0 are relevant, and a tie goes to the newer rule. Rules offered to no
 * text still hold; `/optchat rules remove` reaches every rule.
 */
export function offeredRules(active: readonly Rule[], text: string): Rule[] {
  if (active.length <= NEWEST_RULE_TARGETS) return [...active];
  const older = active.length - NEWEST_RULE_TARGETS;
  const terms = [...new Set(text.toLowerCase().split(/[^\p{L}\p{N}]+/u))].filter((term) => [...term].length >= RANK_TERM_CHARS);
  const lower = active.map((rule) => rule.text.toLowerCase());
  const weight = terms.map((term) => {
    const df = lower.reduce((count, rule) => (rule.includes(term) ? count + 1 : count), 0);
    return Math.max(0, Math.log((active.length - df + 0.5) / (df + 0.5)));
  });
  const relevant = new Set(
    lower
      .slice(0, older)
      .map((rule, index) => ({ index, score: terms.reduce((sum, term, at) => (rule.includes(term) ? sum + weight[at]! : sum), 0) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || b.index - a.index)
      .slice(0, RELEVANT_RULE_TARGETS)
      .map((entry) => entry.index),
  );
  return active.filter((_, index) => index >= older || relevant.has(index));
}

/**
 * The targets offered per judged unit: one list, for the whole message as the judge sees it, when it has at most one
 * sentence; otherwise one list per sentence, each ranked against that sentence.
 */
export function triageTargets(active: readonly Rule[], message: string, sentences: readonly string[]): Rule[][] {
  return sentences.length > 1
    ? sentences.map((sentence) => offeredRules(active, sentence))
    : [offeredRules(active, utf8Prefix(message, TRIAGE_MESSAGE_BYTES))];
}

/** The judge's state: the user's words, verbatim up to the bound, and the sentences when there are several. */
export function triageState(message: string, sentences: readonly string[]): { message: string; sentences?: readonly string[] } {
  const bounded = utf8Prefix(message, TRIAGE_MESSAGE_BYTES);
  return sentences.length > 1 ? { message: bounded, sentences } : { message: bounded };
}

/** A choice over the offered rule ids plus `none`; each rule's criterion is its own text. */
function targetQuestion(prompt: SupersedesPrompt, offered: readonly Rule[], index?: number): Questions[string] {
  const criteria: Record<string, string | null> = { none: prompt.none };
  for (const rule of offered) criteria[rule.id] = rule.text;
  const instructions = index === undefined ? prompt.instructions : prompt.instructions.replaceAll("{index}", String(index));
  return { type: "choice", instructions, criteria };
}

/**
 * Noul `rule` and `withdraw` questions about the whole message. A single-sentence message adds `supersedes` and
 * `withdraws` choices over `offered[0]` when it is not empty. A message with several sentences instead adds one noul
 * `s<k>` per sentence, and `r<k>` (replaces) and `x<k>` (withdraws) choices over `offered[k]` when it is not empty,
 * so each sentence is decided, and targets its own rule, on its own.
 */
export function triageQuestions(offered: readonly (readonly Rule[])[], sentences: readonly string[] = []): Questions {
  const questions: Questions = {
    rule: { type: "noul", instructions: RULE_PROMPT.instructions, criteria: { ...RULE_PROMPT.criteria } },
    withdraw: { type: "noul", instructions: WITHDRAW_PROMPT.instructions, criteria: { ...WITHDRAW_PROMPT.criteria } },
  };
  if (sentences.length <= 1) {
    const targets = offered[0] ?? [];
    if (targets.length > 0) {
      questions.supersedes = targetQuestion(SUPERSEDES_PROMPT, targets);
      questions.withdraws = targetQuestion(WITHDRAWS_PROMPT, targets);
    }
    return questions;
  }
  for (let index = 0; index < sentences.length; index++) {
    questions[`s${index}`] = {
      type: "noul",
      instructions: SENTENCE_PROMPT.instructions.replaceAll("{index}", String(index)),
      criteria: { ...SENTENCE_PROMPT.criteria },
    };
  }
  for (let index = 0; index < sentences.length; index++) {
    const targets = offered[index] ?? [];
    if (targets.length === 0) continue;
    questions[`r${index}`] = targetQuestion(SENTENCE_SUPERSEDES_PROMPT, targets, index);
    questions[`x${index}`] = targetQuestion(SENTENCE_WITHDRAWS_PROMPT, targets, index);
  }
  return questions;
}

/** P(rule) of one answer; null when it is missing, mistyped or outside the finite probability range. */
function ruleProbability(answer: Answer | undefined): number | null {
  return answer?.type === "noul" && Number.isFinite(answer.noul) && answer.noul >= 0 && answer.noul <= 1 ? answer.noul : null;
}

/** The offered rule a choice names at TARGET_PROBABILITY or more; undefined for `none`, an unoffered id or a bad answer. */
function targetOf(answer: Answer | undefined, offered: readonly Rule[]): string | undefined {
  const picked = answer?.type === "choice" ? answer : undefined;
  const target = picked?.choice;
  const probability = target === undefined ? undefined : picked?.probabilities?.[target];
  return target !== undefined && target !== "none" && offered.some((rule) => rule.id === target) &&
    typeof probability === "number" && probability >= TARGET_PROBABILITY && probability <= 1
    ? target
    : undefined;
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
 * The ledger changes one human message authorizes, in source order; empty when nothing changes. Only host-attributed
 * humans can act, and a missing or malformed `withdraw` answer authorizes nothing.
 * When `withdraw` reaches `ruleAdd` the message only withdraws: each unit (the whole message, or each of several
 * sentences) removes the offered target its `withdraws` / `x<k>` choice names at 0.5 or more; an unknown or missing
 * target does nothing and never becomes an added rule.
 * Otherwise, when `rule` reaches `ruleAdd`: a single-sentence message adds itself, or replaces the offered rule its
 * `supersedes` names at 0.5 or more; with several sentences, each sentence whose own `s<k>` reaches `ruleAdd` becomes
 * its own rule, the whole sentence as its text, replacing the offered rule its `r<k>` names at 0.5 or more. A missing
 * sentence answer counts as no. A rule is replaced or removed at most once per message; a later sentence naming it again
 * adds instead of replacing, or does nothing when withdrawing.
 * The caller must still require each target to be active when applying the changes after a judge wait.
 */
export function decideTriage(
  authority: RuleAuthority,
  answers: TriageAnswers,
  offered: readonly (readonly Rule[])[],
  ruleAdd: number,
  message: string,
  sentences: readonly string[] = [],
): RuleChange[] {
  if (authority !== "human") return [];
  const withdrawal = ruleProbability(answers.withdraw);
  if (withdrawal === null) return [];
  const several = sentences.length > 1;
  const units = several ? sentences : [message];
  const targeted = new Set<string>();
  const changes: RuleChange[] = [];
  if (withdrawal >= ruleAdd) {
    units.forEach((_, index) => {
      const target = targetOf(answers[several ? `x${index}` : "withdraws"], offered[index] ?? []);
      if (target === undefined || targeted.has(target)) return;
      targeted.add(target);
      changes.push({ kind: "remove", removes: target });
    });
    return changes;
  }
  const whole = ruleProbability(answers.rule);
  if (whole === null || whole < ruleAdd) return [];
  units.forEach((text, index) => {
    if (several) {
      const probability = ruleProbability(answers[`s${index}`]);
      if (probability === null || probability < ruleAdd) return;
    }
    const target = targetOf(answers[several ? `r${index}` : "supersedes"], offered[index] ?? []);
    if (target === undefined || targeted.has(target)) {
      changes.push({ kind: "add", text });
      return;
    }
    targeted.add(target);
    changes.push({ kind: "replace", replaces: target, text });
  });
  return changes;
}
