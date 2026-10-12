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

/** The memory as recall sees it. Memory satisfies this structurally through an adapter over its zoom. */
export interface RecallMemory {
  viewLines(): ReadonlyArray<{ id: number; n: number; text: string }>;
  lineAt(id: number, n: number): { id: number; n: number; text: string } | undefined;
  page(id: number): { text: string; next: number | null; totalBytes: number };
}

export interface RecallOptions {
  readonly judge: Judge;
  /** Trimmed, whitespace runs collapsed, and 1 to RECALL_QUESTION_CHARS characters. */
  readonly question: string;
  /** Minimum P(answer) for the first line, in (0, 1]. */
  readonly min: number;
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

export type RecallOutcome =
  | {
      readonly kind: "found";
      readonly question: string;
      readonly path: readonly RecallStep[];
      readonly message: { readonly id: number; readonly text: string; readonly shownBytes: number; readonly totalBytes: number };
    }
  | { readonly kind: "none"; readonly min: number; readonly best?: number }
  | { readonly kind: "failed"; readonly reason: string };

/**
 * The message most likely to answer `question`: a relevance gate scores the merged view lines, then one choice per level
 * descends into the likelier half until a single message remains. Never throws: any failure, timeout or cancellation
 * is a `failed` outcome, and no answer is ever guessed.
 */
export async function recall(memory: RecallMemory, options: RecallOptions): Promise<RecallOutcome> {
  const question = options.question.trim().replace(/\s+/g, " ");
  if (question.length === 0 || [...question].length > RECALL_QUESTION_CHARS) {
    return { kind: "failed", reason: `the question must be 1 to ${RECALL_QUESTION_CHARS} characters` };
  }
  const bound = new AbortController();
  const onParent = () => bound.abort(options.signal?.reason);
  if (options.signal?.aborted) onParent();
  options.signal?.addEventListener("abort", onParent, { once: true });
  const timer = setTimeout(() => bound.abort(new Error("recall exceeded its bound")), options.timeoutMs ?? RECALL_MS);
  try {
    const outcome = await search(memory, options.judge, question, options.min, bound.signal);
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

async function search(memory: RecallMemory, judge: Judge, question: string, min: number, signal: AbortSignal): Promise<RecallOutcome> {
  const lines: ViewLine[] = memory.viewLines().map((line) => ({ id: line.id, n: line.n, text: utf8Prefix(line.text, RECALL_TEXT_BYTES) }));
  if (lines.length === 0) return { kind: "none", min };
  const scores = await scoreLines(judge, question, lines, signal);
  if (scores.scored.length === 0 && scores.failures.length > 0) return { kind: "failed", reason: scores.failures[0]! };
  let best: { line: ViewLine; p: number } | undefined;
  for (const entry of scores.scored) {
    if (!best || entry.p > best.p || (entry.p === best.p && entry.line.id > best.line.id)) best = entry;
  }
  if (!best || best.p < min) return { kind: "none", min, best: best?.p };

  const path: RecallStep[] = [{ id: best.line.id, n: best.line.n, text: best.line.text, p: best.p }];
  let current = path[0]!;
  while (current.n > 1) {
    const half = current.n / 2;
    const first = memory.lineAt(current.id, half);
    const second = memory.lineAt(current.id + half, half);
    if (!first && !second) return { kind: "failed", reason: `no built children under line ${current.id}+${current.n}` };
    let step: RecallStep;
    if (first && second) {
      const pick = await descend(judge, question, first.text, second.text, signal);
      const side = pick.picked === "first" ? first : second;
      step = { id: side.id, n: side.n, text: utf8Prefix(side.text, RECALL_TEXT_BYTES), p: pick.p };
    } else {
      const only = (first ?? second)!;
      step = { id: only.id, n: only.n, text: utf8Prefix(only.text, RECALL_TEXT_BYTES) };
    }
    path.push(step);
    current = step;
  }

  const page = memory.page(current.id);
  const text = utf8Prefix(page.text, RECALL_PAGE_BYTES);
  return {
    kind: "found",
    question,
    path,
    message: { id: current.id, text, shownBytes: utf8Length(text), totalBytes: page.totalBytes },
  };
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
  lines: readonly ViewLine[],
  signal: AbortSignal,
): Promise<{ scored: Array<{ line: ViewLine; p: number }>; failures: string[] }> {
  const keyed = lines.map((line) => ({ line, key: `${line.id}+${line.n}` }));
  const chunks = packByBytes(
    keyed,
    utf8Length(JSON.stringify({ question, lines: {} })),
    (entry) => utf8Length(JSON.stringify(entry.key)) + utf8Length(JSON.stringify(entry.line.text)) + 2,
    PREFETCH_STATE_BYTES,
    PREFETCH_QUESTIONS,
  );
  const scored: Array<{ line: ViewLine; p: number }>[] = [];
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

/** The outcome as the tool shows it. `found` lists the descent path, then the message's first page and where the rest is. */
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
