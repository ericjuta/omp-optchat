/**
 * The evidence eval's frozen grader. Pure functions over what each arm returned; no model call.
 *
 * A answerable: success when recall's message is a gold id that holds the answer; a found wrong message misleads;
 *   `none` omits. Abstain: success on `none`; any found message misleads.
 * B never asserts an answer. Answerable: success when a passage from a gold id contains the answer; otherwise an
 *   omission. Abstain: success (no claim).
 * C (B plus the extractor line) asserts when it shows an answer: a located span, or an unlocated value below the null
 *   threshold. Answerable: success when the located span is in a gold id and contains the answer, at most three times
 *   its length plus 32 bytes; shown otherwise misleads; not shown omits. Abstain: success when nothing is shown.
 */
export type Verdict = "success" | "misleading" | "omission";

const norm = (text: string): string => text.toLowerCase().replace(/\s+/g, " ").trim();
const bytes = (text: string): number => Buffer.byteLength(text);

export interface Gold {
  readonly ids: readonly number[];
  readonly answer: string;
}

export function gradeA(gold: Gold | null, found: { id: number; full: string } | null): Verdict {
  if (gold === null) return found ? "misleading" : "success";
  if (!found) return "omission";
  return gold.ids.includes(found.id) && norm(found.full).includes(norm(gold.answer)) ? "success" : "misleading";
}

export function gradeB(gold: Gold | null, passages: ReadonlyArray<{ id: number; text: string }>): Verdict {
  if (gold === null) return "success";
  return passages.some((p) => gold.ids.includes(p.id) && norm(p.text).includes(norm(gold.answer))) ? "success" : "omission";
}

/** `located` is the mapped span; `shown` is true when the line asserts any answer, located or not. */
export function gradeC(gold: Gold | null, shown: boolean, located: { id: number; text: string } | null): Verdict {
  if (!shown) return gold === null ? "success" : "omission";
  if (gold === null) return "misleading";
  const ok =
    located !== null &&
    gold.ids.includes(located.id) &&
    norm(located.text).includes(norm(gold.answer)) &&
    bytes(located.text) <= 3 * bytes(gold.answer) + 32;
  return ok ? "success" : "misleading";
}

export interface ArmScores {
  readonly rows: number;
  readonly answerable: number;
  readonly abstain: number;
  /** Success over answerable rows. */
  readonly groundedSuccess: number;
  /** Success over abstain rows. */
  readonly abstainSuccess: number;
  /** Misleading over all rows. */
  readonly misleading: number;
  /** Omission over answerable rows. */
  readonly omission: number;
  readonly latencyP50: number;
  readonly latencyP90: number;
  /** Null when any row's cost is unknown. */
  readonly costUsd: number | null;
  readonly costPerSuccess: number | null;
}

export interface Row {
  readonly arm: "A" | "B" | "C";
  readonly abstain: boolean;
  readonly verdict: Verdict;
  readonly ms: number;
  /** Null is unknown. B is always 0: no provider call. */
  readonly costUsd: number | null;
}

const quantile = (values: number[], q: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
};

export function score(rows: readonly Row[]): ArmScores {
  const answerable = rows.filter((r) => !r.abstain);
  const abstain = rows.filter((r) => r.abstain);
  const rate = (part: number, whole: number): number => (whole === 0 ? 0 : part / whole);
  const successes = rows.filter((r) => r.verdict === "success").length;
  const known = rows.every((r) => r.costUsd !== null);
  const cost = known ? rows.reduce((sum, r) => sum + r.costUsd!, 0) : null;
  return {
    rows: rows.length,
    answerable: answerable.length,
    abstain: abstain.length,
    groundedSuccess: rate(answerable.filter((r) => r.verdict === "success").length, answerable.length),
    abstainSuccess: rate(abstain.filter((r) => r.verdict === "success").length, abstain.length),
    misleading: rate(rows.filter((r) => r.verdict === "misleading").length, rows.length),
    omission: rate(answerable.filter((r) => r.verdict === "omission").length, answerable.length),
    latencyP50: quantile(rows.map((r) => r.ms), 0.5),
    latencyP90: quantile(rows.map((r) => r.ms), 0.9),
    costUsd: cost,
    costPerSuccess: cost === null || successes === 0 ? null : cost / successes,
  };
}
