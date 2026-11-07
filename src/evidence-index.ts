import { MEMORY_RESULT_MARKS, MEMORY_TOOL_NAMES } from "./memory.js";
import type { Kind } from "./store.js";
import { SourcePageBudgetError } from "./source-page.js";
import type { EvidenceMemory, EvidencePage, EvidencePassage } from "./system1/evidence.js";

export const EVIDENCE_CHUNK_BYTES = 2_048;
const STRIDE_BYTES = 1_024;
const SLICE_MS = 8;
/** Hard ceilings, including when callers request larger limits. No index is persisted. */
export const EVIDENCE_INDEX_BYTES = 64 * 1024 * 1024;
export const EVIDENCE_INDEX_CHUNKS = 32_768;
export const EVIDENCE_INDEX_MESSAGES = 65_536;
export const EVIDENCE_READ_BYTES = 32 * 1024 * 1024;
// Account retained UTF-16 text plus fixed per-entry overhead. Entry counts also have hard ceilings;
// this is a deterministic storage budget, not a claim about engine-specific heap measurements.
const MESSAGE_BYTES = 128;
const CHUNK_BYTES = 128;

export interface EvidenceIndexCapacity {
  readonly maxIndexBytes: number;
  readonly maxChunks: number;
  readonly maxMessages: number;
}

export type EvidenceOmission =
  | "time-limit"
  | "index-time-limit"
  | "read-byte-limit"
  | "index-byte-limit"
  | "chunk-limit"
  | "message-limit"
  | "no-query-terms"
  | "recursive-memory"
  | "passage-limit"
  | "passage-byte-limit"
  | "overlapping-passages";

/** Counts/ranges cover the entire snapshot; individual hit lists are not a coverage claim. */
export interface EvidenceExplanation {
  readonly snapshot: { readonly upperBound: number };
  readonly index: {
    readonly reused: boolean;
    readonly retainedBytes: number;
    readonly capacityBytes: number;
    readonly chunks: number;
    readonly messages: number;
  };
  readonly coverage: {
    readonly inspectedMessages: number;
    readonly fullyIndexedMessages: number;
    readonly excludedMessages: number;
    readonly indexedChunks: number;
    readonly searchedChunks: number;
    readonly sourceBytes: number;
    readonly readBytes: number;
    readonly partialMessages: number;
    /** Next window to index; its offset can overlap the last window. All later ids below upperBound are unindexed. */
    readonly next: { readonly id: number; readonly offset: number } | null;
    /** Indexed chunks left unsearched when the query time bound expires. */
    readonly unsearchedChunks: number;
    readonly complete: boolean;
  };
  readonly omissions: readonly EvidenceOmission[];
  readonly selection: {
    readonly matchedChunks: number;
    readonly scoredChunks: number;
    readonly consideredChunks: number;
    readonly returnedPassages: number;
    readonly overlappingChunks: number;
    readonly passageLimitedChunks: number;
    readonly byteLimitedChunks: number;
  };
  /** Scores explain lexical selection, not answer confidence or truth. */
  readonly matches: readonly {
    readonly id: number;
    readonly start: number;
    readonly end: number;
    readonly score: number;
    readonly terms: readonly string[];
  }[];
}

interface IndexedMessage {
  readonly id: number;
  readonly kind: Kind;
  readonly totalBytes: number;
  readonly partial: boolean;
  readonly memoryCall: boolean;
  readonly excluded: boolean;
  readonly firstChunk: number;
  /** Prefix totals make snapshot diagnostics O(1), without a second walk over every record/chunk. */
  readonly bytesBefore: number;
  readonly sourceBytesBefore: number;
  readonly excludedBefore: number;
  readonly partialBefore: number;
  retainedBytes: number;
  chunks: number;
  /** End of the last indexed window (overlapping windows do not double-count coverage). */
  coveredBytes: number;
  next: number | null;
}

interface Chunk {
  readonly message: IndexedMessage;
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

export interface EvidenceIndexQuery {
  readonly upperBound: number;
  readonly terms: readonly string[];
  readonly maxReadBytes: number;
  readonly maxPassages: number;
  readonly maxBytes: number;
  readonly deadline: number;
  /** Leave time to query what was indexed instead of spending the entire call building it. */
  readonly buildDeadline: number;
  readonly clock: () => number;
  readonly signal?: AbortSignal;
}

export interface IndexedEvidence {
  readonly passages: readonly EvidencePassage[];
  readonly searched: readonly number[];
  readonly missing: readonly string[];
  readonly incomplete: readonly number[];
  readonly complete: boolean;
  readonly unsearched: readonly number[];
  readonly explanation: EvidenceExplanation;
}

/**
 * Disposable, incremental, query-independent chunk table for one immutable append-only source identity.
 * It walks ids in order, never rank()'s top-message shortlist. Discarding it and replaying the same source
 * rebuilds the same chunks. A query can only observe ids below its own upperBound, including in weights
 * and diagnostics. Source text is bounded by retainedBytes; query scratch is bounded by maxChunks and
 * the tool's 1,000-character question (one bit per chunk/term, plus scores and chunk indexes).
 */
export class EvidenceIndex {
  private readonly messages: IndexedMessage[] = [];
  private readonly chunks: Chunk[] = [];
  private retainedBytes = 0;

  readonly capacity: EvidenceIndexCapacity;

  constructor(capacity: EvidenceIndexCapacity) {
    for (const [value, maximum] of [
      [capacity.maxIndexBytes, EVIDENCE_INDEX_BYTES],
      [capacity.maxChunks, EVIDENCE_INDEX_CHUNKS],
      [capacity.maxMessages, EVIDENCE_INDEX_MESSAGES],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < 0 || value > maximum) throw new RangeError("Invalid evidence index capacity");
    }
    this.capacity = Object.freeze({ ...capacity });
  }

  async query(source: EvidenceMemory, options: EvidenceIndexQuery): Promise<IndexedEvidence> {
    const { upperBound, terms, signal, clock, deadline } = options;
    const reused = upperBound > 0 && this.messages.length > 0;
    let readBytes = 0;
    let slice = performance.now();
    const omissions = new Set<EvidenceOmission>();
    const check = (): boolean => {
      signal?.throwIfAborted();
      source.assertLive?.();
      if (clock() < deadline) return true;
      omissions.add("time-limit");
      return false;
    };
    const yieldSlice = async (): Promise<void> => {
      await new Promise<void>((resolve) => setImmediate(resolve));
      signal?.throwIfAborted();
      source.assertLive?.();
      slice = performance.now();
    };

    // Each page is admitted atomically before yielding. Concurrent queries may extend this same prefix,
    // but cannot duplicate a page or change previously admitted chunks.
    while (terms.length > 0 && check()) {
      if (performance.now() - slice >= SLICE_MS) {
        await yieldSlice();
        if (!check()) break;
      }
      const last = this.messages.at(-1);
      const current = last?.next !== null ? last : undefined;
      const id = current?.id ?? this.messages.length;
      if (id >= upperBound) break;
      if (clock() >= options.buildDeadline) {
        omissions.add("index-time-limit");
        break;
      }
      const start = current?.next ?? 0;
      if (!current && this.messages.length >= this.capacity.maxMessages) {
        omissions.add("message-limit");
        break;
      }
      if (this.chunks.length >= this.capacity.maxChunks) {
        omissions.add("chunk-limit");
        break;
      }
      const overhead = CHUNK_BYTES + (current ? 0 : MESSAGE_BYTES);
      // Reserve a worst-case full UTF-16 page before touching the source. The final short page may
      // need less, but stopping here keeps both transient and retained allocation within the budget.
      if (this.retainedBytes + overhead + EVIDENCE_CHUNK_BYTES * 2 > this.capacity.maxIndexBytes) {
        omissions.add("index-byte-limit");
        break;
      }
      if (readBytes + EVIDENCE_CHUNK_BYTES > options.maxReadBytes) {
        omissions.add("read-byte-limit");
        break;
      }
      let page: EvidencePage;
      try {
        page = source.page(id, start, EVIDENCE_CHUNK_BYTES, options.maxReadBytes - readBytes);
      } catch (error) {
        signal?.throwIfAborted();
        source.assertLive?.();
        if (!(error instanceof SourcePageBudgetError)) throw error;
        if (!Number.isSafeInteger(error.traversedBytes) || error.traversedBytes < 0 || error.traversedBytes > options.maxReadBytes - readBytes) {
          throw new Error("Evidence source exceeded its traversal byte budget");
        }
        readBytes += error.traversedBytes;
        omissions.add("read-byte-limit");
        break;
      }
      signal?.throwIfAborted();
      source.assertLive?.();
      const size = Buffer.byteLength(page.text, "utf8");
      const end = start + size;
      if (size > EVIDENCE_CHUNK_BYTES || !Number.isSafeInteger(page.totalBytes) || page.totalBytes < end ||
        (page.offset !== undefined && page.offset !== start) ||
        (page.next === null ? end !== page.totalBytes : page.next !== end || end >= page.totalBytes || size === 0) ||
        (current && (current.totalBytes !== page.totalBytes || current.kind !== page.kind))) {
        throw new Error("Evidence source returned an inconsistent UTF-8 page");
      }
      const traversedBytes = page.traversedBytes ?? size;
      if (!Number.isSafeInteger(traversedBytes) || traversedBytes < size || traversedBytes > options.maxReadBytes - readBytes) {
        throw new Error("Evidence source exceeded its traversal byte budget");
      }
      readBytes += traversedBytes;
      let message = current;
      if (!message) {
        const memoryCall = page.kind === "tool" && MEMORY_TOOL_NAMES.some((name) => page.text.startsWith(`${name} {`));
        const resultFor = page.metadata?.resultFor;
        const memoryResult = page.kind === "echo" && (
          MEMORY_RESULT_MARKS.some((mark) => page.text.startsWith(mark)) ||
          (resultFor !== undefined && Number.isSafeInteger(resultFor) && resultFor >= 0 && resultFor < id &&
            this.messages[resultFor]?.memoryCall === true)
        );
        message = {
          id, kind: page.kind, totalBytes: page.totalBytes,
          partial: page.kind === "work" && (page.text.startsWith("[incomplete:") || page.metadata?.work?.completeness === "pointer-only"),
          memoryCall, excluded: memoryCall || memoryResult,
          firstChunk: this.chunks.length,
          bytesBefore: this.retainedBytes,
          sourceBytesBefore: last ? last.sourceBytesBefore + last.coveredBytes : 0,
          excludedBefore: last ? last.excludedBefore + Number(last.excluded) : 0,
          partialBefore: last ? last.partialBefore + Number(last.partial) : 0,
          retainedBytes: MESSAGE_BYTES, chunks: 0, coveredBytes: 0, next: 0,
        };
        this.messages.push(message);
        this.retainedBytes += MESSAGE_BYTES;
      }
      if (message.excluded) {
        message.next = null;
      } else {
        this.chunks.push({ message, start, end, text: page.text });
        this.retainedBytes += CHUNK_BYTES + page.text.length * 2;
        message.retainedBytes += CHUNK_BYTES + page.text.length * 2;
        message.chunks++;
        message.coveredBytes = end;
        message.next = page.next === null ? null : start + stride(page.text);
      }
    }
    if (terms.length === 0) omissions.add("no-query-terms");
    signal?.throwIfAborted();
    source.assertLive?.();

    // Freeze this query's visible prefix before yielding again. Never use later snapshots in df,
    // coverage, partial-report lists or result selection, even when a shared index is already ahead.
    const messageCount = Math.min(upperBound, this.messages.length);
    const last = this.messages[messageCount - 1];
    const chunkCount = last ? last.firstChunk + last.chunks : 0;
    const next = last !== undefined && last.next !== null
      ? { id: last.id, offset: last.next }
      : messageCount < upperBound ? { id: messageCount, offset: 0 } : null;
    const excludedMessages = last ? last.excludedBefore + Number(last.excluded) : 0;
    const sourceBytes = last ? last.sourceBytesBefore + last.coveredBytes : 0;
    const visibleBytes = last ? last.bytesBefore + last.retainedBytes : 0;
    const finishedThrough = last?.next === null ? messageCount : Math.max(0, messageCount - 1);
    const fullyIndexedMessages = finishedThrough - excludedMessages;
    const partialMessages = last ? last.partialBefore + Number(last.partial) : 0;
    if (excludedMessages > 0) omissions.add("recursive-memory");

    const canSearch = terms.length > 0 && check();
    const words = Math.ceil(terms.length / 32);
    const matches = new Uint32Array(canSearch ? chunkCount * words : 0);
    const df = new Uint32Array(terms.length);
    const scores = new Float64Array(canSearch ? chunkCount : 0);
    const ranked: number[] = [];
    const matchedMessages = new Set<number>();
    const hasMatch = new Uint8Array(canSearch ? chunkCount : 0);
    const longestTerm = terms.reduce((maximum, term) => Math.max(maximum, term.length), 0);
    const spanningTerms = terms.some((term) => Buffer.byteLength(term) > STRIDE_BYTES);
    let tail = "";
    let streamId = -1;
    let streamEnd = 0;
    let searchedChunks = 0;
    const mark = (index: number, term: number): void => {
      const word = index * words + (term >>> 5);
      const bit = 1 << (term & 31);
      if ((matches[word]! & bit) !== 0) return;
      matches[word]! |= bit;
      df[term]!++;
      if (hasMatch[index] === 0) {
        ranked.push(index);
        hasMatch[index] = 1;
        matchedMessages.add(this.chunks[index]!.message.id);
      }
    };
    // Even on a build timeout, already indexed chunks remain available on the next query. No second
    // unchecked scoring phase is allowed to run past the time bound just to fabricate a full answer.
    for (let index = 0; index < chunkCount && canSearch; index++) {
      if (!check()) break;
      if (performance.now() - slice >= SLICE_MS) {
        await yieldSlice();
        if (!check()) break;
      }
      const chunk = this.chunks[index]!;
      const lower = chunk.text.toLowerCase();
      if (streamId !== chunk.message.id) {
        streamId = chunk.message.id;
        streamEnd = chunk.start;
        tail = "";
      }
      // A valid 1,000-character Unicode term can exceed one 2,048-byte window. Match it over
      // contiguous original text, never concatenate overlapping copies or different messages.
      const joinedStart = streamEnd - Buffer.byteLength(tail);
      const joined = spanningTerms ? tail + afterBytes(chunk.text, streamEnd - chunk.start) : "";
      const joinedLower = joined.toLowerCase();
      for (let term = 0; term < terms.length; term++) {
        if (lower.includes(terms[term]!)) mark(index, term);
        else if (spanningTerms && joinedLower.includes(terms[term]!)) {
          // Return the bounded windows covering the occurrence, rather than claiming a long term
          // is absent simply because no individual window can hold it. Every marked window belongs
          // to this source and intersects the small contiguous matching context.
          for (let previous = index; previous >= chunk.message.firstChunk && this.chunks[previous]!.end > joinedStart; previous--) mark(previous, term);
        }
      }
      streamEnd = chunk.end;
      if (spanningTerms) {
        let from = Math.max(0, joined.length - longestTerm - 1);
        if (from > 0 && /[\uDC00-\uDFFF]/.test(joined[from]!)) from++;
        tail = joined.slice(from);
      }
      searchedChunks++;
    }
    const matchedChunks = ranked.length;
    const weights = Array.from(df, (count) => Math.log(1 + (searchedChunks - count + 0.5) / (count + 0.5)));
    let scored = 0;
    for (const index of ranked) {
      if (!check()) break;
      if (performance.now() - slice >= SLICE_MS) {
        await yieldSlice();
        if (!check()) break;
      }
      let score = 0;
      for (let term = 0; term < terms.length; term++) {
        if ((matches[index * words + (term >>> 5)]! & (1 << (term & 31))) !== 0) score += weights[term]!;
      }
      scores[index] = score;
      scored++;
    }
    ranked.length = scored;
    // Heap construction/selection checks the same deadline and yields; a native whole-array sort
    // would be an unchecked synchronous phase after a query had already consumed its budget.
    const better = (a: number, b: number): boolean => scores[a]! > scores[b]! ||
      (scores[a] === scores[b] && (this.chunks[a]!.message.id < this.chunks[b]!.message.id ||
        (this.chunks[a]!.message.id === this.chunks[b]!.message.id && this.chunks[a]!.start < this.chunks[b]!.start)));
    const sift = (root: number): void => {
      for (;;) {
        let child = root * 2 + 1;
        if (child >= ranked.length) return;
        if (child + 1 < ranked.length && better(ranked[child + 1]!, ranked[child]!)) child++;
        if (!better(ranked[child]!, ranked[root]!)) return;
        [ranked[root], ranked[child]] = [ranked[child]!, ranked[root]!];
        root = child;
      }
    };
    for (let root = Math.floor(ranked.length / 2) - 1; root >= 0; root--) {
      if (!check()) { ranked.length = 0; break; }
      if (performance.now() - slice >= SLICE_MS) {
        await yieldSlice();
        if (!check()) { ranked.length = 0; break; }
      }
      sift(root);
    }
    const passages: EvidencePassage[] = [];
    const explained: EvidenceExplanation["matches"][number][] = [];
    let bytes = 0;
    let overlappingChunks = 0;
    let passageLimitedChunks = 0;
    let byteLimitedChunks = 0;
    let selected = 0;
    while (ranked.length > 0) {
      if (!check()) break;
      if (performance.now() - slice >= SLICE_MS) {
        await yieldSlice();
        if (!check()) break;
      }
      const index = ranked[0]!;
      const end = ranked.pop()!;
      if (ranked.length > 0) { ranked[0] = end; sift(0); }
      selected++;
      const chunk = this.chunks[index]!;
      const { id, kind, totalBytes } = chunk.message;
      let start = chunk.start;
      let text = chunk.text;
      for (const other of passages) {
        if (other.id !== id || other.start >= chunk.end || start >= other.end) continue;
        // A term larger than a passage needs adjacent fragments. Keep the uncovered suffix of an
        // overlapping window so the tail of that occurrence is not lost at the last source window.
        if (spanningTerms && other.end < chunk.end) start = Math.max(start, other.end);
        else { start = chunk.end; break; }
      }
      if (start === chunk.end) {
        overlappingChunks++;
        continue;
      }
      if (start !== chunk.start) text = afterBytes(text, start - chunk.start);
      if (passages.length >= options.maxPassages) {
        passageLimitedChunks++;
        continue;
      }
      if (bytes + chunk.end - start > options.maxBytes) {
        byteLimitedChunks++;
        continue;
      }
      bytes += chunk.end - start;
      passages.push({ id, kind, totalBytes, start, end: chunk.end, text, complete: start === 0 && chunk.end === totalBytes });
      explained.push({ id, start, end: chunk.end, score: scores[index]!, terms: terms.filter((_term, term) => (matches[index * words + (term >>> 5)]! & (1 << (term & 31))) !== 0) });
    }
    if (overlappingChunks > 0) omissions.add("overlapping-passages");
    if (passageLimitedChunks > 0) omissions.add("passage-limit");
    if (byteLimitedChunks > 0) omissions.add("passage-byte-limit");
    const searched: number[] = [];
    const unsearched: number[] = [];
    const incomplete: number[] = [];
    for (const id of matchedMessages) {
      if (!check()) break;
      if (performance.now() - slice >= SLICE_MS) {
        await yieldSlice();
        if (!check()) break;
      }
      const message = this.messages[id]!;
      (id < finishedThrough && message.firstChunk + message.chunks <= searchedChunks ? searched : unsearched).push(id);
      if (message.partial) incomplete.push(id);
    }
    if (next && !unsearched.includes(next.id)) unsearched.push(next.id);
    const withinDeadline = check();
    const complete = next === null && searchedChunks === chunkCount && scored === matchedChunks && selected === scored && (terms.length > 0 || upperBound === 0) && withinDeadline;
    return {
      passages, searched,
      missing: terms.filter((_term, index) => df[index] === 0),
      incomplete,
      complete, unsearched,
      explanation: {
        snapshot: { upperBound },
        index: { reused, retainedBytes: visibleBytes, capacityBytes: this.capacity.maxIndexBytes, chunks: chunkCount, messages: messageCount },
        coverage: {
          inspectedMessages: messageCount, fullyIndexedMessages, excludedMessages,
          indexedChunks: chunkCount, searchedChunks, sourceBytes, readBytes, partialMessages,
          next, unsearchedChunks: chunkCount - searchedChunks, complete,
        },
        omissions: [...omissions],
        selection: { matchedChunks, scoredChunks: scored, consideredChunks: selected, returnedPassages: passages.length, overlappingChunks, passageLimitedChunks, byteLimitedChunks },
        matches: explained,
      },
    };
  }
}

/** Slice a bounded page at an already-known UTF-8 byte boundary, without encoding the source. */
function afterBytes(text: string, offset: number): string {
  let bytes = 0;
  let char = 0;
  while (bytes < offset) {
    const code = text.codePointAt(char)!;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    char += code > 0xffff ? 2 : 1;
  }
  return text.slice(char);
}

/** The 1,024-byte stride ends before a code point, exactly as the source's UTF-8 paging does. */
function stride(text: string): number {
  let bytes = 0;
  for (let char = 0; char < text.length;) {
    const code = text.codePointAt(char)!;
    const width = code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    if (bytes + width > STRIDE_BYTES) break;
    bytes += width;
    char += code > 0xffff ? 2 : 1;
  }
  return bytes;
}
