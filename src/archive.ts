import { createHash } from "node:crypto";

export const DEFAULT_PAGE_BYTES = 16_384;
export const MAX_PAGE_BYTES = 32_768;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGE_SIDE = 16_384;
export const MAX_IMAGE_PIXELS = 40_000_000;
export const MAX_IMAGES_PER_MESSAGE = 32;
export const MAX_WORK_TEXT_BYTES = 256;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export interface TextPage {
  readonly text: string;
  readonly offset: number;
  readonly next: number | null;
  readonly totalBytes: number;
}

interface TextIndex {
  readonly checkpoints: readonly { char: number; byte: number }[];
  readonly totalBytes: number;
}
// Cache sparse offsets, not a second full copy of every source. Multiple live
// leaf reductions can page interleaved sources without re-encoding each source
// on every call. The finite LRU also avoids retaining every historical string.
const textIndexes = new Map<string, TextIndex>();
const utf8Width = (code: number): number => code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;

function indexText(text: string): TextIndex {
  let index = textIndexes.get(text);
  if (index !== undefined) textIndexes.delete(text);
  else {
    const checkpoints = [{ char: 0, byte: 0 }];
    let totalBytes = 0;
    let checkpointChar = 0;
    for (let char = 0; char < text.length;) {
      if (char - checkpointChar >= 1024) {
        checkpoints.push({ char, byte: totalBytes });
        checkpointChar = char;
      }
      const code = text.codePointAt(char)!;
      totalBytes += utf8Width(code);
      char += code > 0xffff ? 2 : 1;
    }
    index = { checkpoints, totalBytes };
  }
  textIndexes.set(text, index);
  if (textIndexes.size > 16) textIndexes.delete(textIndexes.keys().next().value!);
  return index;
}

/**
 * Pages exact UTF-8 source bytes. Offsets and limits must be integers; offsets
 * must sit on a code-point boundary (or the end), and limits are capped at the
 * hard maximum. Paging is non-lossy: `next` resumes at the byte after the page.
 */
export function readTextPage(text: string, offset = 0, maxBytes = DEFAULT_PAGE_BYTES): TextPage {
  if (typeof text !== "string") throw new Error("Page text must be a string");
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_PAGE_BYTES) {
    throw new Error(`Page limit must be an integer from 1 to ${MAX_PAGE_BYTES} bytes`);
  }
  const { checkpoints, totalBytes } = indexText(text);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > totalBytes) {
    throw new Error(`Page offset must be an integer from 0 to ${totalBytes}`);
  }
  let low = 0;
  let high = checkpoints.length;
  while (low + 1 < high) {
    const middle = (low + high) >>> 1;
    if (checkpoints[middle]!.byte <= offset) low = middle;
    else high = middle;
  }
  let { char, byte } = checkpoints[low]!;
  while (byte < offset) {
    const code = text.codePointAt(char)!;
    byte += utf8Width(code);
    char += code > 0xffff ? 2 : 1;
  }
  if (byte !== offset) throw new Error("Page offset must start on a UTF-8 code-point boundary");
  const start = char;
  while (char < text.length) {
    const code = text.codePointAt(char)!;
    const width = utf8Width(code);
    if (byte - offset + width > maxBytes) break;
    byte += width;
    char += code > 0xffff ? 2 : 1;
  }
  if (byte === offset && byte < totalBytes) throw new Error("Page limit is too small for the next UTF-8 code point");
  return Object.freeze({
    // Encoding only the page preserves TextEncoder's handling of lone surrogates.
    text: decoder.decode(encoder.encode(text.slice(start, char))),
    offset,
    next: byte < totalBytes ? byte : null,
    totalBytes,
  });
}

export type WorkSource = "task" | "async-result" | "launch-completion";
export type WorkCompleteness = "full" | "pointer-only";
export type ImageMimeType = "image/png" | "image/jpeg" | "image/webp";

export interface WorkMetadata {
  readonly source: WorkSource;
  readonly completeness: WorkCompleteness;
  readonly id?: string;
  readonly name?: string;
  readonly agentId?: string;
}

export interface ImageDescriptor {
  readonly sha256: string;
  readonly mimeType: ImageMimeType;
  readonly bytes: number;
  readonly width: number;
  readonly height: number;
}

export interface ImageAttachment extends ImageDescriptor {
  /** Source content-block index; strictly increasing within one message. */
  readonly order: number;
}

export interface ValidatedImage {
  readonly descriptor: ImageDescriptor;
  readonly bytes: Buffer;
}

export interface CoordinationIdentity {
  readonly instanceId: string;
  readonly generation: number;
  readonly sessionId: string;
}

/** Host-authored provenance for an agent coordination note, never human authority. */
export interface CoordinationMetadata {
  readonly version: 1;
  readonly requestId: string;
  readonly sender: CoordinationIdentity;
  readonly recipient: CoordinationIdentity;
  readonly admission: "idle" | "busy";
  readonly admittedAt: number;
}

export interface MessageMetadata {
  readonly work?: WorkMetadata;
  readonly images?: readonly ImageAttachment[];
  readonly resultFor?: number;
  readonly coordination?: CoordinationMetadata;
}

const workSources: Record<WorkSource, true> = { task: true, "async-result": true, "launch-completion": true };
const completenessValues: Record<WorkCompleteness, true> = { full: true, "pointer-only": true };
const mimeTypes: Record<ImageMimeType, true> = { "image/png": true, "image/jpeg": true, "image/webp": true };
const hasOwn = (value: object, key: string): boolean => Object.hasOwn(value, key);

function fail(where: string, reason: string): never {
  throw new Error(`Invalid ${where}: ${reason}`);
}

function plainRecord(value: unknown, required: string[], optional: string[], where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(where, "expected an object");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== "string" || (!required.includes(key) && !optional.includes(key)))) fail(where, "unsupported fields");
  if (!required.every((key) => hasOwn(descriptors, key))) fail(where, "missing required fields");
  const copied: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(descriptors)) {
    const descriptor = descriptors[key]!;
    if (!("value" in descriptor) || !descriptor.enumerable) fail(where, "fields must be enumerable data properties");
    copied[key] = descriptor.value;
  }
  return copied;
}

const isIndex = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function boundedText(value: unknown, where: string): string {
  if (typeof value !== "string" || value.length === 0 || encoder.encode(value).byteLength > MAX_WORK_TEXT_BYTES) {
    fail(where, `must be a nonempty string of at most ${MAX_WORK_TEXT_BYTES} UTF-8 bytes`);
  }
  return value;
}

function parseWork(value: unknown): WorkMetadata {
  const row = plainRecord(value, ["source", "completeness"], ["id", "name", "agentId"], "work metadata");
  if (typeof row.source !== "string" || !hasOwn(workSources, row.source)) fail("work metadata", "unsupported source");
  if (typeof row.completeness !== "string" || !hasOwn(completenessValues, row.completeness)) {
    fail("work metadata", "unsupported completeness");
  }
  const work: { source: WorkSource; completeness: WorkCompleteness; id?: string; name?: string; agentId?: string } = {
    source: row.source as WorkSource,
    completeness: row.completeness as WorkCompleteness,
  };
  if (hasOwn(row, "id")) work.id = boundedText(row.id, "work metadata id");
  if (hasOwn(row, "name")) work.name = boundedText(row.name, "work metadata name");
  if (hasOwn(row, "agentId")) work.agentId = boundedText(row.agentId, "work metadata agentId");
  return Object.freeze(work);
}

function coordinationIdentity(value: unknown, where: string): CoordinationIdentity {
  const row = plainRecord(value, ["instanceId", "generation", "sessionId"], [], where);
  if (typeof row.instanceId !== "string" || !/^[a-z0-9-]{8,64}$/.test(row.instanceId)) {
    fail(where, "invalid instanceId");
  }
  if (!isIndex(row.generation) || row.generation === 0) fail(where, "generation must be a positive safe integer");
  // Match the host registry's character bound, not the work-metadata byte bound.
  if (typeof row.sessionId !== "string" || row.sessionId.length === 0 || row.sessionId.length > 1024) {
    fail(where, "sessionId must contain 1 to 1024 characters");
  }
  return Object.freeze({ instanceId: row.instanceId, generation: row.generation, sessionId: row.sessionId });
}

function decodeCoordination(value: unknown): CoordinationMetadata {
  const row = plainRecord(value, ["version", "requestId", "sender", "recipient", "admission", "admittedAt"], [], "coordination metadata");
  if (row.version !== 1) fail("coordination metadata", "unsupported version");
  if (typeof row.requestId !== "string" || !/^[A-Za-z0-9._:-]{8,128}$/.test(row.requestId)) {
    fail("coordination metadata", "invalid requestId");
  }
  if (row.admission !== "idle" && row.admission !== "busy") fail("coordination metadata", "invalid admission");
  if (!isIndex(row.admittedAt) || row.admittedAt === 0) fail("coordination metadata", "admittedAt must be a positive safe integer");
  const sender = coordinationIdentity(row.sender, "coordination sender");
  const recipient = coordinationIdentity(row.recipient, "coordination recipient");
  return Object.freeze({ version: 1, requestId: row.requestId, sender, recipient, admission: row.admission, admittedAt: row.admittedAt });
}

/** Live capture rejects malformed host details without assigning agent provenance. */
export function parseCoordination(value: unknown): CoordinationMetadata | undefined {
  try {
    return decodeCoordination(value);
  } catch {
    return undefined;
  }
}

export function parseImageDescriptor(value: unknown): ImageDescriptor {
  const row = plainRecord(value, ["sha256", "mimeType", "bytes", "width", "height"], [], "image descriptor");
  if (typeof row.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(row.sha256)) fail("image descriptor", "sha256 must be lowercase hex");
  if (typeof row.mimeType !== "string" || !hasOwn(mimeTypes, row.mimeType)) fail("image descriptor", "unsupported mime type");
  if (!isIndex(row.bytes) || row.bytes < 1 || row.bytes > MAX_IMAGE_BYTES) fail("image descriptor", "bytes out of range");
  if (!isIndex(row.width) || !isIndex(row.height) || row.width < 1 || row.height < 1 ||
    row.width > MAX_IMAGE_SIDE || row.height > MAX_IMAGE_SIDE || row.width * row.height > MAX_IMAGE_PIXELS) {
    fail("image descriptor", "dimensions out of range");
  }
  return Object.freeze({
    sha256: row.sha256, mimeType: row.mimeType as ImageMimeType,
    bytes: row.bytes, width: row.width, height: row.height,
  });
}

function parseAttachments(value: unknown): readonly ImageAttachment[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_IMAGES_PER_MESSAGE) {
    fail("message images", `must be a nonempty array of at most ${MAX_IMAGES_PER_MESSAGE} entries`);
  }
  let previous = -1;
  return Object.freeze(value.map((entry: unknown) => {
    const row = plainRecord(entry, ["sha256", "mimeType", "bytes", "width", "height", "order"], [], "image attachment");
    if (!isIndex(row.order) || row.order <= previous) fail("image attachment", "order must be strictly increasing");
    previous = row.order;
    const { sha256, mimeType, bytes, width, height, order } = row;
    return Object.freeze({ ...parseImageDescriptor({ sha256, mimeType, bytes, width, height }), order });
  }));
}

/**
 * Strict metadata admission: exact enumerable data keys, bounded text and images,
 * and fresh frozen copies. resultFor is a nonnegative safe-integer message index;
 * coordination preserves host-authored agent identities. Callers must still check
 * link target existence and semantics, kind coupling, and image storage.
 */
export function parseMetadata(value: unknown): MessageMetadata {
  const row = plainRecord(value, [], ["work", "images", "resultFor", "coordination"], "message metadata");
  const result: { work?: WorkMetadata; images?: readonly ImageAttachment[]; resultFor?: number; coordination?: CoordinationMetadata } = {};
  if (hasOwn(row, "work")) result.work = parseWork(row.work);
  if (hasOwn(row, "images")) result.images = parseAttachments(row.images);
  if (hasOwn(row, "resultFor")) {
    if (!isIndex(row.resultFor)) fail("message metadata", "resultFor must be a nonnegative safe integer");
    result.resultFor = row.resultFor;
  }
  if (hasOwn(row, "coordination")) result.coordination = decodeCoordination(row.coordination);
  if (result.work === undefined && result.images === undefined && result.resultFor === undefined && result.coordination === undefined) {
    fail("message metadata", "must not be empty");
  }
  return Object.freeze(result);
}

const u32be = (b: Uint8Array, o: number): number => ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;
const u16be = (b: Uint8Array, o: number): number => (b[o]! << 8) | b[o + 1]!;
const u16le = (b: Uint8Array, o: number): number => b[o]! | (b[o + 1]! << 8);
const u32le = (b: Uint8Array, o: number): number => (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

type Dimensions = { mimeType: ImageMimeType; width: number; height: number };

// Chunks must tile the file exactly, carry valid CRCs, start with IHDR, and end at IEND.
function inspectPng(b: Uint8Array): Dimensions {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (b.length < 33 || sig.some((byte, k) => b[k] !== byte)) fail("image", "not a PNG");
  let offset = 8;
  let width = 0;
  let height = 0;
  let index = 0;
  while (true) {
    if (offset + 12 > b.length) fail("image", "truncated PNG chunk");
    const length = u32be(b, offset);
    if (length > b.length - offset - 12) fail("image", "PNG chunk exceeds file");
    const type = String.fromCharCode(b[offset + 4]!, b[offset + 5]!, b[offset + 6]!, b[offset + 7]!);
    if (!/^[A-Za-z]{4}$/.test(type)) fail("image", "invalid PNG chunk type");
    if (index === 0 && (type !== "IHDR" || length !== 13)) fail("image", "PNG must begin with IHDR");
    const dataStart = offset + 8;
    if (crc32(b.subarray(offset + 4, dataStart + length)) !== u32be(b, dataStart + length)) {
      fail("image", "PNG chunk CRC mismatch");
    }
    if (index === 0) {
      width = u32be(b, dataStart);
      height = u32be(b, dataStart + 4);
    }
    offset = dataStart + length + 4;
    index++;
    if (type === "IEND") {
      if (length !== 0 || offset !== b.length) fail("image", "PNG has data after IEND");
      break;
    }
  }
  return { mimeType: "image/png", width, height };
}

// Requires a baseline or progressive frame header, then a start-of-scan segment
// with entropy-coded bytes before the final EOI. This is structural admission:
// it does not decode the scan, so header-only or frame-only files are refused.
function inspectJpeg(b: Uint8Array): Dimensions {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) fail("image", "not a JPEG");
  if (b[b.length - 2] !== 0xff || b[b.length - 1] !== 0xd9) fail("image", "JPEG must end with EOI");
  let offset = 2;
  let frame: Dimensions | undefined;
  while (offset + 4 <= b.length) {
    if (b[offset] !== 0xff) fail("image", "invalid JPEG marker");
    const marker = b[offset + 1]!;
    if (marker === 0xff) { offset++; continue; }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
    if (marker === 0xd9) fail("image", "JPEG reached EOI without a scan");
    const length = u16be(b, offset + 2);
    if (length < 2 || offset + 2 + length > b.length) fail("image", "JPEG segment exceeds file");
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      if (length < 8) fail("image", "JPEG frame header truncated");
      frame = {
        mimeType: "image/jpeg",
        height: u16be(b, offset + 5),
        width: u16be(b, offset + 7),
      };
    } else if (marker === 0xda) {
      if (frame === undefined) fail("image", "JPEG scan precedes its frame header");
      // Entropy-coded data must sit between this segment and the final EOI.
      if (offset + 2 + length >= b.length - 2) fail("image", "JPEG scan has no entropy-coded data");
      return frame;
    }
    offset += 2 + length;
  }
  fail("image", "JPEG has no supported frame and scan");
}

// Accepts exactly one simple VP8 or VP8L chunk. Extended (VP8X) and animated files are refused.
function inspectWebp(b: Uint8Array): Dimensions {
  if (b.length < 30 || String.fromCharCode(...b.subarray(0, 4)) !== "RIFF" || String.fromCharCode(...b.subarray(8, 12)) !== "WEBP") {
    fail("image", "not a WebP");
  }
  if (u32le(b, 4) !== b.length - 8) fail("image", "WebP RIFF size mismatch");
  const fourcc = String.fromCharCode(...b.subarray(12, 16));
  const size = u32le(b, 16);
  if (12 + 8 + size + (size & 1) !== b.length) fail("image", "WebP must contain exactly one image chunk");
  if (fourcc === "VP8 ") {
    if (size < 10 || (b[20]! & 1) !== 0 || b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) {
      fail("image", "invalid lossy WebP header");
    }
    return { mimeType: "image/webp", width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
  }
  if (fourcc === "VP8L") {
    if (size < 5 || b[20] !== 0x2f) fail("image", "invalid lossless WebP header");
    const bits = u32le(b, 21);
    return { mimeType: "image/webp", width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  fail("image", "unsupported WebP chunk");
}

/** Recognizes a supported image from its bytes, returning its format and dimensions. */
export function inspectImage(bytes: Uint8Array): Dimensions {
  if (bytes.length < 8) fail("image", "too small");
  if (bytes[0] === 0x89) return inspectPng(bytes);
  if (bytes[0] === 0xff) return inspectJpeg(bytes);
  if (bytes[0] === 0x52) return inspectWebp(bytes);
  fail("image", "unsupported format");
}

const canonicalBase64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const maxBase64Length = 4 * Math.ceil(MAX_IMAGE_BYTES / 3);

/**
 * Admits one base64 image: canonical encoding, size bounds before decoding, a
 * structurally valid file of the declared mime type, and a SHA-256 content address.
 */
export function validateImage(data: string, mimeType: ImageMimeType): ValidatedImage {
  if (typeof data !== "string" || data.length === 0 || data.length > maxBase64Length || !canonicalBase64.test(data)) {
    fail("image", "data must be canonical base64 within the byte limit");
  }
  if (!hasOwn(mimeTypes, mimeType)) fail("image", "unsupported mime type");
  const bytes = Buffer.from(data, "base64");
  if (bytes.length > MAX_IMAGE_BYTES || bytes.toString("base64") !== data) {
    fail("image", "data must be canonical base64 within the byte limit");
  }
  const inspected = inspectImage(bytes);
  if (inspected.mimeType !== mimeType) fail("image", "declared mime type does not match content");
  if (inspected.width < 1 || inspected.height < 1 || inspected.width > MAX_IMAGE_SIDE ||
    inspected.height > MAX_IMAGE_SIDE || inspected.width * inspected.height > MAX_IMAGE_PIXELS) {
    fail("image", "dimensions out of range");
  }
  const descriptor = Object.freeze({
    sha256: createHash("sha256").update(bytes).digest("hex"),
    mimeType,
    bytes: bytes.length,
    width: inspected.width,
    height: inspected.height,
  });
  return { descriptor, bytes };
}
