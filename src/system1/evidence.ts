import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { MessageMetadata } from "../archive.js";
import {
  EvidenceIndex, EVIDENCE_CHUNK_BYTES, EVIDENCE_INDEX_BYTES, EVIDENCE_INDEX_CHUNKS,
  EVIDENCE_INDEX_MESSAGES, EVIDENCE_READ_BYTES, type EvidenceExplanation, type EvidenceIndexCapacity,
} from "../evidence-index.js";
import { RANK_TERM_CHARS } from "../memory.js";
import type { Kind } from "../store.js";

/** The question as the tool accepts it: 1 to this many characters. */
export const EVIDENCE_QUESTION_CHARS = 1_000;
/** The hard passage ceiling; callers may request fewer with `maxPassages`. */
export const EVIDENCE_PASSAGES = 8;
/** A passage is one window of a stored message: at most this many UTF-8 bytes, cut on code-point boundaries. */
export const EVIDENCE_PASSAGE_BYTES = EVIDENCE_CHUNK_BYTES;
/** The hard passage-text byte ceiling; callers may request fewer with `maxBytes`. */
export const EVIDENCE_BYTES = 16_384;
/** Wall bound for one call, unless the caller passes `timeoutMs`. */
export const EVIDENCE_MS = 10_000;
/** Each result's text begins with this mark; search and ranking skip such results (`MEMORY_RESULT_MARKS`). */
export const EVIDENCE_MARK = "[optchat evidence]";
// A live Memory object is the identity, never a filesystem path. Replacing/resetting Memory naturally
// drops its derived index. Older child snapshots filter the same index strictly below their bound.
const indexes = new WeakMap<object, EvidenceIndex>();

/** One bounded page of a stored message's exact source text. */
export interface EvidencePage {
  readonly text: string;
  readonly offset?: number;
  /** Actual source bytes traversed by bounded paging, including seeking. Absent means text bytes only. */
  readonly traversedBytes?: number;
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
  /** Stable live Memory identity. Must change if originals change, ids are reused, or a store is reset. */
  readonly sourceIdentity?: object;
  /** Recheck revocation on cache hits as well as source reads; main/child adapters call their existing live() guard. */
  assertLive?(): void;
  /** Exact original-source page. Adapters use readSourcePage and pass the traversal allowance through;
   * unlike Store.readMessagePage, its first page never indexes the whole original synchronously. */
  page(id: number, offset: number, maxBytes: number, maxTraversalBytes?: number): EvidencePage;
}

export interface EvidenceLimits {
  /** Only messages with id below this are read: the snapshot's message count. */
  readonly upperBound: number;
  /** The most passages returned, at least 1, clamped to EVIDENCE_PASSAGES. */
  readonly maxPassages?: number;
  /** The most passage-text bytes returned, at least 1, clamped to EVIDENCE_BYTES. */
  readonly maxBytes?: number;
  /** Milliseconds before retrieval stops, clamped to EVIDENCE_MS. */
  readonly timeoutMs?: number;
  /** Source bytes traversed per call, including seeks and overlapping reads. Clamped to EVIDENCE_READ_BYTES. */
  readonly maxReadBytes?: number;
  /** Deterministic retained text/entry accounting; clamped to EVIDENCE_INDEX_BYTES. */
  readonly maxIndexBytes?: number;
  readonly maxChunks?: number;
  readonly maxMessages?: number;
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
  /** Matching messages indexed and searched to their end, ascending. Snapshot-wide counts are in explanation. */
  readonly searched: readonly number[];
  /** Question words that no read window contains. */
  readonly missing: readonly string[];
  /** Read messages that are partial captured reports, ascending: "[incomplete: ...]" text or pointer-only work metadata. */
  readonly incomplete: readonly number[];
  /** True only when the entire eligible snapshot was indexed and queried, not a claim of answer correctness. */
  readonly complete: boolean;
  /** Known matching unfinished messages and the first uncovered id. explanation.coverage bounds the full omitted range. */
  readonly unsearched: readonly number[];
  readonly explanation: EvidenceExplanation;
}

/**
 * Query a bounded, rebuildable chunk index over the originals, never the top 50 whole-message hits.
 * The index is in-memory only and increments across calls using the live source identity. Limits apply
 * to source I/O, retained text/entries, query scratch, time and output. Coverage is explicit when any
 * limit prevents reaching the snapshot end. Lexical relevance is not semantic answer verification.
 */
export async function gatherEvidence(memory: EvidenceMemory, question: string, limits: EvidenceLimits): Promise<EvidenceResult> {
  const upperBound = count(limits.upperBound, "upperBound", 0);
  const maxPassages = capped(limits.maxPassages, EVIDENCE_PASSAGES, "maxPassages", 1);
  const maxBytes = capped(limits.maxBytes, EVIDENCE_BYTES, "maxBytes", 1);
  const timeoutMs = capped(limits.timeoutMs, EVIDENCE_MS, "timeoutMs", 0);
  const maxReadBytes = capped(limits.maxReadBytes, EVIDENCE_READ_BYTES, "maxReadBytes", 0);
  const capacity: EvidenceIndexCapacity = {
    maxIndexBytes: capped(limits.maxIndexBytes, EVIDENCE_INDEX_BYTES, "maxIndexBytes", 0),
    maxChunks: capped(limits.maxChunks, EVIDENCE_INDEX_CHUNKS, "maxChunks", 0),
    maxMessages: capped(limits.maxMessages, EVIDENCE_INDEX_MESSAGES, "maxMessages", 0),
  };
  if (question.length > EVIDENCE_QUESTION_CHARS) throw new RangeError(`question must be at most ${EVIDENCE_QUESTION_CHARS} characters`);
  const clock = limits.clock ?? (() => performance.now());
  limits.signal?.throwIfAborted();
  memory.assertLive?.();
  const started = clock();
  const deadline = started + timeoutMs;
  const buildDeadline = started + timeoutMs * 0.75;
  const terms = [...new Set(question.toLowerCase().split(/[^\p{L}\p{N}]+/u))].filter((term) => [...term].length >= RANK_TERM_CHARS);
  const identity = memory.sourceIdentity ?? memory;
  let index = indexes.get(identity);
  if (!index || index.capacity.maxIndexBytes !== capacity.maxIndexBytes || index.capacity.maxChunks !== capacity.maxChunks || index.capacity.maxMessages !== capacity.maxMessages) {
    index = new EvidenceIndex(capacity);
    indexes.set(identity, index);
  }
  const result = await index.query(memory, { upperBound, terms, maxReadBytes, maxPassages, maxBytes, deadline, buildDeadline, clock, signal: limits.signal });
  return { ...result, terms };
}

function capped(value: number | undefined, maximum: number, name: string, minimum: number): number {
  return Math.min(count(value ?? maximum, name, minimum), maximum);
}

function count(value: number, name: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum) throw new RangeError(`${name} must be a safe integer of at least ${minimum}`);
  return value;
}

const list = (ids: readonly number[]): string => ids.length === 0 ? "none" : `${ids.slice(0, 64).join(", ")}${ids.length > 64 ? `, … (${ids.length - 64} further ids omitted from this trailer)` : ""}`;

/**
 * The result as the tool shows it: each passage's message, kind, byte range and text, then the trailer every result
 * carries, found passages or not: the messages searched, the question words none of them contains, the partial reports
 * among them, and explicit index/query/output coverage and omissions. Large id lists are visibly abbreviated.
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
    lines.push(result.terms.length === 0
      ? "no passage: the question has no word of at least 3 letters or digits"
      : result.explanation.selection.matchedChunks > 0
        ? "no passage returned: matching chunks exist but selection or output limits omitted them; inspect the coverage and omissions below"
        : "no passage: no matching word was observed within the searched coverage; this does not establish absence outside that coverage");
  }
  lines.push(`[searched messages: ${list(result.searched)}]`);
  lines.push(`[question words in no searched message: ${result.missing.length === 0 ? "none" : result.missing.map((term) => `"${term}"`).join(", ")}]`);
  lines.push(`[incomplete or partial reports among them: ${list(result.incomplete)}]`);
  const { coverage, selection, omissions } = result.explanation;
  lines.push(
    `[snapshot: messages 0-${result.explanation.snapshot.upperBound} (exclusive); indexed ${coverage.fullyIndexedMessages}/${result.explanation.snapshot.upperBound}; excluded memory records: ${coverage.excludedMessages}; chunks searched: ${coverage.searchedChunks}/${coverage.indexedChunks}; source bytes covered: ${coverage.sourceBytes}]`,
    `[selection: ${selection.matchedChunks} matching chunks; ${selection.returnedPassages} returned; omissions: ${omissions.length === 0 ? "none" : omissions.join(", ")}]`,
    coverage.next === null
      ? "[index coverage reaches snapshot end]"
      : `[index incomplete: next window starts at message ${coverage.next.id}, byte ${coverage.next.offset} (may overlap the previous window); later messages below the snapshot bound are unindexed]`,
    result.complete
      ? "[search complete within this snapshot; lexical matches are not verified answers]"
      : `[search incomplete: ${coverage.unsearchedChunks} indexed chunks not searched; not fully searched: ${list(result.unsearched)}; missing words mean not observed within coverage, not absent from the chat]`,
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
      "Search a bounded local chunk index for exact original passages (at most 8 passages of 2,048 bytes, 16,384 bytes total). Each gives its message id and UTF-8 byte range; zoom(id, 1, start) reopens it. The trailer reports snapshot coverage, omissions and partial reports. When extraction is enabled and a key resolves, selected passages are also sent to OpenRouter/Clairic for unverified candidate occurrences. Neither lexical matches nor extracted spans verify an answer; incomplete coverage cannot establish absence.",
    parameters: params,
    approval: "read",
    loadMode: "essential",
    execute: async (_id, input, signal, _update, current) => ({
      content: [{ type: "text", text: await run(input.question, current, signal) }],
    }),
  });
}
