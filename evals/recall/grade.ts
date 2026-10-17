/**
 * The chat_recall grader. Deterministic and programmatic; it never calls a model. Judged ids decide first: the gold or
 * an `also` id passes and a `no` id fails. Only an unjudged answer falls through to the case's answer key, and passes iff
 * the page recall returned contains every phrase of some key alternative. A `failed` outcome is an error, decided by
 * the runner before grading, so it is not graded here.
 */
import type { RecallOutcome } from "../../src/system1/recall.ts";

/** Alternatives; an alternative matches when every one of its phrases occurs in the text. */
export type AnswerKey = readonly (readonly string[])[];

export interface Expected {
  readonly gold: number;
  readonly also?: readonly number[];
  readonly no?: readonly number[];
  readonly key?: AnswerKey;
}

export interface Verdict {
  readonly pass: boolean;
  readonly explanation: string;
  /** The message recall answered, when it answered one; it can be the gold. */
  readonly found?: number;
  /** Path length: 1 for a message answered directly, 2 when a scanned view line covers it. */
  readonly depth?: number;
  /** Whether the answered message was judged (gold, `also` or `no`) rather than graded by the answer key. Found outcomes only. */
  readonly judged?: boolean;
}

/** Lowercase, every run of whitespace collapsed to one space, trimmed. */
export function normalizeForKey(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/** True iff some alternative has every phrase, normalized, contained in the normalized text. */
export function keyMatches(text: string, key: AnswerKey): boolean {
  const haystack = normalizeForKey(text);
  return key.some((alternative) => alternative.every((phrase) => haystack.includes(normalizeForKey(phrase))));
}

/** A graded result row as results.jsonl stores it. */
export interface ScoredRow {
  readonly prompt_id: string;
  readonly grade: boolean;
  readonly found?: number;
}

export interface RateCount {
  readonly n: number;
  readonly credited: number;
  readonly credited_rate: number;
  /** Passes whose answered message is the gold itself: no `also` or answer-key credit. */
  readonly gold_only: number;
  readonly gold_only_rate: number;
}

export interface ScoreSummary extends RateCount {
  /** Keyed by the gold message's store kind (user, talk, echo, ...; "synthetic" for synthetic cases). */
  readonly by_gold_kind: Record<string, RateCount>;
}

function rates(rows: readonly { pass: boolean; gold: boolean }[]): RateCount {
  const n = rows.length;
  const credited = rows.filter((row) => row.pass).length;
  const goldOnly = rows.filter((row) => row.gold).length;
  return { n, credited, credited_rate: n === 0 ? 0 : credited / n, gold_only: goldOnly, gold_only_rate: n === 0 ? 0 : goldOnly / n };
}

/**
 * Credited and gold-only pass rates, overall and per gold kind. Rows whose case is not in `cases` are skipped. Credited
 * is the grade as recorded; gold-only counts a row only when it passed by answering the gold message.
 */
export function scoreSummary(rows: readonly ScoredRow[], cases: ReadonlyMap<string, { gold: number; kind: string }>): ScoreSummary {
  const scored: { kind: string; pass: boolean; gold: boolean }[] = [];
  for (const row of rows) {
    const c = cases.get(row.prompt_id);
    if (c === undefined) continue;
    scored.push({ kind: c.kind, pass: row.grade, gold: row.grade && row.found === c.gold });
  }
  const kinds = [...new Set(scored.map((row) => row.kind))].sort();
  return { ...rates(scored), by_gold_kind: Object.fromEntries(kinds.map((kind) => [kind, rates(scored.filter((row) => row.kind === kind))])) };
}

export function formatScores(scores: ScoreSummary): string {
  const line = (label: string, r: RateCount) =>
    `${label}: n ${r.n}, credited ${r.credited} (${r.credited_rate.toFixed(3)}), gold-only ${r.gold_only} (${r.gold_only_rate.toFixed(3)})`;
  return [line("all", scores), ...Object.entries(scores.by_gold_kind).map(([kind, r]) => `  ${line(kind, r)}`)].join("\n");
}

export function grade(outcome: RecallOutcome, expected: Expected): Verdict {
  if (outcome.kind === "found") {
    const depth = outcome.path.length;
    const id = outcome.message.id;
    if (id === expected.gold) return { pass: true, found: id, depth, judged: true, explanation: "pass: the answer is the gold message" };
    if (expected.also?.includes(id)) {
      return { pass: true, found: id, depth, judged: true, explanation: `pass: the answer is message ${id}, which also answers` };
    }
    if (expected.no?.includes(id)) {
      return { pass: false, found: id, depth, judged: true, explanation: `fail: answered message ${id} at depth ${depth}` };
    }
    if (expected.key === undefined) {
      return { pass: false, found: id, depth, judged: false, explanation: `fail: answered message ${id} at depth ${depth}` };
    }
    if (keyMatches(outcome.message.text, expected.key)) {
      return { pass: true, found: id, depth, judged: false, explanation: `pass: message ${id} is unjudged and contains the answer key` };
    }
    return {
      pass: false,
      found: id,
      depth,
      judged: false,
      explanation: `fail: answered message ${id} at depth ${depth} (unjudged, no answer-key match)`,
    };
  }
  if (outcome.kind === "none") {
    const best = outcome.best === undefined ? "none" : outcome.best.toFixed(2);
    return { pass: false, explanation: `fail: no view line reached min ${outcome.min} (best p=${best})` };
  }
  throw new Error("grade() received a failed outcome; the runner records those as errors");
}
