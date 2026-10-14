import type { ChoiceAnswer, Judge, NoulAnswer, Questions } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { utf8Prefix } from "../memory.js";
import { boundedGateError, judgeWithin, packByBytes, utf8Length } from "./judge.js";
import { PREFETCH_IN_FLIGHT, PREFETCH_QUESTIONS, PREFETCH_STATE_BYTES, type ViewLine } from "./prefetch.js";
import { RECALL_DESCENT, RECALL_SCORE_INSTRUCTION } from "./recall-prompt.js";

/** The question as judged and shown: 1 to this many characters. */
export const RECALL_QUESTION_CHARS = 1_000;
/** A view line's text, as judged and as shown on the path, stays within this many UTF-8 bytes. */
export const RECALL_TEXT_BYTES = 4_000;
/** The answering message's first page, as returned: the rest is reached by `zoom(id, 1, offset)`. */
export const RECALL_PAGE_BYTES = 8_000;
/** Wall bound for the whole recall, unless the caller passes `timeoutMs`. */
export const RECALL_MS = 20_000;
/** Wall bound for one judge call: a scoring request or one descent step. */
export const RECALL_STEP_MS = 5_000;
/** The most view lines one recall descends from. */
export const RECALL_K_MAX = 8;
/** Descents running at once; the rest of the k wait for a slot. */
export const RECALL_DESCENT_IN_FLIGHT = 4;
/** The most raw-log matches one recall adds as candidate lines. */
export const RECALL_SEEDS_MAX = 32;

/** The memory as recall sees it. Memory satisfies this structurally through an adapter over its zoom. */
export interface RecallMemory {
  viewLines(): ReadonlyArray<{ id: number; n: number; text: string }>;
  lineAt(id: number, n: number): { id: number; n: number; text: string } | undefined;
  page(id: number): { text: string; next: number | null; totalBytes: number };
  /** The stored messages whose words best match `question` in the raw log, best first, at most `limit`. No model call. */
  rank(question: string, limit: number): number[];
}

export interface RecallOptions {
  readonly judge: Judge;
  /** Trimmed, whitespace runs collapsed, and 1 to RECALL_QUESTION_CHARS characters. */
  readonly question: string;
  /** Minimum P(answer) for a descent's first line, in (0, 1]. */
  readonly min: number;
  /** How many of the top lines at or above `min` to descend from, 1 to RECALL_K_MAX. Absent means 1: the single argmax descent. */
  readonly k?: number;
  /** Raw-log matches added as single-message candidates, 0 to RECALL_SEEDS_MAX. Absent means 0. */
  readonly seeds?: number;
  /** Overall bound; overrides RECALL_MS. */
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

/** One line on the descent path. `p` is the probability that chose it; a forced step (one child missing) has none. */
export interface RecallStep {
  readonly id: number;
  readonly n: number;
  readonly text: string;
  readonly p?: number;
}

/** A candidate the winning descent beat: a message with its path probability, or a descent that failed. */
export type RecallOther =
  | { readonly kind: "answer"; readonly id: number; readonly p: number }
  | { readonly kind: "failed"; readonly id: number; readonly n: number; readonly reason: string };

export type RecallOutcome =
  | {
      readonly kind: "found";
      readonly question: string;
      /** The winning descent, from its view line down to the message. */
      readonly path: readonly RecallStep[];
      /** The other candidates in rank order; always empty for k=1. */
      readonly others: readonly RecallOther[];
      readonly message: { readonly id: number; readonly text: string; readonly shownBytes: number; readonly totalBytes: number };
      /** Set when the winner is a raw-log match: one message whose words matched the question, not a view line. */
      readonly raw?: true;
    }
  | { readonly kind: "none"; readonly min: number; readonly best?: number }
  | { readonly kind: "failed"; readonly reason: string };

/**
 * The message most likely to answer `question`. A relevance gate scores the merged view lines; the top `k` at or above
 * `min` each descend, one choice per level into the likelier half, to a single message. A message's probability is its
 * start line's score times each choice's probability on its descent, and the most probable message answers. A descent
 * that fails is one failed candidate, not a failed recall, unless every descent failed. Never throws: any failure,
 * timeout or cancellation is a `failed` outcome, and no answer is ever guessed.
 * Raw-log matches (seeds) are single-message candidates: scored in the same requests as the view lines, then ranked with them.
 */
export async function recall(memory: RecallMemory, options: RecallOptions): Promise<RecallOutcome> {
  const question = options.question.trim().replace(/\s+/g, " ");
  if (question.length === 0 || [...question].length > RECALL_QUESTION_CHARS) {
    return { kind: "failed", reason: `the question must be 1 to ${RECALL_QUESTION_CHARS} characters` };
  }
  const k = options.k ?? 1;
  if (!Number.isSafeInteger(k) || k < 1 || k > RECALL_K_MAX) {
    return { kind: "failed", reason: `k must be an integer from 1 to ${RECALL_K_MAX}` };
  }
  const seeds = options.seeds ?? 0;
  if (!Number.isSafeInteger(seeds) || seeds < 0 || seeds > RECALL_SEEDS_MAX) {
    return { kind: "failed", reason: `seeds must be an integer from 0 to ${RECALL_SEEDS_MAX}` };
  }
  const bound = new AbortController();
  const onParent = () => bound.abort(options.signal?.reason);
  if (options.signal?.aborted) onParent();
  options.signal?.addEventListener("abort", onParent, { once: true });
  const timer = setTimeout(() => bound.abort(new Error("recall exceeded its bound")), options.timeoutMs ?? RECALL_MS);
  try {
    const outcome = await search(memory, options.judge, question, options.min, k, seeds, bound.signal);
    if (!bound.signal.aborted) return outcome;
    return { kind: "failed", reason: options.signal?.aborted ? "cancelled" : "the recall bound passed" };
  } catch (error) {
    if (bound.signal.aborted) return { kind: "failed", reason: options.signal?.aborted ? "cancelled" : "the recall bound passed" };
    return { kind: "failed", reason: boundedGateError(error) };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onParent);
  }
}

/** A candidate line: a view line, or a raw-log match (`raw`), one message whose words matched the question. */
interface Candidate extends ViewLine {
  readonly raw: boolean;
}

/** A view line with its probability that it holds the answer. */
interface Scored {
  readonly line: Candidate;
  readonly p: number;
}

/** How one descent ended: the chain it walked, or the start it failed from and why. */
type Descent =
  | { readonly kind: "chain"; readonly path: readonly RecallStep[]; readonly leaf: RecallStep; readonly p: number; readonly raw: boolean }
  | { readonly kind: "failed"; readonly id: number; readonly n: number; readonly reason: string };

async function search(
  memory: RecallMemory,
  judge: Judge,
  question: string,
  min: number,
  k: number,
  seeds: number,
  signal: AbortSignal,
): Promise<RecallOutcome> {
  const lines: Candidate[] = memory
    .viewLines()
    .map((line) => ({ id: line.id, n: line.n, text: utf8Prefix(line.text, RECALL_TEXT_BYTES), raw: false }));
  if (seeds > 0) {
    // A message a view line already is (n = 1) stays one candidate: the view line.
    const covered = new Set(lines.filter((line) => line.n === 1).map((line) => line.id));
    for (const id of memory.rank(question, seeds)) {
      if (covered.has(id)) continue;
      covered.add(id);
      lines.push({ id, n: 1, text: utf8Prefix(memory.page(id).text, RECALL_TEXT_BYTES), raw: true });
    }
  }
  if (lines.length === 0) return { kind: "none", min };
  const scores = await scoreLines(judge, question, lines, signal);
  if (scores.scored.length === 0 && scores.failures.length > 0) return { kind: "failed", reason: scores.failures[0]! };
  // Higher probability first; a tie goes to the newer line, as the single argmax always chose.
  const ranked = [...scores.scored].sort((a, b) => b.p - a.p || b.line.id - a.line.id);
  const best = ranked[0];
  if (!best || best.p < min) return { kind: "none", min, best: best?.p };
  const starts = ranked.filter((entry) => entry.p >= min).slice(0, k);
  return choose(memory, question, await descendAll(memory, judge, question, starts, signal));
}

/**
 * The relevance gate: one noul question per line (RECALL_SCORE_INSTRUCTION with the line's `id+n` key), in requests
 * whose state is `{ question, lines }`, packed within the prefetch gate's state and question limits, PREFETCH_IN_FLIGHT
 * at once, each within RECALL_STEP_MS. At the shipped wording the requests are byte-identical to the prefetch scorer's.
 * Never throws: a failed or skipped request contributes no lines and one bounded error; a non-number answer is dropped.
 */
async function scoreLines(
  judge: Judge,
  question: string,
  lines: readonly Candidate[],
  signal: AbortSignal,
): Promise<{ scored: Array<{ line: Candidate; p: number }>; failures: string[] }> {
  const keyed = lines.map((line) => ({ line, key: `${line.id}+${line.n}` }));
  const chunks = packByBytes(
    keyed,
    utf8Length(JSON.stringify({ question, lines: {} })),
    (entry) => utf8Length(JSON.stringify(entry.key)) + utf8Length(JSON.stringify(entry.line.text)) + 2,
    PREFETCH_STATE_BYTES,
    PREFETCH_QUESTIONS,
  );
  const scored: Array<{ line: Candidate; p: number }>[] = [];
  const failures: string[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < chunks.length) {
      const index = next++;
      const chunk = chunks[index]!;
      if (signal.aborted) {
        failures.push("not sent: the bound passed");
        continue;
      }
      const map: Record<string, string> = {};
      const questions: Questions = {};
      for (const { line, key } of chunk) {
        map[key] = line.text;
        questions[key] = { type: "noul", instructions: RECALL_SCORE_INSTRUCTION.replaceAll("{line}", key) };
      }
      try {
        const result = await judgeWithin(judge, { state: { question, lines: map }, questions }, RECALL_STEP_MS, signal);
        scored[index] = chunk
          .map(({ line, key }) => ({ line, p: (result.answers[key] as NoulAnswer).noul }))
          .filter((entry) => typeof entry.p === "number" && !Number.isNaN(entry.p));
      } catch (error) {
        failures.push(boundedGateError(error));
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PREFETCH_IN_FLIGHT, chunks.length) }, worker));
  return { scored: scored.flat(), failures };
}

/** Every start's descent, at most RECALL_DESCENT_IN_FLIGHT at once. Results keep the starts' rank order. */
async function descendAll(
  memory: RecallMemory,
  judge: Judge,
  question: string,
  starts: readonly Scored[],
  signal: AbortSignal,
): Promise<Descent[]> {
  const results: Descent[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < starts.length) {
      const rank = next++;
      results[rank] = await descendFrom(memory, judge, question, starts[rank]!, signal);
    }
  };
  await Promise.all(Array.from({ length: Math.min(RECALL_DESCENT_IN_FLIGHT, starts.length) }, worker));
  return results;
}

/** One descent from a scored line: one choice per level into the likelier half, until a single message remains. Never throws. */
async function descendFrom(
  memory: RecallMemory,
  judge: Judge,
  question: string,
  start: Scored,
  signal: AbortSignal,
): Promise<Descent> {
  const top: RecallStep = { id: start.line.id, n: start.line.n, text: start.line.text, p: start.p };
  const failed = (reason: string): Descent => ({ kind: "failed", id: top.id, n: top.n, reason });
  if (signal.aborted) return failed("not started: the bound passed");
  const path: RecallStep[] = [top];
  let current = top;
  try {
    while (current.n > 1) {
      const half = current.n / 2;
      const low = memory.lineAt(current.id, half);
      const high = memory.lineAt(current.id + half, half);
      if (!low && !high) return failed(`no built children under line ${current.id}+${current.n}`);
      let step: RecallStep;
      if (low && high) {
        const pick = await descend(judge, question, low.text, high.text, signal);
        const side = pick.picked === "first" ? low : high;
        step = { id: side.id, n: side.n, text: utf8Prefix(side.text, RECALL_TEXT_BYTES), p: pick.p };
      } else {
        const only = (low ?? high)!;
        step = { id: only.id, n: only.n, text: utf8Prefix(only.text, RECALL_TEXT_BYTES) };
      }
      path.push(step);
      current = step;
    }
  } catch (error) {
    return failed(boundedGateError(error));
  }
  return { kind: "chain", path, leaf: current, p: chainProbability(path), raw: start.line.raw };
}

/**
 * The winning chain. A message reached by several descents (overlapping view lines) competes once, with its likeliest
 * chain; the earlier-ranked chain wins a tie. The most probable chain answers, and a tie goes to the higher-ranked start.
 * Only the winner's message is read. With no chain at all, every descent failed and the first failure is the reason.
 */
function choose(memory: RecallMemory, question: string, descents: readonly Descent[]): RecallOutcome {
  const likeliest = new Map<number, { readonly rank: number; readonly p: number }>();
  descents.forEach((descent, rank) => {
    if (descent.kind !== "chain") return;
    const seen = likeliest.get(descent.leaf.id);
    if (seen === undefined || descent.p > seen.p) likeliest.set(descent.leaf.id, { rank, p: descent.p });
  });
  const candidates = descents.filter(
    (descent, rank) => descent.kind === "failed" || likeliest.get(descent.leaf.id)!.rank === rank,
  );
  let winner: Extract<Descent, { kind: "chain" }> | undefined;
  for (const candidate of candidates) {
    if (candidate.kind === "chain" && (winner === undefined || candidate.p > winner.p)) winner = candidate;
  }
  if (winner === undefined) {
    const failure = candidates.find((candidate) => candidate.kind === "failed");
    return { kind: "failed", reason: failure?.kind === "failed" ? failure.reason : "no descent ran" };
  }
  const page = memory.page(winner.leaf.id);
  const text = utf8Prefix(page.text, RECALL_PAGE_BYTES);
  const others: RecallOther[] = [];
  for (const candidate of candidates) {
    if (candidate === winner) continue;
    others.push(
      candidate.kind === "chain"
        ? { kind: "answer", id: candidate.leaf.id, p: candidate.p }
        : { kind: "failed", id: candidate.id, n: candidate.n, reason: candidate.reason },
    );
  }
  return {
    kind: "found",
    question,
    path: winner.path,
    others,
    message: { id: winner.leaf.id, text, shownBytes: utf8Length(text), totalBytes: page.totalBytes },
    ...(winner.raw ? { raw: true as const } : {}),
  };
}

/** A path's probability under the chain model: the start's score times each choice's probability. Forced steps add none. */
function chainProbability(path: readonly RecallStep[]): number {
  return path.reduce((product, step) => (step.p === undefined ? product : product * step.p), 1);
}

/** One choice between two sibling lines. A tie goes to the second, the newer line. */
async function descend(
  judge: Judge,
  question: string,
  first: string,
  second: string,
  signal: AbortSignal,
): Promise<{ readonly picked: "first" | "second"; readonly p: number }> {
  const questions: Questions = {
    side: {
      type: "choice",
      instructions: RECALL_DESCENT.instructions,
      criteria: { ...RECALL_DESCENT.criteria },
    },
  };
  const state = { question, first: utf8Prefix(first, RECALL_TEXT_BYTES), second: utf8Prefix(second, RECALL_TEXT_BYTES) };
  const result = await judgeWithin(judge, { state, questions }, RECALL_STEP_MS, signal);
  const answer = result.answers.side as ChoiceAnswer<string>;
  const pFirst = answer.probabilities.first ?? 0;
  const pSecond = answer.probabilities.second ?? 0;
  return pFirst > pSecond ? { picked: "first", p: pFirst } : { picked: "second", p: pSecond };
}

/**
 * The outcome as the tool shows it. `found` lists the winning descent path, then, when there are other candidates, the
 * chosen probability and one line per other, then the message's first page and where the rest is.
 */
export function renderRecall(outcome: RecallOutcome): string {
  if (outcome.kind === "none") {
    const best = outcome.best === undefined ? "none" : outcome.best.toFixed(2);
    return `[optchat recall] no view line reached recall-min ${outcome.min} (best p=${best}); try chat_search or zoom`;
  }
  if (outcome.kind === "failed") {
    return `[optchat recall] recall failed (${outcome.reason}); no answer was found. Use zoom or chat_search.`;
  }
  const { message } = outcome;
  const lines = [`[optchat recall] ${outcome.question}`];
  for (const step of outcome.path) {
    lines.push(`${step.id}+${step.n}|${step.text}${step.p === undefined ? "" : ` (p=${step.p.toFixed(2)})`}`);
  }
  if (outcome.others.length > 0) {
    lines.push(`chosen message ${message.id} (path p=${chainProbability(outcome.path).toFixed(3)})`);
    for (const other of outcome.others) {
      lines.push(
        other.kind === "answer"
          ? `other message ${other.id} (path p=${other.p.toFixed(3)})`
          : `other ${other.id}+${other.n} failed: ${other.reason}`,
      );
    }
  }
  if (outcome.raw) {
    lines.push(`raw-log match: message ${message.id} matched the question's words in the raw log, not a view line's summary`);
  }
  lines.push(`message ${message.id}:`, message.text);
  lines.push(
    message.shownBytes < message.totalBytes
      ? `[bytes 0-${message.shownBytes} of ${message.totalBytes}; zoom(${message.id}, 1, ${message.shownBytes}) for the rest]`
      : `[end of ${message.totalBytes} bytes]`,
  );
  return lines.join("\n");
}

/**
 * Registers the `chat_recall` tool (`recall` is an OMP builtin name). `run` produces the result text and is the only
 * place a failure surfaces; `recall` itself never throws.
 */
export function registerRecallTool(
  pi: ExtensionAPI,
  run: (question: string, current: ExtensionContext | undefined, signal: AbortSignal | undefined) => Promise<string>,
): void {
  const z = pi.zod;
  const params = z.object({
    question: z.string().min(1).max(RECALL_QUESTION_CHARS).describe("What the stored chat should answer, as one question"),
  });
  pi.registerTool<typeof params>({
    name: "chat_recall",
    label: "OptChat recall",
    description:
      "Find the stored message that best answers a question: a relevance gate picks a view line, then opens one half per level down to a message. Returns the path and that message's first page. Use chat_search for exact words.",
    parameters: params,
    approval: "read",
    loadMode: "essential",
    execute: async (_id, input, signal, _update, current) => ({
      content: [{ type: "text", text: await run(input.question, current, signal) }],
    }),
  });
}
