import { Buffer } from "node:buffer";
import { DEFAULT_PAGE_BYTES, MAX_PAGE_BYTES, readTextPage, type MessageMetadata } from "./archive.js";
import { RULER } from "./prompts.js";
import { nodeKey, type Kind, type Message, Store, type TreeNode, type ViewSnapshot } from "./store.js";

export interface CompactionRequest {
  context: string;
  instruction: string;
  feedback: ReadonlyArray<{ reply: string; instruction: string }>;
}

export type Summarize = (
  request: CompactionRequest,
  signal: AbortSignal,
) => Promise<string>;

/** The compressor refused every model eligible for one compaction. The message carries no provider text. */
export class CompressorRefusedError extends Error {
  constructor() {
    super("compressor refused the compaction");
    this.name = "CompressorRefusedError";
  }
}

export interface MemoryOptions {
  nodeBytes?: number;
  viewBytes?: number;
  /** Upper compactor-context threshold; each batch targets half this size. */
  compactionViewBytes?: number;
  /** Source bytes per summarization page of an over-long node; 4..32768. */
  pageBytes?: number;
  jobs?: number;
  tries?: number;
  report?: (message: string) => void;
  /**
   * Optional importance hint for a level-0 leaf whose text is too long to keep verbatim. Its one sentence is
   * added to that leaf's compaction instruction. It is bounded and fail-open, and it never changes scheduling.
   */
  hint?: (source: { kind: Kind; text: string }, signal: AbortSignal) => Promise<string | undefined>;
  /** Bound for one hint call, in milliseconds; default 2000. */
  hintTimeoutMs?: number;
}

export interface ViewPart {
  readonly l: number;
  readonly i: number;
}

/** Every memory tool's name. Their call records are skipped by search; recall is registered on its own. */
export const MEMORY_TOOL_NAMES = ["zoom", "date", "work", "chat_search", "chat_recall"] as const;
/** Each search or recall result's text begins with its mark; search skips those results. */
export const MEMORY_RESULT_MARKS = ["[optchat search]", "[optchat recall]"] as const;
/** Every stored message kind, in the store's order. */
export const MESSAGE_KINDS = ["user", "talk", "tool", "echo", "note", "work"] as const satisfies readonly Kind[];
/** Deepest zoom that opens several levels at once: 2^4 = 16 lines. */
export const MAX_ZOOM_DEPTH = 4;
export const SEARCH_QUERY_CHARS = 200;
export const SEARCH_TERMS = 8;
export const SEARCH_LIMIT = 10;
export const SEARCH_MAX_LIMIT = 50;
/** A question word shorter than this many characters is not a ranking term. */
export const RANK_TERM_CHARS = 3;
/** Bytes of a search snippet before its whitespace is flattened and its cut marks added. */
const SNIPPET_BYTES = 240;
/** Bytes of a snippet kept before the first match. */
const SNIPPET_LEAD_BYTES = 80;

export interface SearchOptions {
  readonly kind?: Kind;
  readonly limit?: number;
  /** Only messages with id below this; a previous result's `next`. */
  readonly before?: number;
}

export interface RankOptions {
  /** How many ids to return at most, 1 to SEARCH_MAX_LIMIT. */
  readonly limit: number;
  /** Only messages with id below this, as in `search`. */
  readonly before?: number;
}

export interface SearchHit {
  readonly id: number;
  readonly kind: Kind;
  readonly date: string;
  readonly snippet: string;
}

/** Hits newest first. `next` is the `before` value for older hits, or null when none remain. */
export interface SearchResult {
  readonly hits: ReadonlyArray<SearchHit>;
  readonly next: number | null;
}

/** Structured zoom result. `next` is the byte offset of the following page, or null. */
export interface ZoomPage {
  readonly text: string;
  readonly next: number | null;
  readonly totalBytes: number;
  readonly offset: number;
}

interface Job {
  controller: AbortController;
  done: Promise<void>;
}

interface Compactor {
  /** Messages covered by `parts`; always a prefix of the built view. */
  length: number;
  parts: ViewPart[];
  bytes: number;
  pending: boolean;
}

/** Level-0 nodes admitted but not yet built, at most this many, regardless of `jobs`. */
const ADMISSION_WINDOW = 8;
const MIN_PAGE_BYTES = 4;
/** Marks and joins a source-derived stand-in: an excerpt of the source, never a summary. */
const EXTRACTIVE_MARK = "[unsummarized: compressor refused] ";
const EXTRACTIVE_JOIN = " | ";

export const utf8Bytes = (text: string): number => Buffer.byteLength(text, "utf8");

/** A hint as one bounded line, or undefined when nothing remains. */
function sentence(value: string): string | undefined {
  const line = utf8Prefix(flatten(value).trim(), 256);
  return line.length > 0 ? line : undefined;
}

/** Cut at a byte boundary without manufacturing a replacement character. */
export function utf8Prefix(text: string, budget: number): string {
  if (!Number.isSafeInteger(budget) || budget < 0) {
    throw new RangeError("UTF-8 budget must be a nonnegative safe integer");
  }
  if (utf8Bytes(text) <= budget) return text;
  // One UTF-16 code unit needs at least one UTF-8 byte. Encoding only this
  // bounded prefix avoids copying a huge rejected provider reply into feedback.
  let units = Math.min(text.length, budget);
  const last = text.charCodeAt(units - 1);
  if (units < text.length && last >= 0xd800 && last <= 0xdbff) units--;
  const bytes = Buffer.from(text.slice(0, units), "utf8");
  let end = Math.min(budget, bytes.length);
  while (end > 0 && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8");
}

/** Greedy packing of bounded summaries, including their separating newlines. */
function pack(items: readonly string[], budget: number): string[][] {
  const groups: string[][] = [];
  let group: string[] = [];
  let bytes = 0;
  for (const item of items) {
    const size = utf8Bytes(item);
    if (group.length > 0 && bytes + 1 + size > budget) {
      groups.push(group);
      group = [];
      bytes = 0;
    }
    bytes += size + (group.length > 0 ? 1 : 0);
    group.push(item);
  }
  if (group.length > 0) groups.push(group);
  return groups;
}

const PLACEHOLDER = "(not summarized yet: zoom it)";
const PLACEHOLDER_BYTES = utf8Bytes(PLACEHOLDER);
const flatten = (text: string): string => text.replace(/\r\n|\r|\n/g, " ");

/** The last `budget` UTF-8 bytes of `text`, never starting inside a character. */
function utf8Suffix(text: string, budget: number): string {
  // One UTF-16 code unit needs at least one UTF-8 byte.
  let start = Math.max(0, text.length - budget);
  const first = text.charCodeAt(start);
  if (start > 0 && first >= 0xdc00 && first <= 0xdfff) start++;
  const bytes = Buffer.from(text.slice(start), "utf8");
  let cut = Math.max(0, bytes.length - budget);
  while (cut < bytes.length && (bytes[cut]! & 0xc0) === 0x80) cut++;
  return bytes.subarray(cut).toString("utf8");
}

/** The index in `text` where position `index` of `text.toLowerCase()` begins. */
function originalIndex(text: string, lower: string, index: number): number {
  if (lower.length === text.length) return index;
  let lowered = 0;
  for (let i = 0; i < text.length;) {
    if (lowered >= index) return i;
    const char = String.fromCodePoint(text.codePointAt(i)!);
    lowered += char.toLowerCase().length;
    i += char.length;
  }
  return text.length;
}

/** About SNIPPET_BYTES of `text` around `at`, on one line, with "…" where it was cut. */
function snippet(text: string, at: number): string {
  const head = utf8Suffix(text.slice(Math.max(0, at - SNIPPET_LEAD_BYTES), at), SNIPPET_LEAD_BYTES);
  const tailBudget = SNIPPET_BYTES - utf8Bytes(head);
  const tail = utf8Prefix(text.slice(at, at + tailBudget), tailBudget);
  const body = `${head}${tail}`.replace(/\s+/g, " ").trim();
  return `${at - head.length > 0 ? "…" : ""}${body}${at + tail.length < text.length ? "…" : ""}`;
}

/** A memory tool's own call record or a search or recall result: never a search hit. */
function memoryRecord(message: Message): boolean {
  if (message.kind === "tool") return MEMORY_TOOL_NAMES.some((name) => message.text.startsWith(`${name} {`));
  if (message.kind === "echo") return MEMORY_RESULT_MARKS.some((mark) => message.text.startsWith(mark));
  return false;
}

const chat = (lines: string[]): string => ["<chat>", ...lines, "</chat>"].join("\n");

function samePairs(
  a: ReadonlyArray<readonly [number, number]>,
  b: ReadonlyArray<readonly [number, number]>,
): boolean {
  if (a.length !== b.length) return false;
  return a.every(([l, i], j) => l === b[j]![0] && i === b[j]![1]);
}

/** Whether the committed snapshot already equals the one about to be written. */
function sameSnapshot(saved: Store["viewSnapshot"], next: ViewSnapshot): boolean {
  if (!saved || !("compactor" in saved)) return false;
  return saved.length === next.length &&
    saved.compacting === next.compacting &&
    samePairs(saved.parts, next.parts) &&
    saved.compactor.length === next.compactor.length &&
    saved.compactor.compacting === next.compactor.compacting &&
    samePairs(saved.compactor.parts, next.compactor.parts);
}

function positive(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return result;
}

/**
 * An append-only binary summary tree with a live, never-split view. Store owns
 * durability; call close() before closing Store, even after a cancelled turn.
 *
 * Scheduling: a level-0 leaf is admitted while fewer than ADMISSION_WINDOW
 * admitted leaves are unbuilt. Higher nodes enter the ready queue when both
 * children are built, so out-of-order parents never wait on unrelated branches.
 * A failed call releases its job slot and is retried only when the next message
 * is appended; no timers are used.
 */
export class Memory {
  private readonly nodeBytes: number;
  private readonly budget: number;
  private readonly target: number;
  private readonly compactionBudget: number;
  private readonly compactionTarget: number;
  private readonly pageBytes: number;
  /** Whole shortest candidates may exceed the target, but never this ceiling. */
  private readonly summaryLimit: number;
  /** Reduction groups hold at least two bounded summaries plus their separator. */
  private readonly reduceBytes: number;
  private readonly jobs: number;
  private readonly tries: number;
  private readonly report: (message: string) => void;
  private readonly hint: MemoryOptions["hint"];
  private readonly hintTimeoutMs: number;
  private view: ViewPart[] = [];
  private bytes = 0;
  private compacting = false;
  private compactor: Compactor = { length: 0, parts: [], bytes: 0, pending: true };
  private readonly busy = new Map<string, Job>();
  /** Failed nodes awaiting the next append. */
  private readonly failed = new Map<string, ViewPart>();
  private readonly reported = new Set<string>();
  /** Nodes committed as source-derived stand-ins after a terminal compressor refusal, this process. */
  private extractiveNodes = 0;
  private readonly ready: ViewPart[] = [];
  private readyHead = 0;
  private readonly queued = new Set<string>();
  /** Level-0 indexes below `frontier` are built or admitted. */
  private frontier = 0;
  /** Admitted level-0 nodes not yet built, failed ones included. */
  private unbuilt = 0;
  private first = 0;
  private readonly waiters = new Set<(settled: boolean) => void>();
  private pumpQueued = false;
  private stopped = false;
  private closing: Promise<void> | undefined;

  constructor(
    readonly store: Store,
    private readonly summarize: Summarize,
    options: MemoryOptions = {},
  ) {
    this.nodeBytes = positive(options.nodeBytes, 512, "nodeBytes");
    this.budget = positive(options.viewBytes, 128_000, "viewBytes");
    this.target = Math.max(1, Math.floor(this.budget / 2));
    this.compactionBudget = positive(options.compactionViewBytes, 32_000, "compactionViewBytes");
    this.compactionTarget = Math.max(1, Math.floor(this.compactionBudget / 2));
    this.pageBytes = positive(options.pageBytes, DEFAULT_PAGE_BYTES, "pageBytes");
    if (this.pageBytes < MIN_PAGE_BYTES || this.pageBytes > MAX_PAGE_BYTES) {
      throw new RangeError(`pageBytes must be between ${MIN_PAGE_BYTES} and ${MAX_PAGE_BYTES}`);
    }
    this.summaryLimit = Math.max(this.nodeBytes, this.pageBytes);
    this.reduceBytes = 2 * this.summaryLimit + 1;
    this.jobs = positive(options.jobs, 8, "jobs");
    this.tries = positive(options.tries, 5, "tries");
    this.report = options.report ?? ((message) => console.error(message));
    this.hint = options.hint;
    this.hintTimeoutMs = positive(options.hintTimeoutMs, 2_000, "hintTimeoutMs");

    const snapshot = store.viewSnapshot;
    this.view = snapshot?.parts.map(([l, i]) => ({ l, i })) ?? [];
    this.compacting = snapshot?.compacting ?? false;
    // A crash can leave durable log records after the last view commit. Keep
    // its exact prefix; a missing snapshot is a one-time migration.
    for (let i = snapshot?.length ?? 0; i < store.messages.length; i++) {
      this.view.push({ l: 0, i });
    }
    // A legacy (version 1) snapshot has no compactor: it starts from the built prefix.
    const saved = snapshot && "compactor" in snapshot ? snapshot.compactor : undefined;
    const compactorParts = saved?.parts.map(([l, i]) => ({ l, i })) ?? [];
    this.compactor = {
      length: saved?.length ?? 0,
      parts: compactorParts,
      bytes: compactorParts.reduce((sum, part) => sum + (this.node(part)?.size ?? 0), 0),
      pending: saved?.compacting ?? true,
    };
    this.advanceFirst();
    for (const node of store.nodes.values()) this.enqueueParent({ l: node.l, i: node.i });
    this.commit(this.view, snapshot?.version === 1, saved !== undefined && saved.length === this.first);
    this.schedulePump();
  }

  append(kind: Kind, text: string, date?: Date, metadata?: MessageMetadata): Message {
    if (this.stopped) throw new Error("Memory is closed");
    const message = this.store.append(kind, text, date, metadata);
    // A new message is the only trigger that retries failed calls.
    for (const part of this.failed.values()) this.enqueue(part);
    this.failed.clear();
    this.commit([...this.view, { l: 0, i: message.i }]);
    this.schedulePump();
    return message;
  }

  /** A copied snapshot for browsing; callers cannot mutate the live tiling. */
  viewParts(): ReadonlyArray<ViewPart> {
    return this.view.map(({ l, i }) => ({ l, i }));
  }

  /**
   * Resolves true once every message is built, false once nothing can progress
   * until the next append (failed calls stall their branch), or false on abort.
   */
  settle(signal?: AbortSignal): Promise<boolean> {
    if (this.stopped || signal?.aborted) return Promise.resolve(false);
    this.pump();
    const settled = this.outcome();
    if (settled !== undefined) return Promise.resolve(settled);
    const { promise, resolve } = Promise.withResolvers<boolean>();
    const finish = (value: boolean) => {
      this.waiters.delete(finish);
      signal?.removeEventListener("abort", abort);
      resolve(value);
    };
    const abort = () => finish(false);
    this.waiters.add(finish);
    signal?.addEventListener("abort", abort, { once: true });
    return promise;
  }

  render(): string {
    return chat(this.view.map((part) => this.renderPart(part)));
  }

  /**
   * View lines with their summary text, flattened to one line. Merged lines (n >= 2) only, unless `leaves`:
   * prefetch opens lines one level, which a single message cannot be; recall reads a single message directly.
   */
  viewLines(leaves = false): Array<{ readonly id: number; readonly n: number; readonly text: string }> {
    const lines: Array<{ readonly id: number; readonly n: number; readonly text: string }> = [];
    for (const part of this.view) {
      if (part.l === 0 && !leaves) continue;
      const node = this.node(part);
      if (!node) continue;
      const n = 2 ** part.l;
      lines.push({ id: part.i * n, n, text: flatten(node.text) });
    }
    return lines;
  }

  /** The built line id+n, flattened like `viewLines`; undefined for an invalid address or an unbuilt node. */
  lineAt(id: number, n: number): { readonly id: number; readonly n: number; readonly text: string } | undefined {
    const level = Math.log2(n);
    if (
      !Number.isSafeInteger(id) || id < 0 ||
      !Number.isSafeInteger(n) || n <= 0 || !Number.isInteger(level) || 2 ** level !== n ||
      id % n !== 0 || id > this.store.messages.length - n
    ) {
      return undefined;
    }
    const node = this.node({ l: level, i: id / n });
    return node ? { id, n, text: flatten(node.text) } : undefined;
  }

  /**
   * Stored messages whose text contains every whitespace-separated term of `query`, case-insensitively,
   * newest first. Memory tool call records and search/recall results are skipped. Invalid input throws RangeError.
   */
  search(query: string, options: SearchOptions = {}): SearchResult {
    const trimmed = typeof query === "string" ? query.trim() : "";
    if (trimmed.length === 0 || trimmed.length > SEARCH_QUERY_CHARS) {
      throw new RangeError(`search text must be 1 to ${SEARCH_QUERY_CHARS} characters`);
    }
    const terms = trimmed.toLowerCase().split(/\s+/);
    if (terms.length > SEARCH_TERMS) throw new RangeError(`search text must have at most ${SEARCH_TERMS} words`);
    const { kind, limit = SEARCH_LIMIT, before } = options;
    if (kind !== undefined && !(MESSAGE_KINDS as readonly string[]).includes(kind)) {
      throw new RangeError(`kind must be one of ${MESSAGE_KINDS.join(", ")}`);
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > SEARCH_MAX_LIMIT) {
      throw new RangeError(`limit must be an integer from 1 to ${SEARCH_MAX_LIMIT}`);
    }
    if (before !== undefined && (!Number.isSafeInteger(before) || before < 0)) {
      throw new RangeError("before must be a nonnegative safe integer");
    }
    const messages = this.store.messages;
    const hits: SearchHit[] = [];
    for (let id = Math.min(before ?? messages.length, messages.length) - 1; id >= 0; id--) {
      const message = messages[id]!;
      if ((kind !== undefined && message.kind !== kind) || memoryRecord(message)) continue;
      const lower = message.text.toLowerCase();
      if (!terms.every((term) => lower.includes(term))) continue;
      // One match past the limit proves older hits remain.
      if (hits.length === limit) return { hits, next: hits[hits.length - 1]!.id };
      const at = originalIndex(message.text, lower, lower.indexOf(terms[0]!));
      hits.push({ id, kind: message.kind, date: message.date, snippet: snippet(message.text, at) });
    }
    return { hits, next: null };
  }

  /**
   * Stored message ids ranked against a natural-language question, best first, without a model. Terms are the
   * question's lowercased words (split on anything but letters and digits), deduplicated, of at least RANK_TERM_CHARS
   * characters. A message matches a term when its lowercased text contains it, as `search` matches. Over the scanned
   * messages (search's skips and `before` bound), each term weighs its BM25 inverse document frequency,
   * ln((N - df + 0.5) / (df + 0.5)), floored at 0, so a term in half the messages or more weighs nothing. A message
   * scores the sum of its matched terms' weights; only scores above 0 are ranked, and a tie goes to the newer message.
   * Invalid options throw RangeError.
   */
  rankMessages(question: string, options: RankOptions): number[] {
    const { limit, before } = options;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > SEARCH_MAX_LIMIT) {
      throw new RangeError(`limit must be an integer from 1 to ${SEARCH_MAX_LIMIT}`);
    }
    if (before !== undefined && (!Number.isSafeInteger(before) || before < 0)) {
      throw new RangeError("before must be a nonnegative safe integer");
    }
    const terms = [...new Set(question.toLowerCase().split(/[^\p{L}\p{N}]+/u))].filter(
      (term) => [...term].length >= RANK_TERM_CHARS,
    );
    if (terms.length === 0) return [];
    const messages = this.store.messages;
    const df = new Array<number>(terms.length).fill(0);
    const matched: Array<{ readonly id: number; readonly terms: number[] }> = [];
    let scanned = 0;
    for (let id = 0; id < Math.min(before ?? messages.length, messages.length); id++) {
      const message = messages[id]!;
      if (memoryRecord(message)) continue;
      scanned++;
      const lower = message.text.toLowerCase();
      let found: number[] | undefined;
      for (let term = 0; term < terms.length; term++) {
        if (!lower.includes(terms[term]!)) continue;
        df[term]!++;
        (found ??= []).push(term);
      }
      if (found) matched.push({ id, terms: found });
    }
    const weight = df.map((count) => Math.max(0, Math.log((scanned - count + 0.5) / (count + 0.5))));
    return matched
      .map(({ id, terms: found }) => ({ id, score: found.reduce((sum, term) => sum + weight[term]!, 0) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || b.id - a.id)
      .slice(0, limit)
      .map((entry) => entry.id);
  }

  /**
   * n=1: a bounded page of the message's exact source bytes, with a cursor.
   * n>1: the 2^depth lines `depth` levels under the node; offset must be zero and depth at most log2(n).
   * Invalid addresses and unbuilt lines throw RangeError.
   */
  zoom(id: number, n: number, offset = 0, depth = 1): ZoomPage {
    const length = this.store.messages.length;
    const level = Math.log2(n);
    if (
      !Number.isSafeInteger(id) || id < 0 ||
      !Number.isSafeInteger(n) || n <= 0 || 2 ** level !== n || !Number.isInteger(level) ||
      id % n !== 0 || id > length - n
    ) {
      throw new RangeError(`No line ${id}+${n}.`);
    }
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new RangeError("offset must be a nonnegative safe integer");
    }
    if (!Number.isSafeInteger(depth) || depth < 1 || depth > MAX_ZOOM_DEPTH) {
      throw new RangeError(`depth must be an integer from 1 to ${MAX_ZOOM_DEPTH}`);
    }
    if (n === 1) {
      if (depth !== 1) throw new RangeError("depth applies only to zoom with n > 1");
      const page = this.store.readMessagePage(id, offset);
      return { text: page.text, next: page.next, totalBytes: page.totalBytes, offset: page.offset };
    }
    if (offset !== 0) throw new RangeError("offset applies only to single-message zoom");
    if (depth > level) throw new RangeError(`depth ${depth} exceeds the ${level} levels under line ${id}+${n}`);
    const width = 2 ** depth;
    const parts: ViewPart[] = [];
    for (let k = 0; k < width; k++) parts.push({ l: level - depth, i: (id / n) * width + k });
    if (parts.some((part) => !this.node(part))) throw new RangeError(`No line ${id}+${n}.`);
    const text = parts.map((part) => this.renderPart(part)).join("\n");
    return { text, next: null, totalBytes: utf8Bytes(text), offset: 0 };
  }

  date(id: number): string {
    if (!Number.isSafeInteger(id) || id < 0 || id >= this.store.messages.length) {
      return `No message ${id}.`;
    }
    return new Date(this.store.messages[id]!.date).toLocaleString();
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.stopped = true;
    this.wake(false);
    const jobs = [...this.busy.values()];
    // Assign before aborting: an abort listener may synchronously call close.
    this.closing = Promise.all(jobs.map((job) => job.done)).then(() => undefined);
    for (const job of jobs) job.controller.abort();
    return this.closing;
  }

  status(): { messages: number; nodes: number; pending: number; viewBytes: number; parts: number; extractive: number } {
    return {
      messages: this.store.messages.length,
      nodes: this.store.nodes.size,
      pending: this.busy.size,
      viewBytes: this.bytes,
      parts: this.view.length,
      extractive: this.extractiveNodes,
    };
  }

  private node(part: ViewPart): TreeNode | undefined {
    return this.store.nodes.get(nodeKey(part.l, part.i));
  }

  private renderPart(part: ViewPart): string {
    const n = 2 ** part.l;
    return `${part.i * n}+${n}|${flatten(this.node(part)?.text ?? PLACEHOLDER)}`;
  }

  private size(parts: readonly ViewPart[]): number {
    let bytes = 0;
    for (const part of parts) bytes += this.node(part)?.size ?? PLACEHOLDER_BYTES;
    return bytes;
  }

  /** Merge oldest equal-due siblings. Age is measured from the pair's LAST
   * message, not its first: at T=10, 8+1|9+1 precedes 0+4|4+4. */
  private coarsen(parts: ViewPart[], bytes: number, target: number): number {
    const length = this.store.messages.length;
    while (bytes > target) {
      let best = -1;
      let due = -1;
      let parent: TreeNode | undefined;
      for (let j = 0; j + 1 < parts.length; j++) {
        const a = parts[j]!;
        const b = parts[j + 1]!;
        if (a.l !== b.l || a.i % 2 !== 0 || b.i !== a.i + 1) continue;
        const candidate = this.store.nodes.get(nodeKey(a.l + 1, a.i / 2));
        if (!candidate) continue;
        const width = 2 ** a.l;
        const age = (length - ((a.i + 2) * width - 1)) / width;
        if (age > due) {
          best = j;
          due = age;
          parent = candidate;
        }
      }
      if (best < 0 || !parent) break;
      bytes += parent.size - this.node(parts[best]!)!.size - this.node(parts[best + 1]!)!.size;
      parts.splice(best, 2, { l: parent.l, i: parent.i });
    }
    return bytes;
  }

  private advanceFirst(): void {
    while (this.first < this.store.messages.length && this.store.nodes.has(nodeKey(0, this.first))) this.first++;
  }

  /**
   * Publishes a main tiling and the compactor derived from it. Both are durable
   * in one snapshot before any of them becomes the live state.
   */
  private commit(proposed: ViewPart[], preserveMain = false, preserveCompactor = false): void {
    const length = this.store.messages.length;
    let bytes = this.size(proposed);
    let view = proposed;
    let compacting = this.compacting || (!preserveMain && bytes > this.budget);
    let merged = false;
    if (compacting && !preserveMain) {
      view = proposed.slice();
      const count = view.length;
      bytes = this.coarsen(view, bytes, this.target);
      merged = view.length !== count;
      compacting = bytes > this.target;
    }
    // Restore an unchanged compactor exactly, including its pending latch. A
    // merely available parent is not an event that may rewrite a saved prefix.
    const compactor = preserveCompactor && !merged
      ? this.compactor
      : this.advance(this.compactor, view, merged);
    const next: ViewSnapshot = {
      version: 2,
      length,
      parts: view.map(({ l, i }) => [l, i] as const),
      compacting,
      compactor: {
        length: compactor.length,
        parts: compactor.parts.map(({ l, i }) => [l, i] as const),
        compacting: compactor.pending,
      },
    };
    if (!sameSnapshot(this.store.viewSnapshot, next)) this.store.saveView(next);
    this.view = view;
    this.bytes = bytes;
    this.compacting = compacting;
    this.compactor = compactor;
  }

  /** Extends the built-prefix compactor from `previous`; pure except for node reads. */
  private advance(previous: Compactor, view: readonly ViewPart[], reset: boolean): Compactor {
    const next: Compactor = reset
      ? { length: 0, parts: [], bytes: 0, pending: true }
      : { length: previous.length, parts: previous.parts.slice(), bytes: previous.bytes, pending: previous.pending };
    for (const part of view) {
      const width = 2 ** part.l;
      const end = (part.i + 1) * width;
      if (end <= next.length) continue;
      if (end > this.first) break;
      const node = this.node(part);
      if (!node) break;
      next.parts.push(part);
      next.length = end;
      next.bytes += node.size;
    }
    if (next.bytes > this.compactionBudget) next.pending = true;
    if (next.pending) {
      next.bytes = this.coarsen(next.parts, next.bytes, this.compactionTarget);
      next.pending = next.bytes > this.compactionTarget;
    }
    return next;
  }

  private wake(settled: boolean): void {
    for (const finish of this.waiters) finish(settled);
  }

  /** Settled: true when built through the end; false when nothing can run. */
  private outcome(): boolean | undefined {
    if (this.first === this.store.messages.length) return true;
    if (this.busy.size === 0 && this.readyHead === this.ready.length) return false;
    return undefined;
  }

  private context(end: number): string {
    const lines: string[] = [];
    // Coarsening can stall on an unfinished parent. Bound the actual context
    // envelope too, without removing any bytes from the node's own source.
    let bytes = utf8Bytes("<chat>\n</chat>");
    const limit = this.compactionBudget + 4_096;
    for (const part of this.compactor.parts) {
      // A coarse line that straddles the request boundary contains future
      // messages too. Omit it, rather than leaking those messages as context.
      if ((part.i + 1) * 2 ** part.l > end) break;
      const node = this.node(part);
      if (!node) break;
      const line = this.renderPart(part);
      const size = utf8Bytes(line) + 1;
      if (bytes + size > limit) break;
      lines.push(line);
      bytes += size;
    }
    return chat(lines);
  }

  private enqueue(part: ViewPart): void {
    const key = nodeKey(part.l, part.i);
    if (this.queued.has(key) || this.busy.has(key) || this.store.nodes.has(key)) return;
    this.queued.add(key);
    this.ready.push(part);
  }

  /** Once both children of `part` exist, their parent becomes ready. */
  private enqueueParent(part: ViewPart): void {
    const sibling = part.i % 2 === 0 ? part.i + 1 : part.i - 1;
    if (!this.store.nodes.has(nodeKey(part.l, sibling))) return;
    this.enqueue({ l: part.l + 1, i: Math.floor(part.i / 2) });
  }

  /** Admits level-0 leaves while fewer than ADMISSION_WINDOW admitted leaves are unbuilt. */
  private admit(): void {
    const length = this.store.messages.length;
    while (this.frontier < length && this.unbuilt < ADMISSION_WINDOW) {
      const i = this.frontier++;
      if (this.store.nodes.has(nodeKey(0, i))) continue;
      this.unbuilt++;
      this.enqueue({ l: 0, i });
    }
  }

  private schedulePump(): void {
    if (this.pumpQueued || this.stopped) return;
    this.pumpQueued = true;
    queueMicrotask(() => {
      this.pumpQueued = false;
      this.pump();
    });
  }

  private pump(): void {
    if (this.stopped) return;
    this.admit();
    while (this.busy.size < this.jobs && this.readyHead < this.ready.length) {
      const part = this.ready[this.readyHead++]!;
      const key = nodeKey(part.l, part.i);
      this.queued.delete(key);
      if (!this.store.nodes.has(key) && !this.busy.has(key)) this.start(part, key);
    }
    if (this.readyHead === this.ready.length) {
      this.ready.length = 0;
      this.readyHead = 0;
    } else if (this.readyHead >= 1024 && this.readyHead * 2 >= this.ready.length) {
      this.ready.splice(0, this.readyHead);
      this.readyHead = 0;
    }
    if (this.waiters.size > 0) {
      const settled = this.outcome();
      if (settled !== undefined) this.wake(settled);
    }
  }

  private start(part: ViewPart, key: string): void {
    const controller = new AbortController();
    // Defer build until job.done is published: providers may call close during
    // their synchronous preamble, and close must await their actual promise.
    const work = Promise.resolve().then(() => this.build(part, controller.signal));
    let failure: { error: unknown } | undefined;
    const job: Job = {
      controller,
      done: work.then(
        () => undefined,
        (error: unknown) => {
          failure = { error };
        },
      ).finally(() => {
        // Release the slot and record the failure in one synchronous step, so no
        // append can observe the key as both busy and failed.
        this.busy.delete(key);
        if (failure && !this.stopped && !controller.signal.aborted) this.fail(part, failure.error);
        this.pump();
      }),
    };
    this.busy.set(key, job);
  }

  private fail(part: ViewPart, error: unknown): void {
    const key = nodeKey(part.l, part.i);
    this.failed.set(key, part);
    if (this.reported.has(key)) return;
    this.reported.add(key);
    // Rejection values are arbitrary: formatting itself may throw.
    let detail = "unprintable error";
    try {
      detail = String(error instanceof Error ? error.message : error);
    } catch {
      // Keep the fallback; the failure is still recorded.
    }
    const width = 2 ** part.l;
    try {
      // Detached, not awaited: a reporter may call close(), which awaits this job.
      void Promise.resolve(
        this.report(`OptChat compaction failed at ${part.i * width}+${width}; retrying on the next appended message: ${detail}`),
      ).catch(() => {});
    } catch {
      // Diagnostics must not break compaction or escape as unhandled work.
    }
  }

  private async build(part: ViewPart, signal: AbortSignal): Promise<void> {
    if (this.stopped || signal.aborted || this.store.nodes.has(nodeKey(part.l, part.i))) return;
    let source: string;
    let left: TreeNode | undefined;
    let right: TreeNode | undefined;
    if (part.l === 0) {
      const message = this.store.messages[part.i]!;
      source = `${message.kind}: ${message.text}`;
    } else {
      left = this.store.nodes.get(nodeKey(part.l - 1, part.i * 2))!;
      right = this.store.nodes.get(nodeKey(part.l - 1, part.i * 2 + 1))!;
      source = `${left.text}\n${right.text}`;
    }
    let text = source;
    let degraded = false;
    if (utf8Bytes(source) > this.nodeBytes) {
      const input = left && right ? `${flatten(left.text)}\n${flatten(right.text)}` : source;
      let summary: string | undefined;
      try {
        summary = await this.summarizeLong(part, input, signal);
      } catch (error) {
        // Only a terminal compressor refusal becomes a stand-in; other failures keep the append-driven retry.
        if (!(error instanceof CompressorRefusedError) || this.stopped || signal.aborted) throw error;
        summary = this.extractive(part, left, right);
        degraded = true;
      }
      if (summary === undefined) return;
      text = summary;
    }
    if (this.stopped || signal.aborted) return;
    this.store.saveNode({ l: part.l, i: part.i, text, size: utf8Bytes(text) });
    if (degraded) {
      this.extractiveNodes++;
      this.reportExtractive(part);
    }
    this.reported.delete(nodeKey(part.l, part.i));
    if (part.l === 0) this.unbuilt--;
    this.advanceFirst();
    this.enqueueParent(part);
    this.commit(this.view);
  }

  /**
   * Summarizes an over-long node. Every page of the input is summarized, then
   * summaries are reduced in bounded groups until one final line remains. The
   * result is returned only when complete; undefined means cancelled.
   */
  private async summarizeLong(part: ViewPart, input: string, signal: AbortSignal): Promise<string | undefined> {
    const width = 2 ** part.l;
    const start = part.i * width;
    const end = part.l === 0 ? part.i : (part.i + 1) * width;
    const context = this.context(end);
    const half = width / 2;
    // Only a level-0 leaf that reaches this path is non-free: merges and verbatim nodes never ask for a hint.
    const hint = part.l === 0 ? await this.hintFor(part.i, signal) : undefined;
    if (this.stopped || signal.aborted) return undefined;
    const task = part.l === 0
      ? `compress message ${start}`
      : `merge lines ${start}+${half} and ${start + half}+${half}, adjacent,`;
    const details = part.l === 0
      ? (hint === undefined ? "" : `${hint}\n`)
      : `<chat> may hold their messages, ${start} to ${end - 1}, in more detail: take details\nof them from there too.\n`;
    const leaf = (body: string): string =>
      `Compaction: ${task} into one line of at most ${this.nodeBytes} bytes\n${this.ruler()}\n${RULER}\n${details}<input>\n${body}\n</input>`;

    if (utf8Bytes(input) <= this.pageBytes) return this.compact(context, leaf(input), signal);

    // Pages are exact UTF-8 slices of the input; only bounded partial summaries
    // are retained, never the page strings themselves.
    const summaries: string[] = [];
    let offset: number | null = 0;
    let pageNumber = 0;
    while (offset !== null) {
      if (this.stopped || signal.aborted) return undefined;
      const page = readTextPage(input, offset, this.pageBytes);
      const reply = await this.compact(
        context,
        `Compaction: ${task}, part ${++pageNumber}, source bytes ${page.offset} to ${page.next ?? page.totalBytes} of ${page.totalBytes}, into one line of at most ${this.nodeBytes} bytes. Other parts are summarized separately: keep only what this part states.\n${this.ruler()}\n${RULER}\n${details}<input>\n${page.text}\n</input>`,
        signal,
      );
      if (reply === undefined) return undefined;
      summaries.push(reply);
      offset = page.next;
    }

    let items = summaries;
    while (items.length > 1) {
      const groups = pack(items, this.reduceBytes);
      if (groups.length === 1) {
        return this.compact(
          context,
          leaf(`Ordered partial summaries of the complete input:\n${items.join("\n")}`),
          signal,
        );
      }
      const next: string[] = [];
      for (const group of groups) {
        if (group.length === 1) {
          next.push(group[0]!);
          continue;
        }
        const merged = await this.compact(
          context,
          `Compaction: ${task}; merge these ${group.length} ordered partial summaries of the complete input into one line of at most ${this.nodeBytes} bytes\n${this.ruler()}\n${RULER}\n<input>\n${group.join("\n")}\n</input>`,
          signal,
        );
        if (merged === undefined) return undefined;
        next.push(merged);
      }
      // Each group's first two items always fit, so every round shrinks the list.
      items = next;
    }
    return items[0];
  }

  /**
   * The hint sentence for leaf `i`, or undefined. Bounded by `hintTimeoutMs` and by the job's signal; any
   * failure, timeout or cancellation yields no hint, and the leaf is compacted exactly as without one.
   */
  private async hintFor(i: number, parent: AbortSignal): Promise<string | undefined> {
    const hint = this.hint;
    if (!hint || parent.aborted) return undefined;
    const message = this.store.messages[i]!;
    const source = { kind: message.kind, text: message.text };
    const controller = new AbortController();
    const { promise: bound, resolve } = Promise.withResolvers<undefined>();
    const giveUp = () => {
      controller.abort();
      resolve(undefined);
    };
    const timer = setTimeout(giveUp, this.hintTimeoutMs);
    parent.addEventListener("abort", giveUp, { once: true });
    try {
      const value = await Promise.race([
        Promise.resolve().then(() => hint(source, controller.signal)).catch(() => undefined),
        bound,
      ]);
      return typeof value === "string" ? sentence(value) : undefined;
    } finally {
      clearTimeout(timer);
      parent.removeEventListener("abort", giveUp);
    }
  }

  /**
   * Source-derived stand-in for a node the compressor refused everywhere: a marked
   * excerpt of its source within the node budget. A merge keeps both children,
   * sharing the room between them. The original messages remain zoomable.
   */
  private extractive(part: ViewPart, left: TreeNode | undefined, right: TreeNode | undefined): string {
    if (!left || !right) {
      return utf8Prefix(`${EXTRACTIVE_MARK}${flatten(this.store.messages[part.i]!.text)}`, this.nodeBytes);
    }
    const first = flatten(left.text);
    const second = flatten(right.text);
    const room = Math.max(0, this.nodeBytes - utf8Bytes(EXTRACTIVE_MARK) - utf8Bytes(EXTRACTIVE_JOIN));
    const secondBytes = Math.min(utf8Bytes(second), room - Math.min(utf8Bytes(first), Math.floor(room / 2)));
    const firstBytes = Math.min(utf8Bytes(first), room - secondBytes);
    return utf8Prefix(
      `${EXTRACTIVE_MARK}${utf8Prefix(first, firstBytes)}${EXTRACTIVE_JOIN}${utf8Prefix(second, secondBytes)}`,
      this.nodeBytes,
    );
  }

  private reportExtractive(part: ViewPart): void {
    const width = 2 ** part.l;
    try {
      // Detached, as failure reports are: a reporter may call close(), which awaits this job.
      void Promise.resolve(
        this.report(
          `unsummarized at ${part.i * width}+${width}: the compressor refused it; stored a marked source excerpt (zoom returns the originals)`,
        ),
      ).catch(() => {});
    } catch {
      // Diagnostics must not break compaction.
    }
  }

  /**
   * At most `tries` calls (five by default), keeping the shortest whole reply.
   * Replies beyond the safety ceiling are never stored or replayed in full.
   * If no whole candidate fits that ceiling, fail rather than truncate content.
   */
  private async compact(context: string, instruction: string, signal: AbortSignal): Promise<string | undefined> {
    let feedback: CompactionRequest["feedback"] = [];
    let shortest: { text: string; size: number } | undefined;
    for (let attempt = 0; attempt < this.tries; attempt++) {
      if (this.stopped || signal.aborted) return undefined;
      const reply = (await this.summarize({ context, instruction, feedback }, signal)).trim();
      if (this.stopped || signal.aborted) return undefined;
      if (!reply) throw new Error("Compactor returned an empty summary");
      const size = utf8Bytes(reply);
      if (size <= this.nodeBytes) return reply;
      if (size <= this.summaryLimit && (!shortest || size < shortest.size)) shortest = { text: reply, size };
      if (attempt + 1 === this.tries) break;
      const excerpt = utf8Prefix(reply, this.summaryLimit);
      // Keep one bounded feedback turn, not an ever-growing history of full
      // provider replies. The original input stays unchanged on every attempt.
      feedback = [{
        reply: excerpt,
        instruction: `${size > this.summaryLimit ? "Previous reply excerpt only; omitted bytes are not a complete summary. " : ""}Too long: your line is ${size} bytes, over the ${this.nodeBytes}-byte limit. Write\nthe whole line again for the same <input>, cutting just enough of the\nleast valuable items to fit before this cut:\n${utf8Prefix(excerpt, this.nodeBytes)}| ← LIMIT`,
      }];
    }
    if (!shortest) throw new Error(`Compactor returned no whole summary within the ${this.summaryLimit}-byte safety ceiling`);
    return shortest.text;
  }

  private ruler(): string {
    return this.nodeBytes === 512
      ? "(about 70 words), the length of this ruler:"
      : "The ruler is a fixed 512-byte reference; the numeric limit above is authoritative:";
  }
}
