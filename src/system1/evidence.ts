import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { MessageMetadata } from "../archive.js";
import { RANK_TERM_CHARS, SEARCH_MAX_LIMIT } from "../memory.js";
import type { Kind } from "../store.js";

/** The question as the tool accepts it: 1 to this many characters. */
export const EVIDENCE_QUESTION_CHARS = 1_000;
/** The most passages one call returns, unless the caller passes `maxPassages`. */
export const EVIDENCE_PASSAGES = 8;
/** A passage is one window of a stored message: at most this many UTF-8 bytes, cut on code-point boundaries. */
export const EVIDENCE_PASSAGE_BYTES = 2_048;
/** The most passage-text bytes one call returns, unless the caller passes `maxBytes`. */
export const EVIDENCE_BYTES = 16_384;
/** Wall bound for one call, unless the caller passes `timeoutMs`. */
export const EVIDENCE_MS = 10_000;
/** Each result's text begins with this mark; search and ranking skip such results (`MEMORY_RESULT_MARKS`). */
export const EVIDENCE_MARK = "[optchat evidence]";
/** Windows start every this many bytes, so a phrase cut by one window's edge lies whole inside the next window. */
const WINDOW_STRIDE_BYTES = 1_024;
/** Real time a scan runs before it yields to the event loop, so it never holds the host's loop longer than this. */
const SLICE_MS = 8;
/** A captured report whose capture was cut short starts with this (src/index.ts `reportEntries`). */
const PARTIAL_REPORT_PREFIX = "[incomplete:";

/** One page of a stored message's exact source text, as `Store.readMessagePage` returns it. */
export interface EvidencePage {
  readonly text: string;
  readonly next: number | null;
  readonly totalBytes: number;
  readonly kind: Kind;
  readonly metadata?: MessageMetadata;
}

/**
 * The memory as evidence reads it. A chat adapts its Memory and Store to this (src/index.ts), as recall adapts
 * `RecallMemory`: neither call reaches a model.
 */
export interface EvidenceMemory {
  /** `Memory.rankMessages` with `idf: "smoothed"`: stored message ids below `before` whose words best match `question`, best first, at most `limit`. */
  rank(question: string, limit: number, before: number): number[];
  /** `Store.readMessagePage`: at most `maxBytes` of message `id`'s text from the UTF-8 byte `offset`, as `zoom(id, 1, offset)` pages it. */
  page(id: number, offset: number, maxBytes: number): EvidencePage;
}

export interface EvidenceLimits {
  /** Only messages with id below this are read: the snapshot's message count. */
  readonly upperBound: number;
  /** The most passages returned, at least 1. Absent means EVIDENCE_PASSAGES. */
  readonly maxPassages?: number;
  /** The most passage-text bytes returned, at least 1. Absent means EVIDENCE_BYTES. */
  readonly maxBytes?: number;
  /** Milliseconds before the scan stops with what it has. Absent means EVIDENCE_MS. */
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /** The milliseconds clock the time bound reads. Absent means `performance.now`. */
  readonly clock?: () => number;
}

/**
 * A byte range `[start, end)` of message `id`: `text` is exactly the bytes `zoom(id, 1, start)` begins with. `complete`
 * is true when the passage is the whole message.
 */
export interface EvidencePassage {
  readonly id: number;
  readonly kind: Kind;
  readonly start: number;
  readonly end: number;
  readonly totalBytes: number;
  readonly text: string;
  readonly complete: boolean;
}

export interface EvidenceResult {
  /** Best first. */
  readonly passages: readonly EvidencePassage[];
  /** The question's words as matched: lowercased, deduplicated, at least RANK_TERM_CHARS characters. */
  readonly terms: readonly string[];
  /** Messages read to their end, ascending. */
  readonly searched: readonly number[];
  /** Question words that no read window contains. */
  readonly missing: readonly string[];
  /** Read messages that are partial captured reports, ascending: "[incomplete: ...]" text or pointer-only work metadata. */
  readonly incomplete: readonly number[];
  /** False when the time bound stopped the scan before every candidate message was read to its end. */
  readonly complete: boolean;
  /** Candidate messages not read to their end, in candidate order. */
  readonly unsearched: readonly number[];
}

interface Window {
  readonly id: number;
  /** The message's position among the candidates: 0 is the best word match. */
  readonly rank: number;
  readonly kind: Kind;
  readonly start: number;
  readonly end: number;
  readonly totalBytes: number;
  /** Indexes into `terms` of the question words the window contains. */
  readonly matched: readonly number[];
}

/**
 * Passages from the stored chat that bear on `question`, without a model call. Candidates are `Memory.rankMessages`'
 * widest pool (SEARCH_MAX_LIMIT messages below `upperBound`). Each candidate is read whole, in windows of at most
 * EVIDENCE_PASSAGE_BYTES that start every WINDOW_STRIDE_BYTES bytes, each cut where `zoom` paging would cut it, so no
 * UTF-8 sequence is split. A window scores the weights of the question words it contains, case-insensitively; a word
 * weighs ln(1 + (W - df + 0.5) / (df + 0.5)) over the W windows read, df of which contain it. Windows that contain a
 * word are taken best first (ties: the better-ranked message, then the earlier window), skipping one that overlaps a
 * window already taken from its message or that would pass `maxBytes`, until `maxPassages` are taken. When the time
 * bound passes, the scan stops and the windows read so far compete; the result says so. Invalid limits throw
 * RangeError; a cancel throws the signal's reason.
 */
export async function gatherEvidence(memory: EvidenceMemory, question: string, limits: EvidenceLimits): Promise<EvidenceResult> {
  const upperBound = count(limits.upperBound, "upperBound", 0);
  const maxPassages = count(limits.maxPassages ?? EVIDENCE_PASSAGES, "maxPassages", 1);
  const maxBytes = count(limits.maxBytes ?? EVIDENCE_BYTES, "maxBytes", 1);
  const timeoutMs = count(limits.timeoutMs ?? EVIDENCE_MS, "timeoutMs", 0);
  const clock = limits.clock ?? (() => performance.now());
  const signal = limits.signal;
  signal?.throwIfAborted();
  const deadline = clock() + timeoutMs;
  // Split as `Memory.rankMessages` splits a question.
  const terms = [...new Set(question.toLowerCase().split(/[^\p{L}\p{N}]+/u))].filter((term) => [...term].length >= RANK_TERM_CHARS);
  const candidates = terms.length === 0 ? [] : memory.rank(question, SEARCH_MAX_LIMIT, upperBound);

  const windows: Window[] = [];
  let read = 0;
  const found = new Array<boolean>(terms.length).fill(false);
  const searched: number[] = [];
  const partial: number[] = [];
  let stopped = candidates.length;
  let slice = performance.now();
  scan: for (let rank = 0; rank < candidates.length; rank++) {
    const id = candidates[rank]!;
    for (let start = 0; ;) {
      if (clock() >= deadline) {
        stopped = rank;
        break scan;
      }
      if (performance.now() - slice >= SLICE_MS) {
        const { promise, resolve } = Promise.withResolvers<void>();
        setImmediate(resolve);
        await promise;
        signal?.throwIfAborted();
        slice = performance.now();
      }
      const page = memory.page(id, start, EVIDENCE_PASSAGE_BYTES);
      const partialReport = page.kind === "work" && (page.text.startsWith(PARTIAL_REPORT_PREFIX) || page.metadata?.work?.completeness === "pointer-only");
      if (start === 0 && partialReport) partial.push(id);
      const lower = page.text.toLowerCase();
      const matched: number[] = [];
      terms.forEach((term, index) => {
        if (!lower.includes(term)) return;
        matched.push(index);
        found[index] = true;
      });
      read++;
      const end = page.next ?? page.totalBytes;
      if (matched.length > 0) windows.push({ id, rank, kind: page.kind, start, end, totalBytes: page.totalBytes, matched });
      if (page.next === null) break;
      // A window that did not reach the end leaves more than a stride after its start, so the stride page has a next.
      start = memory.page(id, start, WINDOW_STRIDE_BYTES).next!;
    }
    searched.push(id);
  }
  signal?.throwIfAborted();

  const df = new Array<number>(terms.length).fill(0);
  for (const window of windows) for (const index of window.matched) df[index]!++;
  const weights = df.map((n) => Math.log(1 + (read - n + 0.5) / (n + 0.5)));
  const ranked = windows
    .map((window) => ({ window, score: window.matched.reduce((sum, index) => sum + weights[index]!, 0) }))
    .sort((a, b) => b.score - a.score || a.window.rank - b.window.rank || a.window.start - b.window.start);
  const taken: Window[] = [];
  let bytes = 0;
  for (const { window } of ranked) {
    if (taken.length === maxPassages) break;
    const size = window.end - window.start;
    if (bytes + size > maxBytes) continue;
    if (taken.some((other) => other.id === window.id && other.start < window.end && window.start < other.end)) continue;
    taken.push(window);
    bytes += size;
  }
  const passages = taken.map((window): EvidencePassage => ({
    id: window.id,
    kind: window.kind,
    start: window.start,
    end: window.end,
    totalBytes: window.totalBytes,
    text: memory.page(window.id, window.start, EVIDENCE_PASSAGE_BYTES).text,
    complete: window.start === 0 && window.end === window.totalBytes,
  }));
  return {
    passages,
    terms,
    searched: searched.sort((a, b) => a - b),
    missing: terms.filter((_term, index) => !found[index]),
    incomplete: partial.sort((a, b) => a - b),
    complete: stopped === candidates.length,
    unsearched: candidates.slice(stopped),
  };
}

function count(value: number, name: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum) throw new RangeError(`${name} must be a safe integer of at least ${minimum}`);
  return value;
}

const list = (ids: readonly number[]): string => (ids.length === 0 ? "none" : ids.join(", "));

/**
 * The result as the tool shows it: each passage's message, kind, byte range and text, then the trailer every result
 * carries, found passages or not: the messages searched, the question words none of them contains, the partial reports
 * among them, and whether the time bound cut the search short.
 */
export function renderEvidence(question: string, result: EvidenceResult): string {
  const lines = [`${EVIDENCE_MARK} ${question.replace(/\s+/g, " ").trim()}`];
  const partial = new Set(result.incomplete);
  result.passages.forEach((passage, index) => {
    const report = partial.has(passage.id) ? ", partial report" : "";
    lines.push(
      `passage ${index + 1}: message ${passage.id} (${passage.kind}${report}), bytes ${passage.start}-${passage.end} of ${passage.totalBytes}; zoom(${passage.id}, 1, ${passage.start}) reopens it`,
      passage.text,
    );
  });
  if (result.passages.length === 0) {
    lines.push(result.terms.length === 0 ? "no passage: the question has no word of at least 3 letters or digits" : "no passage: no searched message contains a question word");
  }
  lines.push(`[searched messages: ${list(result.searched)}]`);
  lines.push(`[question words in no searched message: ${result.missing.length === 0 ? "none" : result.missing.map((term) => `"${term}"`).join(", ")}]`);
  lines.push(`[incomplete or partial reports among them: ${list(result.incomplete)}]`);
  lines.push(
    result.complete
      ? "[search complete]"
      : `[search incomplete: stopped at the time bound; not fully searched: ${list(result.unsearched)}]`,
  );
  return lines.join("\n");
}

/**
 * Registers the `chat_evidence` tool. `run` produces the result text; a main chat and a child's snapshot each supply
 * their own, bounded to the messages they may read.
 */
export function registerEvidenceTool(
  pi: ExtensionAPI,
  run: (question: string, current: ExtensionContext | undefined, signal: AbortSignal | undefined) => Promise<string>,
): void {
  const z = pi.zod;
  const params = z.object({
    question: z.string().min(1).max(EVIDENCE_QUESTION_CHARS).describe("What the stored chat should show evidence for, in plain words"),
  });
  pi.registerTool<typeof params>({
    name: "chat_evidence",
    label: "OptChat evidence",
    description:
      "Gather exact passages from the stored chat's original messages that bear on a question, without a model: the messages whose words best match it are read whole in windows of up to 2,048 bytes, and the windows holding the rarest question words win (at most 8 passages, 16,384 bytes in all). Each passage gives its message id and UTF-8 byte range; zoom(id, 1, start) reopens it. A trailer lists the messages searched, question words found in none of them, and partial reports.",
    parameters: params,
    approval: "read",
    loadMode: "essential",
    execute: async (_id, input, signal, _update, current) => ({
      content: [{ type: "text", text: await run(input.question, current, signal) }],
    }),
  });
}
