/**
 * The chat_recall grader. Deterministic and programmatic: pass iff recall answered with the gold message or an accepted
 * `also` message. It reads the outcome and those ids only; it never calls a model. A `failed` outcome is an error,
 * decided by the runner before grading, so it is not graded here.
 */
import type { RecallOutcome } from "../../src/system1/recall.ts";

export interface Verdict {
  readonly pass: boolean;
  readonly explanation: string;
  /** The message recall answered, when it answered one; it can be the gold. */
  readonly found?: number;
  /** Descent path length (levels walked, including the view line). */
  readonly depth?: number;
}

export function grade(outcome: RecallOutcome, gold: number, also: readonly number[] = []): Verdict {
  if (outcome.kind === "found") {
    const depth = outcome.path.length;
    if (outcome.message.id === gold) return { pass: true, found: outcome.message.id, depth, explanation: "pass: the answer is the gold message" };
    if (also.includes(outcome.message.id)) {
      return { pass: true, found: outcome.message.id, depth, explanation: `pass: the answer is message ${outcome.message.id}, which also answers` };
    }
    return { pass: false, found: outcome.message.id, depth, explanation: `fail: answered message ${outcome.message.id} at depth ${depth}` };
  }
  if (outcome.kind === "none") {
    const best = outcome.best === undefined ? "none" : outcome.best.toFixed(2);
    return { pass: false, explanation: `fail: no view line reached min ${outcome.min} (best p=${best})` };
  }
  throw new Error("grade() received a failed outcome; the runner records those as errors");
}
