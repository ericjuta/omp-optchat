import type { ChoiceAnswer, Judge, NoulAnswer, Questions } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { RANK_TERM_CHARS, SEARCH_MAX_LIMIT, utf8Prefix } from "../memory.js";
import { boundedGateError, judgeWithin, packByBytes, utf8Length } from "./judge.js";
import { PREFETCH_IN_FLIGHT, PREFETCH_QUESTIONS, PREFETCH_STATE_BYTES, type ViewLine } from "./prefetch.js";
import { RECALL_PICK, RECALL_SCORE_INSTRUCTION } from "./recall-prompt.js";

/** The question as judged and shown: 1 to this many characters. */
export const RECALL_QUESTION_CHARS = 1_000;
/** A line's text, as judged and as shown on the path, stays within this many UTF-8 bytes. */
export const RECALL_TEXT_BYTES = 4_000;
/** The answering message's first page, as returned: the rest is reached by `zoom(id, 1, offset)`. */
export const RECALL_PAGE_BYTES = 8_000;
/** Wall bound for the whole recall, unless the caller passes `timeoutMs`. */
export const RECALL_MS = 20_000;
/** Wall bound for one judge call: a scoring request or the pick among the top messages. */
export const RECALL_STEP_MS = 5_000;
/** The most multi-message view lines one recall scans. */
export const RECALL_K_MAX = 8;
/** The most raw-log matches one recall adds as candidate lines. */
export const RECALL_SEEDS_MAX = 32;
/** Multi-message lines at or above `min` that every recall scans, even for k = 1. */
const RECALL_SCAN_LINES = 4;
/**
 * The most messages scored under the scanned lines in one recall: four full lines (a built line holds at most 64
 * messages). A line whose not-yet-scored messages would pass this is skipped, not cut, so a scanned line is scored whole.
 */
const RECALL_SCAN_LEAVES_MAX = 256;
/** The most near-tied top messages shown side by side in the pick. */
const RECALL_PICK_MAX = 8;
/** A message joins the pick when its score is within this of the best message's score. */
const RECALL_PICK_MARGIN = 0.1;
/** The pick's texts share this many UTF-8 bytes, so the request stays within the prefetch gate's state limit. */
const RECALL_PICK_TEXT_BYTES = 20_000;
/** BM25's length weight `b` in the seed re-rank: 0 ignores a message's length, 1 divides by its full relative length. */
const SEED_LENGTH_B = 0.75;

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
  /** Minimum P(answer) for a line to be scanned or answered directly, in (0, 1]. */
  readonly min: number;
  /**
   * How many of the top multi-message lines at or above `min` to scan, 1 to RECALL_K_MAX. Every recall scans at least
   * RECALL_SCAN_LINES of them, so `k` only widens the scan; with k > 1 the messages that lost are listed as `others`.
   * Absent means 1.
   */
  readonly k?: number;
  /** Raw-log matches added as single-message candidates, 0 to RECALL_SEEDS_MAX. Absent means 0. */
  readonly seeds?: number;
  /** Overall bound; overrides RECALL_MS. */
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

/** One line on the answer's path: the scanned view line that covers the message, then the message. `p` is the line's relevance score. */
export interface RecallStep {
  readonly id: number;
  readonly n: number;
  readonly text: string;
  readonly p?: number;
}

/** A candidate the answer beat: a message with its relevance score, or a scanned line that held no built message. */
export type RecallOther =
  | { readonly kind: "answer"; readonly id: number; readonly p: number }
  | { readonly kind: "failed"; readonly id: number; readonly n: number; readonly reason: string };

export type RecallOutcome =
  | {
      readonly kind: "found";
      readonly question: string;
      /** The scanned view line that covers the message, if any, then the message. */
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
 * The message most likely to answer `question`. A relevance gate scores the merged view lines and the raw-log matches
 * (seeds). The top multi-message lines at or above `min` are then scanned flat: every built message under them is scored
 * by the same gate, so the answer is a candidate whichever of those lines covers it, with no choice between halves of a
 * line. The messages that reached `min` (or sit under a scanned line) compete on their own score; the ones within
 * RECALL_PICK_MARGIN of the best are shown side by side in one choice, and the likeliest answers.
 * Never throws: any failure, timeout or cancellation is a `failed` outcome, and no answer is ever guessed.
 * The seeds are the word search's widest pool re-ranked with length normalization (`rankSeeds`), so short messages that
 * state an answer are not crowded out by long ones that merely touch many of the question's words.
 *
 * Cost, on a 2,000-message store (view lines of up to 64 messages): the first round scores the view lines and seeds in
 * about 2 to 5 requests, sent 4 at a time. The scan adds the requests that hold the messages under the scanned lines: built
 * messages are about 300 bytes, so 64 questions fill a request (PREFETCH_QUESTIONS), and the scan holds at most
 * RECALL_SCAN_LEAVES_MAX messages, 1 to 4 requests (about 1 on average) sent in parallel, one more round of latency. The
 * pick adds 1 request. That is about 4 to 9 requests in three dependent judge rounds (about 3 s here), each cut at
 * RECALL_STEP_MS, the whole recall at RECALL_MS.
 * A store whose best line is a single message scans nothing and costs the first round plus the pick.
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

/** A candidate line: a view line, a message under a scanned line, or a raw-log match (`raw`), one message whose words matched the question. */
interface Candidate extends ViewLine {
  readonly raw: boolean;
}

/** A line with its probability that it holds the answer. */
interface Scored {
  readonly line: Candidate;
  readonly p: number;
}

/** What the relevance gate returned for a batch of lines, and one bounded error per request that failed or was never sent. */
interface GateScores {
  readonly scored: Scored[];
  readonly failures: string[];
}

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
    for (const { id, text } of rankSeeds(memory, question, seeds)) {
      if (covered.has(id)) continue;
      covered.add(id);
      lines.push({ id, n: 1, text: utf8Prefix(text, RECALL_TEXT_BYTES), raw: true });
    }
  }
  if (lines.length === 0) return { kind: "none", min };
  const scores = await scoreLines(judge, question, lines, signal);
  if (scores.scored.length === 0 && scores.failures.length > 0) return { kind: "failed", reason: scores.failures[0]! };
  const ranked = [...scores.scored].sort(byScore);
  const best = ranked[0];
  if (!best || best.p < min) return { kind: "none", min, best: best?.p };

  // Flat scan: the messages under the top multi-message lines at `min`, scored in one more round of the same requests.
  const scanned = ranked.filter((entry) => entry.p >= min && entry.line.n > 1).slice(0, Math.max(k, RECALL_SCAN_LINES));
  const known = new Set(ranked.filter((entry) => entry.line.n === 1).map((entry) => entry.line.id));
  const cover = new Map<number, Scored>();
  const fresh: Candidate[] = [];
  const unscanned: Scored[] = [];
  for (const start of scanned) {
    const leaves = leavesUnder(memory, start.line);
    const unseen = leaves.filter((leaf) => !known.has(leaf.id));
    if (leaves.length === 0 || fresh.length + unseen.length > RECALL_SCAN_LEAVES_MAX) {
      unscanned.push(start);
      continue;
    }
    for (const leaf of leaves) {
      if (!cover.has(leaf.id)) cover.set(leaf.id, start);
    }
    for (const leaf of unseen) {
      known.add(leaf.id);
      fresh.push(leaf);
    }
  }
  const more: GateScores =
    fresh.length > 0 ? await scoreLines(judge, question, fresh, signal) : { scored: [], failures: [] };
  // A message competes when it reached `min` itself, or lies under a scanned line, which reached it.
  const pool = [
    ...ranked.filter((entry) => entry.line.n === 1 && (entry.p >= min || cover.has(entry.line.id))),
    ...more.scored,
  ].sort(byScore);
  if (pool.length === 0) return { kind: "failed", reason: more.failures[0] ?? "no built message under the top lines" };

  const ordered = await pick(judge, question, pool, signal);
  const winner = ordered[0]!;
  const step = (entry: Scored): RecallStep => ({ id: entry.line.id, n: entry.line.n, text: entry.line.text, p: entry.p });
  const over = cover.get(winner.line.id);
  const page = memory.page(winner.line.id);
  const text = utf8Prefix(page.text, RECALL_PAGE_BYTES);
  const others: RecallOther[] =
    k === 1
      ? []
      : [
          ...ordered.slice(1, k).map((entry): RecallOther => ({ kind: "answer", id: entry.line.id, p: entry.p })),
          ...unscanned.map(
            (entry): RecallOther => ({ kind: "failed", id: entry.line.id, n: entry.line.n, reason: "no built messages to score under the line" }),
          ),
        ];
  return {
    kind: "found",
    question,
    path: over ? [step(over), step(winner)] : [step(winner)],
    others,
    message: { id: winner.line.id, text, shownBytes: utf8Length(text), totalBytes: page.totalBytes },
    ...(winner.line.raw ? { raw: true as const } : {}),
  };
}

/** Higher probability first; a tie goes to the newer line. */
function byScore(a: Scored, b: Scored): number {
  return b.p - a.p || b.line.id - a.line.id;
}

/**
 * The built messages (n = 1 lines) inside a line, oldest first, each with its built text: a summary, or the message
 * itself when it fits a node. A message whose line is not built is left out. No model call.
 */
function leavesUnder(memory: RecallMemory, line: Candidate): Candidate[] {
  const leaves: Candidate[] = [];
  for (let id = line.id; id < line.id + line.n; id++) {
    const leaf = memory.lineAt(id, 1);
    if (leaf) leaves.push({ id, n: 1, text: utf8Prefix(leaf.text, RECALL_TEXT_BYTES), raw: false });
  }
  return leaves;
}

/**
 * The top `seeds` raw-log matches, best first, without a model call. The word search weighs each matched question word
 * once whatever a message's length, so long messages (file dumps, logs, notices) that touch many of the question's words
 * outrank a short message that states the answer. This re-ranks the search's widest pool (SEARCH_MAX_LIMIT ids): each
 * question word of at least RANK_TERM_CHARS characters, split as the search splits them, weighs its inverse document
 * frequency within the pool, ln(1 + (P - df + 0.5) / (df + 0.5)); a message scores the weights of the words its first
 * page contains, divided by BM25's length norm 1 - b + b * totalBytes / (the pool's mean totalBytes), b = SEED_LENGTH_B.
 * A tie keeps the search's order.
 */
function rankSeeds(
  memory: RecallMemory,
  question: string,
  seeds: number,
): Array<{ readonly id: number; readonly text: string }> {
  const pool = memory.rank(question, SEARCH_MAX_LIMIT).map((id, order) => {
    const page = memory.page(id);
    return { id, order, text: page.text, lower: page.text.toLowerCase(), bytes: page.totalBytes };
  });
  if (pool.length === 0) return [];
  const terms = [...new Set(question.toLowerCase().split(/[^\p{L}\p{N}]+/u))].filter(
    (term) => [...term].length >= RANK_TERM_CHARS,
  );
  const weights = terms.map((term) => {
    const df = pool.reduce((count, entry) => (entry.lower.includes(term) ? count + 1 : count), 0);
    return Math.log(1 + (pool.length - df + 0.5) / (df + 0.5));
  });
  const mean = pool.reduce((sum, entry) => sum + entry.bytes, 0) / pool.length;
  return pool
    .map((entry) => {
      const matched = terms.reduce((sum, term, index) => (entry.lower.includes(term) ? sum + weights[index]! : sum), 0);
      const norm = mean > 0 ? 1 - SEED_LENGTH_B + SEED_LENGTH_B * (entry.bytes / mean) : 1;
      return { id: entry.id, order: entry.order, text: entry.text, score: matched / norm };
    })
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, seeds);
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
): Promise<GateScores> {
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

/**
 * Separately scored messages of one topic land within a few hundredths of each other, so the argmax is nearly arbitrary.
 * The messages scoring within RECALL_PICK_MARGIN of the best (at most RECALL_PICK_MAX) are shown together in one choice
 * question, in message order so the ranking gives no position cue, each text cut to its share of RECALL_PICK_TEXT_BYTES;
 * the likeliest of them moves to the front. A tie keeps the higher-ranked message. One extra judge call, only when two or
 * more messages contend; if it fails or answers nothing usable, the ranking is kept as scored. Returns `pool` reordered,
 * never fewer entries.
 */
async function pick(judge: Judge, question: string, pool: readonly Scored[], signal: AbortSignal): Promise<Scored[]> {
  const top = pool[0];
  if (!top) return [];
  const field = pool.filter((entry) => entry.p >= top.p - RECALL_PICK_MARGIN).slice(0, RECALL_PICK_MAX);
  if (field.length < 2) return [...pool];
  const share = Math.floor(RECALL_PICK_TEXT_BYTES / field.length);
  const keyOf = (entry: Scored): string => `${entry.line.id}+${entry.line.n}`;
  const lines: Record<string, string> = {};
  const criteria: Record<string, string> = {};
  for (const entry of [...field].sort((a, b) => a.line.id - b.line.id)) {
    lines[keyOf(entry)] = utf8Prefix(entry.line.text, share);
    criteria[keyOf(entry)] = RECALL_PICK.criterion.replaceAll("{line}", keyOf(entry));
  }
  const questions: Questions = { pick: { type: "choice", instructions: RECALL_PICK.instructions, criteria } };
  try {
    const result = await judgeWithin(judge, { state: { question, lines }, questions }, RECALL_STEP_MS, signal);
    const answer = result.answers.pick as ChoiceAnswer<string>;
    let winner: Scored | undefined;
    let best = 0;
    for (const entry of field) {
      const p = answer.probabilities[keyOf(entry)];
      if (typeof p === "number" && p > best) {
        winner = entry;
        best = p;
      }
    }
    return winner === undefined ? [...pool] : [winner, ...pool.filter((entry) => entry !== winner)];
  } catch {
    return [...pool];
  }
}

/**
 * The outcome as the tool shows it. `found` lists the path (the scanned line covering the message, then the message), then,
 * when there are other candidates, the chosen message's score and one line per other, then the message's first page and where the rest is.
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
    lines.push(`chosen message ${message.id} (p=${(outcome.path.at(-1)?.p ?? 1).toFixed(3)})`);
    for (const other of outcome.others) {
      lines.push(
        other.kind === "answer"
          ? `other message ${other.id} (p=${other.p.toFixed(3)})`
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
      "Find the stored message that best answers a question: a relevance gate scores the view lines and raw-log matches, every message under the top lines is scored, and the likeliest wins. Returns the path and that message's first page. Use chat_search for exact words.",
    parameters: params,
    approval: "read",
    loadMode: "essential",
    execute: async (_id, input, signal, _update, current) => ({
      content: [{ type: "text", text: await run(input.question, current, signal) }],
    }),
  });
}
