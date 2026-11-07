import { DEFAULT_PAGE_BYTES, MAX_PAGE_BYTES, type TextPage } from "./archive.js";
import type { Message } from "./store.js";

/** Original records already validate size when admitted; paging must not recompute it over the whole text. */
type Source = Pick<Message, "text" | "kind" | "size">;
interface Position { char: number; byte: number }
interface PageIndex {
  readonly checkpoints: Position[];
  spacing: number;
  start: Position;
  end: Position;
}
const MAX_SOURCES = 64;
const MAX_CHECKPOINTS = 256;
const INITIAL_SPACING = 4_096;
const DEFAULT_TRAVERSAL_BYTES = 65_536;
// Bounded derived metadata only. The original immutable record is the cache identity; callers must not
// manufacture a new wrapper per page. Old checkpoints are thinned, never grown without a ceiling.
const indexes = new WeakMap<Source, PageIndex>();
const recent = new Map<PageIndex, WeakRef<Source>>();

export class SourcePageBudgetError extends Error {
  constructor(readonly traversedBytes: number) {
    super("Source page traversal exceeds its byte budget");
    this.name = "SourcePageBudgetError";
  }
}

/**
 * Exact UTF-8 paging without archive.readTextPage's whole-source indexing pass. Offset zero costs only
 * the returned page; successive/overlapping windows seek from recent byte/character cursors. Random
 * jumps stop after maxTraversalBytes instead of synchronously walking an arbitrarily large record.
 * traversedBytes charges both seeking and the returned page, not the source's total size. A failed
 * bounded seek keeps only derived checkpoints so a later bounded call may continue making progress.
 */
export function readSourcePage(
  message: Source, offset = 0, maxBytes = DEFAULT_PAGE_BYTES, maxTraversalBytes = DEFAULT_TRAVERSAL_BYTES,
): TextPage & { readonly traversedBytes: number } {
  const totalBytes = message.size - message.kind.length - 2;
  if (!Number.isSafeInteger(totalBytes) || totalBytes < message.text.length || totalBytes > message.text.length * 3 ||
    !Number.isSafeInteger(offset) || offset < 0 || offset > totalBytes) {
    throw new RangeError("Invalid source size or UTF-8 page offset");
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_PAGE_BYTES ||
    !Number.isSafeInteger(maxTraversalBytes) || maxTraversalBytes < 0) {
    throw new RangeError("Invalid source page byte budget");
  }
  maxTraversalBytes = Math.min(maxTraversalBytes, DEFAULT_TRAVERSAL_BYTES);
  let index = indexes.get(message);
  const reference = index ? recent.get(index) : undefined;
  if (index) recent.delete(index);
  else {
    index = { checkpoints: [{ char: 0, byte: 0 }], spacing: INITIAL_SPACING, start: { char: 0, byte: 0 }, end: { char: 0, byte: 0 } };
    indexes.set(message, index);
  }
  recent.set(index, reference ?? new WeakRef(message));
  if (recent.size > MAX_SOURCES) {
    const [oldIndex, oldReference] = recent.entries().next().value!;
    const oldSource = oldReference.deref();
    if (oldSource) indexes.delete(oldSource);
    recent.delete(oldIndex);
  }

  let low = 0;
  let high = index.checkpoints.length;
  while (low + 1 < high) {
    const middle = (low + high) >>> 1;
    if (index.checkpoints[middle]!.byte <= offset) low = middle;
    else high = middle;
  }
  let origin = index.checkpoints[low]!;
  for (const position of [index.start, index.end]) {
    if (position.byte <= offset && position.byte > origin.byte) origin = position;
  }
  let { char, byte } = origin;
  let traversedBytes = 0;
  const advance = (code: number, width: number): void => {
    if (traversedBytes + width > maxTraversalBytes) {
      index.end = { char, byte };
      throw new SourcePageBudgetError(traversedBytes);
    }
    byte += width;
    char += code > 0xffff ? 2 : 1;
    traversedBytes += width;
    if (byte - index.checkpoints.at(-1)!.byte >= index.spacing) {
      if (index.checkpoints.length === MAX_CHECKPOINTS) {
        for (let at = 1; at < MAX_CHECKPOINTS / 2; at++) index.checkpoints[at] = index.checkpoints[at * 2]!;
        index.checkpoints.length = MAX_CHECKPOINTS / 2;
        index.spacing *= 2;
      }
      index.checkpoints.push({ char, byte });
    }
  };
  while (byte < offset) {
    const code = message.text.codePointAt(char);
    if (code === undefined) throw new Error("Source size does not match its original text");
    advance(code, widthOf(code));
  }
  if (byte !== offset) throw new RangeError("Source page offset must be on a UTF-8 code-point boundary");
  const start = char;
  index.start = { char, byte };
  while (char < message.text.length) {
    const code = message.text.codePointAt(char)!;
    const width = widthOf(code);
    if (byte - offset + width > maxBytes) break;
    advance(code, width);
  }
  index.end = { char, byte };
  if (byte > totalBytes || (char === message.text.length && byte !== totalBytes)) throw new Error("Source size does not match its original text");
  if (byte === offset && byte < totalBytes) throw new RangeError("Source page limit is too small for its next UTF-8 code point");
  return {
    text: Buffer.from(message.text.slice(start, char), "utf8").toString("utf8"),
    offset, next: byte < totalBytes ? byte : null, totalBytes, traversedBytes,
  };
}

function widthOf(code: number): number {
  return code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
}
