import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  readSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { basename, dirname, join, resolve } from "node:path";
import {
  DEFAULT_PAGE_BYTES, inspectImage, parseImageDescriptor, parseMetadata, readTextPage, validateImage,
  type ImageAttachment, type ImageDescriptor, type ImageMimeType, type MessageMetadata, type TextPage,
} from "./archive.js";

export type Kind = "user" | "talk" | "tool" | "echo" | "note" | "work";
export interface Message {
  i: number;
  kind: Kind;
  text: string;
  size: number;
  date: string;
  readonly metadata?: MessageMetadata;
}
export interface MessagePage extends TextPage {
  readonly i: number;
  readonly kind: Kind;
  readonly date: string;
  readonly size: number;
  readonly metadata?: MessageMetadata;
}
export interface TreeNode {
  l: number;
  i: number;
  text: string;
  size: number;
}
export const nodeKey = (l: number, i: number): string => `${l}:${i}`;
/**
 * Durable main-view tiling. Ordered [level, index] parts cover messages
 * [0, length) exactly, each spanning [i * 2 ** l, (i + 1) * 2 ** l). Level-0
 * parts may still be unbuilt; higher levels name saved tree nodes. `length` may
 * trail the message log after a crash: the owner appends the durable suffix.
 * `compacting` latches a partially coarsened batch across restarts. No text.
 * `compactor` (v2) tiles [0, compactor.length) with built nodes only and
 * `compactor.length <= length`; its latch is independent of the main tiling.
 */
export interface ViewState {
  readonly length: number;
  readonly parts: ReadonlyArray<readonly [number, number]>;
  readonly compacting: boolean;
}
export interface ViewSnapshot extends ViewState {
  readonly version: 2;
  readonly compactor: ViewState;
}
/** Disk-only v1 snapshot, admitted once for migration and never written again. */
export interface LegacyViewSnapshot extends ViewState {
  readonly version: 1;
}

type Report = (message: string) => void;
type Stream = {
  /** User-facing location for diagnostics only; I/O goes through `fd`. */
  path: string;
  fd: number;
  writer?: { day: string; fd: number };
};
type Lease = { server: Server; failure?: Error };
/** Another live writer holds this directory's lease. Nothing was read or changed in the directory. */
export class StoreLeaseConflictError extends Error {
  override name = "StoreLeaseConflictError";
}
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const filePattern = /^\d{4}-\d{2}-\d{2}\.jsonl$/;
const nodeFields = ["l", "i", "text", "size"];
const viewName = "view.json";
const digestName = /^[0-9a-f]{64}$/;
// randomUUID() emits lowercase RFC 4122 version-4 strings; nothing else is ours.
const uuidV4 = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const imageTempName = new RegExp(`^\\.image-${uuidV4}\\.tmp$`);
const viewTempName = new RegExp(`^\\.view-${uuidV4}\\.tmp$`);

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function record(value: unknown, fields: string[], where: string, optional: string[] = []): Record<string, unknown> {
  if (
    typeof value !== "object" || value === null || Array.isArray(value) ||
    Object.keys(value).some((key) => !fields.includes(key) && !optional.includes(key)) ||
    !fields.every((field) => Object.hasOwn(value, field))
  ) {
    throw new Error(`Invalid record schema at ${where}`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const copied: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string") throw new Error(`Invalid record fields at ${where}`);
    const descriptor = descriptors[key]!;
    if (!("value" in descriptor) || !descriptor.enumerable) throw new Error(`Invalid record data property at ${where}`);
    copied[key] = descriptor.value;
  }
  return copied;
}

function isIndex(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isKind(value: unknown): value is Kind {
  return value === "user" || value === "talk" || value === "tool" ||
    value === "echo" || value === "note" || value === "work";
}

// Work kind and work metadata must describe each other exactly.
function checkCoupling(kind: Kind, metadata: MessageMetadata | undefined, where: string): void {
  if ((kind === "work") !== (metadata?.work !== undefined)) {
    throw new Error(`Work kind and work metadata must accompany each other at ${where}`);
  }
}

function parseMessage(value: unknown, where: string): Message {
  const row = record(value, ["i", "kind", "text", "size", "date"], where, ["metadata"]);
  if (
    !isIndex(row.i) || !isKind(row.kind) || typeof row.text !== "string" ||
    typeof row.size !== "number" || row.size !== row.kind.length + 2 + Buffer.byteLength(row.text, "utf8") ||
    typeof row.date !== "string" || !Number.isFinite(Date.parse(row.date)) ||
    new Date(row.date).toISOString() !== row.date
  ) {
    throw new Error(`Invalid message schema, size, date, or index at ${where}`);
  }
  const metadata = Object.hasOwn(row, "metadata") ? parseMetadata(row.metadata) : undefined;
  checkCoupling(row.kind, metadata, where);
  return Object.freeze({
    i: row.i, kind: row.kind, text: row.text,
    size: row.size, date: row.date,
    ...(metadata === undefined ? {} : { metadata }),
  });
}

function parseNode(value: unknown, where: string): TreeNode {
  const row = record(value, nodeFields, where);
  if (
    !isIndex(row.l) || row.l > 52 || !isIndex(row.i) ||
    typeof row.text !== "string" || row.text.length === 0 ||
    typeof row.size !== "number" || row.size !== Buffer.byteLength(row.text, "utf8")
  ) {
    throw new Error(`Invalid tree node schema, size, or coordinates at ${where}`);
  }
  return Object.freeze({
    l: row.l, i: row.i, text: row.text, size: row.size,
  });
}

// Reads every caller-controlled value once, then publishes a deep frozen copy.
// `builtOnly` requires every part to name a saved node, including level 0.
function parseTiling(
  length: unknown,
  parts: unknown,
  compacting: unknown,
  where: string,
  limit: number,
  nodes: ReadonlyMap<string, TreeNode>,
  builtOnly: boolean,
): ViewState {
  if (
    !isIndex(length) || length > limit ||
    typeof compacting !== "boolean" || !Array.isArray(parts)
  ) {
    throw new Error(`Invalid view tiling schema or length at ${where}`);
  }
  const count = parts.length;
  const copied: (readonly [number, number])[] = [];
  let end = 0;
  for (let k = 0; k < count; k++) {
    const part: unknown = parts[k];
    if (!Array.isArray(part) || part.length !== 2) {
      throw new Error(`Invalid view part ${k} at ${where}`);
    }
    const l: unknown = part[0];
    const i: unknown = part[1];
    if (!isIndex(l) || l > 52 || !isIndex(i)) {
      throw new Error(`Invalid view part ${k} coordinates at ${where}`);
    }
    const next = (i + 1) * 2 ** l;
    if (!Number.isSafeInteger(next) || i * 2 ** l !== end || next > length) {
      throw new Error(`View part ${nodeKey(l, i)} leaves a gap, overlap, or overrun at ${where}`);
    }
    if ((builtOnly || l > 0) && !nodes.has(nodeKey(l, i))) {
      throw new Error(`View part ${nodeKey(l, i)} names an unbuilt summary at ${where}`);
    }
    copied.push(Object.freeze([l, i] as const));
    end = next;
  }
  if (end !== length) {
    throw new Error(`View parts do not cover messages [0, ${length}) at ${where}`);
  }
  return Object.freeze({ length, parts: Object.freeze(copied), compacting });
}

function parseViewV2(value: unknown, where: string, messages: number, nodes: ReadonlyMap<string, TreeNode>): ViewSnapshot {
  const row = record(value, ["version", "length", "parts", "compacting", "compactor"], where);
  if (row.version !== 2) throw new Error(`Only version 2 view snapshots can be written at ${where}`);
  const main = parseTiling(row.length, row.parts, row.compacting, where, messages, nodes, false);
  const compactorWhere = `${where} compactor`;
  const compactor = record(row.compactor, ["length", "parts", "compacting"], compactorWhere);
  const built = parseTiling(compactor.length, compactor.parts, compactor.compacting, compactorWhere, main.length, nodes, true);
  return Object.freeze({ version: 2, ...main, compactor: built });
}

// Disk replay admits v1 only so the owner can migrate it once; anything else is rejected.
function parseSnapshot(value: unknown, where: string, messages: number, nodes: ReadonlyMap<string, TreeNode>): ViewSnapshot | LegacyViewSnapshot {
  if (typeof value === "object" && value !== null && (value as Record<string, unknown>).version === 1) {
    const row = record(value, ["version", "length", "parts", "compacting"], where);
    const main = parseTiling(row.length, row.parts, row.compacting, where, messages, nodes, false);
    return Object.freeze({ version: 1, ...main });
  }
  return parseViewV2(value, where, messages, nodes);
}

// Names daily files by the local wall-clock day a record is written.
function localDay(date: Date): string {
  const year = date.getFullYear();
  if (!Number.isFinite(date.getTime()) || year < 0 || year > 9999) {
    throw new Error("Store write clock must have a valid local year between 0000 and 9999");
  }
  return `${String(year).padStart(4, "0")}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function checkOwner(fd: number, path: string, directory: boolean): void {
  const info = fstatSync(fd);
  if (
    (directory ? !info.isDirectory() : !info.isFile()) ||
    info.uid !== process.getuid!() || (!directory && info.nlink !== 1)
  ) {
    throw new Error(`Store requires an owned ${directory ? "directory" : "regular file with one hard link"}: ${path}`);
  }
  const mode = directory ? 0o700 : 0o600;
  if ((info.mode & 0o7777) !== mode) {
    fchmodSync(fd, mode);
    fsyncSync(fd);
  }
}

// Procfs exposes each descriptor as a magic link to its inode, not to the path
// used to open it. Node has no *at() calls, so `at(fd, name)` stands in for
// openat/mkdirat(fd, name): renaming or replacing any ancestor pathname cannot
// redirect it, while O_NOFOLLOW still guards the final entry.
function descriptorPath(fd: number): string {
  return `/proc/self/fd/${fd}`;
}

function at(directoryFd: number, name: string): string {
  return `${descriptorPath(directoryFd)}/${name}`;
}

// `path` may be descriptor-relative; `display` names it in diagnostics.
function openDirectory(path: string, display: string, follow = false): number {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | (follow ? 0 : constants.O_NOFOLLOW));
  try {
    checkOwner(fd, display, true);
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

// Creates `name` inside the held parent and fsyncs that same parent, so the entry
// is durable where it was actually made, whatever the parent's pathname is now.
function makeDirectory(parentFd: number, name: string): void {
  try {
    mkdirSync(at(parentFd, name), { mode: 0o700 });
  } catch (error) {
    if (!hasCode(error, "EEXIST")) throw error;
  }
  fsyncSync(parentFd);
}

// Existing ancestors belong to the caller: their symlinks are followed and they
// are never chmod'ed. Missing ancestors are created privately, each anchored to
// the descriptor of its parent.
function openAncestor(path: string): number {
  try {
    return openSync(path, constants.O_RDONLY | constants.O_DIRECTORY);
  } catch (error) {
    if (!hasCode(error, "ENOENT") || dirname(path) === path) throw error;
  }
  const parent = openAncestor(dirname(path));
  try {
    makeDirectory(parent, basename(path));
    return openSync(at(parent, basename(path)), constants.O_RDONLY | constants.O_DIRECTORY);
  } finally {
    closeSync(parent);
  }
}

// The only pathname resolution of a Store's life. A caller's symlinked root alias
// is followed here once; the lease then binds the opened inode, and every later
// operation is relative to the returned descriptor.
function openRoot(path: string): number {
  if (dirname(path) === path) return openDirectory(path, path, true);
  const parent = openAncestor(dirname(path));
  try {
    makeDirectory(parent, basename(path));
    return openDirectory(at(parent, basename(path)), path, true);
  } finally {
    closeSync(parent);
  }
}

function openStream(rootFd: number, directory: string, name: "main" | "tree" | "images"): Stream {
  const path = join(directory, name);
  makeDirectory(rootFd, name);
  return { path, fd: openDirectory(at(rootFd, name), path) };
}

// An existing images directory is attached before replay so references can be
// verified; a missing one is created only after replay and snapshot validation.
function openExistingStream(rootFd: number, directory: string, name: "images"): Stream | undefined {
  const path = join(directory, name);
  try {
    return { path, fd: openDirectory(at(rootFd, name), path) };
  } catch (error) {
    if (hasCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

function openFile(path: string, display: string, flags: number): number {
  // NONBLOCK makes hostile FIFOs/devices fail validation rather than hang open().
  const fd = openSync(path, flags | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    checkOwner(fd, display, false);
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

async function acquireLease(rootFd: number): Promise<Lease> {
  const identity = fstatSync(rootFd, { bigint: true });
  const key = createHash("sha256").update(`${identity.dev}:${identity.ino}`).digest("hex");
  const server = createServer((socket) => socket.destroy());
  const lease: Lease = { server };
  const ready = Promise.withResolvers<void>();
  let listening = false;
  server.on("error", (error: Error) => {
    lease.failure = error;
    if (!listening) {
      ready.reject(hasCode(error, "EADDRINUSE")
        ? new StoreLeaseConflictError("Store is already open by another writer", { cause: error })
        : error);
    }
  });
  server.once("listening", () => {
    listening = true;
    server.unref();
    ready.resolve();
  });
  // Linux abstract sockets have no filesystem entry to unlink or steal.
  // All writers must share a network namespace. The kernel owns crash cleanup.
  server.listen({ path: `\0omp-optchat-${key}`, exclusive: true, backlog: 1 });
  await ready.promise;
  return lease;
}

function closeLease(lease: Lease): Promise<void> {
  if (!lease.server.listening) return Promise.resolve();
  const closed = Promise.withResolvers<void>();
  lease.server.close((error?: Error) => error ? closed.reject(error) : closed.resolve());
  return closed.promise;
}

async function release(rootFd: number, streams: Stream[], lease?: Lease): Promise<void> {
  const errors: unknown[] = [];
  const close = (fd: number) => {
    try { closeSync(fd); } catch (error) { errors.push(error); }
  };
  for (const stream of streams) {
    if (stream.writer) close(stream.writer.fd);
    close(stream.fd);
  }
  close(rootFd);
  // Release ownership only after every synchronous writer descriptor is closed.
  if (lease) {
    try { await closeLease(lease); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, "Failed to close Store resources");
}

function writeDurably(fd: number, text: string): void {
  const bytes = Buffer.from(text, "utf8");
  if (writeSync(fd, bytes) !== bytes.length) {
    throw new Error("Short Store write; close and reopen to recover the torn line");
  }
  fsyncSync(fd);
}

// Loads the committed view after log replay. Both the file and the rename that
// committed it become durable before the snapshot is published.
function loadView(
  rootFd: number,
  directory: string,
  messages: number,
  nodes: ReadonlyMap<string, TreeNode>,
): ViewSnapshot | LegacyViewSnapshot | undefined {
  const path = join(directory, viewName);
  let fd: number;
  try {
    fd = openFile(at(rootFd, viewName), path, constants.O_RDONLY);
  } catch (error) {
    // Stores written before view snapshots exist have none; the owner migrates.
    if (hasCode(error, "ENOENT")) return undefined;
    throw error;
  }
  let bytes: Buffer;
  try {
    fsyncSync(fd);
    bytes = readFileSync(fd);
  } finally {
    closeSync(fd);
  }
  fsyncSync(rootFd);
  let value: unknown;
  try {
    value = JSON.parse(decoder.decode(bytes));
  } catch (error) {
    throw new Error(`Malformed JSON or UTF-8 view snapshot at ${path}`, { cause: error });
  }
  return parseSnapshot(value, path, messages, nodes);
}

// Commits the view only after its complete private file is durable. Every name
// resolves against the leased root inode, even if the public root path moves.
// A failed write unlinks its own temporary; a crash may leave an inert
// `.view-<uuid>.tmp` (0600, no text), which the next Store.open reclaims.
function replaceView(rootFd: number, directory: string, text: string): void {
  const target = at(rootFd, viewName);
  try {
    // Refuse to replace a planted link or non-file; tightens a loose mode.
    closeSync(openFile(target, join(directory, viewName), constants.O_RDONLY));
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
  }
  const name = `.view-${randomUUID()}.tmp`;
  const display = join(directory, name);
  const temporary = at(rootFd, name);
  const fd = openSync(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    0o600,
  );
  let pending = true;
  try {
    try {
      checkOwner(fd, display, false);
      const bytes = Buffer.from(text, "utf8");
      if (writeSync(fd, bytes) !== bytes.length) throw new Error(`Short Store write at ${display}`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, target);
    pending = false;
    fsyncSync(rootFd);
  } catch (error) {
    if (pending) {
      try {
        unlinkSync(temporary);
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], `View write and temporary cleanup failed at ${display}`, { cause: error });
      }
    }
    throw error;
  }
}

// Never let a concurrently enlarged file turn a bounded attachment into an
// unbounded read. Read one extra byte to reject growth, and recheck the inode.
function readImageBytes(fd: number, expected: number, display: string): Buffer {
  if (fstatSync(fd).size !== expected) throw new Error(`Image size mismatch at ${display}`);
  const bytes = Buffer.allocUnsafe(expected + 1);
  let offset = 0;
  while (offset < bytes.length) {
    const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
    if (count === 0) break;
    offset += count;
  }
  checkOwner(fd, display, false);
  if (offset !== expected || fstatSync(fd).size !== expected) throw new Error(`Image size changed at ${display}`);
  return bytes.subarray(0, expected);
}

// Content-addressed images live beside the logs. Identical bytes share one name;
// an existing entry is reread and must match the digest it was named for.
function storeImageBytes(imagesFd: number, display: string, descriptor: ImageDescriptor, bytes: Buffer): void {
  const target = at(imagesFd, descriptor.sha256);
  const existing = (() => {
    try {
      return openFile(target, join(display, descriptor.sha256), constants.O_RDONLY);
    } catch (error) {
      if (hasCode(error, "ENOENT")) return undefined;
      throw error;
    }
  })();
  if (existing !== undefined) {
    try {
      if (!readImageBytes(existing, descriptor.bytes, display).equals(bytes)) throw new Error(`Corrupt stored image ${descriptor.sha256}`);
      // A previous writer could have died after rename but before directory fsync.
      fsyncSync(existing);
      fsyncSync(imagesFd);
    } finally {
      closeSync(existing);
    }
    return;
  }
  const name = `.image-${randomUUID()}.tmp`;
  const temporary = at(imagesFd, name);
  const fd = openSync(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    0o600,
  );
  let pending = true;
  try {
    try {
      checkOwner(fd, join(display, name), false);
      if (writeSync(fd, bytes) !== bytes.length) throw new Error(`Short image write for ${descriptor.sha256}`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, target);
    pending = false;
    fsyncSync(imagesFd);
  } catch (error) {
    if (pending) {
      try {
        unlinkSync(temporary);
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], `Image write and temporary cleanup failed for ${descriptor.sha256}`, { cause: error });
      }
    }
    throw error;
  }
}

// Sibling archive names of a closed store, tried in order: `<dir>.<UTC stamp>`, then `-2`, `-3`, ...
function archiveName(directory: string, now: Date, attempt: number): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return attempt === 1 ? `${directory}.${stamp}` : `${directory}.${stamp}-${attempt}`;
}

function fsyncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** The first archive name for `directory` that is free now. Advisory: archiveStoreDirectory claims the name itself. */
export function nextArchivePath(directory: string, now: Date): string {
  for (let attempt = 1; ; attempt++) {
    const candidate = archiveName(directory, now, attempt);
    try {
      lstatSync(candidate);
    } catch (error) {
      if (hasCode(error, "ENOENT")) return candidate;
      throw error;
    }
  }
}

/**
 * Moves a closed store's directory to a sibling archive and returns its path. The name is claimed with mkdir first:
 * rename(2) would silently replace an empty directory, and a taken name must never be replaced. Only the directory
 * entry moves, so every file keeps its bytes. The caller closes the Store first.
 */
export function archiveStoreDirectory(directory: string, now: Date, report?: Report): string {
  for (let attempt = 1; ; attempt++) {
    const archive = archiveName(directory, now, attempt);
    try {
      mkdirSync(archive, { mode: 0o700 });
    } catch (error) {
      if (hasCode(error, "EEXIST")) continue;
      throw error;
    }
    try {
      renameSync(directory, archive);
    } catch (error) {
      // The claim is still our own empty directory: remove it, so a failed archive leaves nothing behind.
      try {
        rmdirSync(archive);
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], `Store archive and claim cleanup failed at ${archive}`, { cause: error });
      }
      throw error;
    }
    try {
      fsyncDirectory(dirname(directory));
    } catch (error) {
      // The rename is done and no file moved out of reach: only its durability is unconfirmed, so this is a warning.
      reportSafely(report, `Store archived to ${archive}, but syncing its parent directory failed: ${String(error)}`);
    }
    return archive;
  }
}

function reportSafely(report: Report | undefined, message: string): void {
  try { (report ?? console.warn)(message); } catch { /* Diagnostics must not change replay semantics. */ }
}

// Opens without following links; only an owned regular file is eligible for GC.
function isRegularFile(path: string): boolean {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (hasCode(error, "ELOOP") || hasCode(error, "ENOENT")) return false;
    throw error;
  }
  try {
    const info = fstatSync(fd);
    return info.isFile() && info.uid === process.getuid!();
  } finally {
    closeSync(fd);
  }
}

// Startup-only reclamation, called by Store.open after the complete history and
// view snapshot validated, under the writer lease, so no save can be in flight.
// Replayed message metadata is the sole reference set. Only exact-name regular
// files are unlinked; symlinks, directories, and unknown entries are left alone.
// Each directory with successful unlinks is fsynced once, even after partial
// failures. Never throws: the Store stays usable and the outcome is reported once.
function collectGarbage(rootFd: number, images: Stream, messages: readonly Message[], report?: Report): void {
  const referenced = new Set<string>();
  for (const message of messages) {
    for (const image of message.metadata?.images ?? []) referenced.add(image.sha256);
  }
  let collected = 0;
  let failed = 0;
  const sweep = (dirFd: number, eligible: (name: string) => boolean): void => {
    let removed = 0;
    try {
      for (const name of readdirSync(descriptorPath(dirFd))) {
        if (!eligible(name)) continue;
        const path = at(dirFd, name);
        try {
          if (!isRegularFile(path)) continue;
          unlinkSync(path);
          removed++;
        } catch {
          failed++;
        }
      }
    } catch {
      failed++;
    }
    collected += removed;
    if (removed === 0) return;
    try {
      fsyncSync(dirFd);
    } catch {
      failed++;
    }
  };
  sweep(rootFd, (name) => viewTempName.test(name));
  sweep(images.fd, (name) => imageTempName.test(name) || (digestName.test(name) && !referenced.has(name)));
  if (collected === 0 && failed === 0) return;
  const warning = failed === 0 ? "" : `; warning: ${failed} cleanup operation(s) failed`;
  reportSafely(report, `Store garbage collection: collected ${collected} file(s)${warning}`);
}

/**
 * Private append-only storage on a local Linux filesystem supporting fsync.
 * The abstract Unix socket owns the lock until close/process death; there is no
 * PID, age timeout, stale pathname, or lock takeover. Published records are frozen.
 * The collections are Store-owned; callers read them, never mutate them.
 * After open, all I/O is relative to held directory descriptors (Linux procfs
 * links), so renaming or replacing the root or stream pathnames cannot redirect
 * replay, repairs, or writer rollover away from the leased inode. Daily files are
 * named by local write day; each message keeps its caller-supplied date.
 * `view.json` holds the latest committed ViewSnapshot, replaced atomically.
 */
export class Store {
  readonly messages: Message[] = [];
  readonly nodes = new Map<string, TreeNode>();
  private view?: ViewSnapshot | LegacyViewSnapshot;
  private closing?: Promise<void>;
  private closed = false;
  private failed = false;

  private constructor(
    /** Canonical root path when opened, for reporting; never re-resolved for I/O. */
    readonly directory: string,
    private readonly rootFd: number,
    private readonly main: Stream,
    private readonly tree: Stream,
    private images: Stream | undefined,
    private readonly lease: Lease,
  ) {}

  static async open(directory: string, report?: Report): Promise<Store> {
    if (process.platform !== "linux" || typeof process.getuid !== "function" || !existsSync("/proc/self/fd")) {
      throw new Error("Store requires Linux procfs descriptor links, abstract Unix sockets and private POSIX filesystem permissions");
    }
    if (typeof directory !== "string" || directory.length === 0) {
      throw new Error("Store directory must be a nonempty path");
    }
    const rootFd = openRoot(resolve(directory));
    const streams: Stream[] = [];
    let lease: Lease | undefined;
    try {
      const canonical = readlinkSync(descriptorPath(rootFd));
      lease = await acquireLease(rootFd);
      const main = openStream(rootFd, canonical, "main");
      streams.push(main);
      const tree = openStream(rootFd, canonical, "tree");
      streams.push(tree);
      const images = openExistingStream(rootFd, canonical, "images");
      if (images) streams.push(images);
      const store = new Store(canonical, rootFd, main, tree, images, lease);
      store.replay(report);
      store.view = loadView(rootFd, canonical, store.messages.length, store.nodes);
      if (store.images === undefined) {
        store.images = openStream(rootFd, canonical, "images");
        streams.push(store.images);
      }
      collectGarbage(rootFd, store.images, store.messages, report);
      return store;
    } catch (error) {
      try {
        await release(rootFd, streams, lease);
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "Store open and cleanup failed", { cause: error });
      }
      throw error;
    }
  }

  private assertWritable(): void {
    if (this.closed) throw new Error("Store is closing or closed");
    if (this.failed || this.lease.failure || !this.lease.server.listening) {
      throw new Error("Store write or lock failed; close and reopen before writing again");
    }
  }

  private validateCoverage(node: TreeNode): void {
    const end = (node.i + 1) * 2 ** node.l;
    if (!Number.isSafeInteger(end) || end > this.messages.length) {
      throw new Error(`Tree node ${nodeKey(node.l, node.i)} extends beyond the message range`);
    }
    if (node.l > 0 && (
      !this.nodes.has(nodeKey(node.l - 1, node.i * 2)) ||
      !this.nodes.has(nodeKey(node.l - 1, node.i * 2 + 1))
    )) {
      throw new Error(`Tree node ${nodeKey(node.l, node.i)} is missing a child dependency`);
    }
  }

  private replay(report?: Report): void {
    // Torn files keep their read descriptor so repair extends the inode just read.
    const torn: { fd: number; path: string }[] = [];
    const readStream = (stream: Stream, receive: (value: unknown, where: string) => void) => {
      for (const name of readdirSync(descriptorPath(stream.fd)).sort()) {
        const path = join(stream.path, name);
        if (!filePattern.test(name) || !Number.isFinite(Date.parse(`${name.slice(0, 10)}T00:00:00.000Z`)) ||
          new Date(`${name.slice(0, 10)}T00:00:00.000Z`).toISOString().slice(0, 10) !== name.slice(0, 10)) {
          throw new Error(`Unexpected Store stream entry: ${path}`);
        }
        const fd = openFile(at(stream.fd, name), path, constants.O_RDONLY);
        let retained = false;
        try {
          // A writer killed between write and fsync leaves complete-looking but
          // volatile records. Make every admitted file durable before publishing it.
          fsyncSync(fd);
          const bytes = readFileSync(fd);
          let offset = 0;
          let line = 0;
          while (offset < bytes.length) {
            const newline = bytes.indexOf(10, offset);
            const end = newline === -1 ? bytes.length : newline;
            const where = `${path}:${++line}`;
            let value: unknown;
            try {
              value = JSON.parse(decoder.decode(bytes.subarray(offset, end)));
            } catch {
              reportSafely(report, `Skipping malformed JSON or UTF-8 line at ${where}`);
              offset = end + 1;
              continue;
            }
            receive(value, where);
            offset = end + 1;
          }
          if (bytes.length > 0 && bytes[bytes.length - 1] !== 10) {
            torn.push({ fd, path });
            retained = true;
          }
        } finally {
          if (!retained) closeSync(fd);
        }
      }
      // Entries created by an interrupted writer become durable with their data.
      fsyncSync(stream.fd);
    };
    try {
      readStream(this.main, (value, where) => this.messages.push(parseMessage(value, where)));
      // Backdated clocks/daily filenames cannot reorder permanent addresses.
      this.messages.sort((a, b) => a.i - b.i);
      for (let i = 0; i < this.messages.length; i++) {
        const actual = this.messages[i]!.i;
        if (actual !== i) {
          throw new Error(`Message ID gap or duplicate: expected ${i}, found ${actual}; refusing to reindex history`);
        }
      }
      readStream(this.tree, (value, where) => {
        const node = parseNode(value, where);
        const key = nodeKey(node.l, node.i);
        const previous = this.nodes.get(key);
        if (previous && (previous.text !== node.text || previous.size !== node.size)) {
          throw new Error(`Conflicting tree node ${key} at ${where}`);
        }
        if (!previous) this.nodes.set(key, node);
      });
      for (const node of this.nodes.values()) this.validateCoverage(node);
      for (const message of this.messages) {
        for (const image of message.metadata?.images ?? []) this.loadImage(image, true);
      }
      // Validate the complete history before making even append-only repairs.
      for (const { fd, path } of torn) {
        // Reopen the validated inode through its own descriptor link; no name lookup.
        const writer = openSync(descriptorPath(fd), constants.O_WRONLY | constants.O_APPEND);
        try { writeDurably(writer, "\n"); } finally { closeSync(writer); }
        reportSafely(report, `Recovered missing final newline at ${path}`);
      }
    } finally {
      for (const { fd } of torn) closeSync(fd);
    }
  }

  private appendRecord(stream: Stream, value: Message | TreeNode): void {
    this.assertWritable();
    const day = localDay(new Date());
    try {
      if (stream.writer?.day !== day) {
        if (stream.writer) {
          const old = stream.writer;
          stream.writer = undefined;
          closeSync(old.fd);
        }
        const name = `${day}.jsonl`;
        const fd = openFile(at(stream.fd, name), join(stream.path, name), constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT);
        stream.writer = { day, fd };
        fsyncSync(stream.fd);
      }
      writeDurably(stream.writer.fd, `${JSON.stringify(value)}\n`);
    } catch (error) {
      // A failed fsync may have committed data. Never reuse that ID in-process.
      this.failed = true;
      throw error;
    }
  }

  append(kind: Kind, text: string, date = new Date(), metadata?: MessageMetadata): Message {
    this.assertWritable();
    // Snapshot the supplied record date without invoking overridable Date methods.
    // It may be historical; the daily file is still the local day of this write.
    const time = date instanceof Date ? Date.prototype.getTime.call(date) : Number.NaN;
    if (!isKind(kind) || typeof text !== "string" || !Number.isFinite(time)) {
      throw new Error("Invalid message kind, text, or date");
    }
    const stored = metadata === undefined ? undefined : parseMetadata(metadata);
    checkCoupling(kind, stored, "new message");
    // Every referenced image must already be durable and intact before the record exists.
    for (const attachment of stored?.images ?? []) this.loadImage(attachment, true);
    const message: Message = Object.freeze({
      i: this.messages.length,
      kind,
      text,
      size: kind.length + 2 + Buffer.byteLength(text, "utf8"),
      date: new Date(time).toISOString(),
      ...(stored === undefined ? {} : { metadata: stored }),
    });
    this.appendRecord(this.main, message);
    this.messages.push(message);
    return message;
  }

  saveNode(value: TreeNode): void {
    this.assertWritable();
    const node = parseNode(value, "new tree node");
    this.validateCoverage(node);
    const key = nodeKey(node.l, node.i);
    const previous = this.nodes.get(key);
    if (previous) {
      if (previous.text !== node.text || previous.size !== node.size) {
        throw new Error(`Conflicting tree node ${key}`);
      }
      return;
    }
    this.appendRecord(this.tree, node);
    this.nodes.set(key, node);
  }

  /** Validates and durably stores one image by SHA-256 content address. */
  saveImage(data: string, mimeType: ImageMimeType): ImageDescriptor {
    this.assertWritable();
    const { descriptor, bytes } = validateImage(data, mimeType);
    try {
      this.images ??= openStream(this.rootFd, this.directory, "images");
      storeImageBytes(this.images.fd, this.images.path, descriptor, bytes);
    } catch (error) {
      // The final rename may have happened before a directory fsync failed.
      this.failed = true;
      throw error;
    }
    return descriptor;
  }

  /** Reads one stored image, reverifying bytes, digest, format, and dimensions. */
  readImage(descriptor: ImageDescriptor | ImageAttachment): { readonly descriptor: ImageDescriptor; readonly data: string } {
    const attachment = descriptor !== null && typeof descriptor === "object" && Object.hasOwn(descriptor, "order")
      ? parseMetadata({ images: [descriptor] }).images![0]!
      : undefined;
    const expected = parseImageDescriptor(attachment === undefined ? descriptor : {
      sha256: attachment.sha256, mimeType: attachment.mimeType, bytes: attachment.bytes,
      width: attachment.width, height: attachment.height,
    });
    return Object.freeze({ descriptor: expected, data: this.loadImage(expected).toString("base64") });
  }

  /** Verified images attached to one message, in their recorded order. */
  readMessageImages(id: number): readonly { readonly attachment: ImageAttachment; readonly data: string }[] {
    const message = this.messageAt(id);
    return Object.freeze((message.metadata?.images ?? []).map((attachment) => Object.freeze({
      attachment,
      data: this.loadImage(attachment).toString("base64"),
    })));
  }

  /** One bounded UTF-8 page of a message's original text, with its record envelope. */
  readMessagePage(id: number, offset = 0, maxBytes = DEFAULT_PAGE_BYTES): MessagePage {
    const message = this.messageAt(id);
    const page = readTextPage(message.text, offset, maxBytes);
    return Object.freeze({
      ...page,
      i: message.i,
      kind: message.kind,
      date: message.date,
      size: message.size,
      ...(message.metadata === undefined ? {} : { metadata: message.metadata }),
    });
  }

  private messageAt(id: number): Message {
    if (this.closed) throw new Error("Store is closing or closed");
    if (!isIndex(id) || id >= this.messages.length) throw new Error("Unknown message ID");
    return this.messages[id]!;
  }

  // Reopens and verifies the descriptor's content, format, dimensions, and digest.
  private loadImage(descriptor: ImageDescriptor, durable = false): Buffer {
    if (this.closed) throw new Error("Store is closing or closed");
    const images = this.images;
    if (images === undefined) throw new Error(`Image ${descriptor.sha256} is not stored`);
    const display = join(images.path, descriptor.sha256);
    const fd = openFile(at(images.fd, descriptor.sha256), display, constants.O_RDONLY);
    let bytes: Buffer;
    try {
      bytes = readImageBytes(fd, descriptor.bytes, display);
      if (durable) {
        fsyncSync(fd);
        fsyncSync(images.fd);
      }
    } finally {
      closeSync(fd);
    }
    const inspected = inspectImage(bytes);
    if (
      bytes.length !== descriptor.bytes ||
      createHash("sha256").update(bytes).digest("hex") !== descriptor.sha256 ||
      inspected.mimeType !== descriptor.mimeType ||
      inspected.width !== descriptor.width || inspected.height !== descriptor.height
    ) {
      throw new Error(`Image integrity check failed at ${display}`);
    }
    return bytes;
  }

  /** The last committed view; v1 appears only before a one-time migration save. */
  get viewSnapshot(): ViewSnapshot | LegacyViewSnapshot | undefined {
    return this.view;
  }

  /**
   * Durably commits a validated copy, then publishes it. Invalid input throws
   * without side effects; an I/O failure leaves the previous snapshot published
   * and fails the Store, since the replacement may or may not be durable.
   */
  saveView(value: ViewSnapshot): void {
    this.assertWritable();
    const view = parseViewV2(value, "new view snapshot", this.messages.length, this.nodes);
    try {
      replaceView(this.rootFd, this.directory, `${JSON.stringify(view)}\n`);
    } catch (error) {
      this.failed = true;
      throw error;
    }
    this.view = view;
  }

  close(): Promise<void> {
    // No await between marking closed and stopping writes. In-flight writes are
    // synchronous, so they finish/fsync before close can begin on the same thread.
    this.closed = true;
    return this.closing ??= release(this.rootFd, [this.main, this.tree, ...(this.images === undefined ? [] : [this.images])], this.lease);
  }
}
