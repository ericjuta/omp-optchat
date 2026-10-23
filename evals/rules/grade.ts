/**
 * The rules-triage grader. Deterministic and programmatic: it reads the production decision (decideTriage's result),
 * the gold label, and, for a mixed message, the sentences the gold keeps. It never calls a model.
 *
 * Per case, `pass` means the decision matches the label:
 *   - not a rule: no change (`none`).
 *   - a rule with no `supersedes`: added (`add`), not a replacement.
 *   - a rule with `supersedes`: replaces exactly that offered rule.
 *   - a mixed message with `keep`: the rule text is the kept sentences, in order.
 *
 * Precision, recall and F1 are over rule adds, where a replacement also counts as an add: a predicted add is any
 * decision other than `none`. A precision with no predicted adds is 0, by convention.
 */
import type { TriageDecision } from "../../src/system1/rules.ts";

export interface RuleGold {
  readonly rule: boolean;
  /** The offered rule id this message replaces. Present only when a rule should replace one. */
  readonly supersedes?: string;
  /** Sentence indices the rule keeps, for a mixed message only. */
  readonly keep?: readonly number[];
}

export interface Verdict {
  readonly pass: boolean;
  readonly explanation: string;
  /** 0 or 1 counts for the confusion matrix, one case each. */
  readonly tp: number;
  readonly fp: number;
  readonly fn: number;
  readonly tn: number;
  /** Present only for a gold replacement: the decision replaced the named rule. */
  readonly replaceCorrect?: boolean;
}

/** The text a rule should keep for a mixed message, or undefined when the gold names no sentences. */
export function expectedText(sentences: readonly string[], gold: RuleGold): string | undefined {
  if (gold.keep === undefined) return undefined;
  return gold.keep.map((index) => sentences[index] ?? "").join(" ");
}

export function grade(decision: TriageDecision, gold: RuleGold, sentences: readonly string[]): Verdict {
  const predicted = decision.kind !== "none";
  const tp = gold.rule && predicted ? 1 : 0;
  const fp = !gold.rule && predicted ? 1 : 0;
  const fn = gold.rule && !predicted ? 1 : 0;
  const tn = !gold.rule && !predicted ? 1 : 0;
  const counts = { tp, fp, fn, tn };

  // This corpus labels add/replace/none only. A withdrawal must not silently pass as an ordinary no-op.
  if (decision.kind === "remove") {
    return { ...counts, pass: false, explanation: "fail: withdrawal is outside this add/replace case's contract" };
  }

  if (!gold.rule) {
    return predicted
      ? { ...counts, pass: false, explanation: `fail: not a rule, but the gate ${decision.kind === "replace" ? "replaced a rule" : "added a rule"}` }
      : { ...counts, pass: true, explanation: "pass: not a rule, no change" };
  }

  const want = expectedText(sentences, gold);
  const textOk = want === undefined || (predicted && decision.text === want);

  if (gold.supersedes !== undefined) {
    const replaceCorrect = decision.kind === "replace" && decision.replaces === gold.supersedes;
    if (!replaceCorrect) {
      return { ...counts, replaceCorrect: false, pass: false, explanation: `fail: should replace ${gold.supersedes}, decision was ${decision.kind}` };
    }
    if (!textOk) return { ...counts, replaceCorrect, pass: false, explanation: "fail: replaced the right rule with the wrong text" };
    return { ...counts, replaceCorrect, pass: true, explanation: `pass: replaced ${gold.supersedes}` };
  }

  if (decision.kind !== "add") {
    return { ...counts, pass: false, explanation: decision.kind === "none" ? "fail: a rule was not added" : "fail: replaced a rule instead of adding" };
  }
  if (!textOk) return { ...counts, pass: false, explanation: "fail: added a rule with the wrong text" };
  return { ...counts, pass: true, explanation: "pass: rule added" };
}

export interface Row {
  readonly pass: boolean;
  readonly tp: number;
  readonly fp: number;
  readonly fn: number;
  readonly tn: number;
  readonly replaceCorrect?: boolean;
}

export interface Summary {
  readonly cases: number;
  /** Pass rate per case: the ratchet target `score`. */
  readonly score: number;
  readonly precision: number;
  readonly recall: number;
  readonly f1: number;
  readonly tp: number;
  readonly fp: number;
  readonly fn: number;
  readonly tn: number;
  /** Correct replacements over gold replacements; undefined when the set has none. */
  readonly replaceAccuracy?: number;
}

/** Pass rate and rule-add precision, recall and F1 over a set of graded rows. No model call. */
export function summarize(rows: readonly Row[]): Summary {
  let passed = 0;
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  let replacements = 0;
  let replacedRight = 0;
  for (const row of rows) {
    if (row.pass) passed++;
    tp += row.tp;
    fp += row.fp;
    fn += row.fn;
    tn += row.tn;
    if (row.replaceCorrect !== undefined) {
      replacements++;
      if (row.replaceCorrect) replacedRight++;
    }
  }
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return {
    cases: rows.length,
    score: rows.length === 0 ? 0 : passed / rows.length,
    precision,
    recall,
    f1,
    tp,
    fp,
    fn,
    tn,
    replaceAccuracy: replacements === 0 ? undefined : replacedRight / replacements,
  };
}
