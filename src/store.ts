import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { basename, dirname, join, resolve } from "node:path";

export type Kind = "user" | "talk" | "tool" | "echo" | "note";
export interface Message {
  i: number;
  kind: Kind;
  text: string;
  size: number;
  date: string;
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
 */
export interface ViewSnapshot {
  readonly version: 1;
  readonly length: number;
  readonly parts: ReadonlyArray<readonly [number, number]>;
  readonly compacting: boolean;
}

type Report = (message: string) => void;
type Stream = {
  /** User-facing location for diagnostics only; I/O goes through `fd`. */
  path: string;
  fd: number;
  writer?: { day: string; fd: number };
};
type Lease = { server: Server; failure?: Error };
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const filePattern = /^\d{4}-\d{2}-\d{2}\.jsonl$/;
const messageFields = ["i", "kind", "text", "size", "date"];
const nodeFields = ["l", "i", "text", "size"];
const viewFields = ["version", "length", "parts", "compacting"];
const viewName = "view.json";

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function record(value: unknown, fields: string[], where: string): Record<string, unknown> {
  if (
    typeof value !== "object" || value === null || Array.isArray(value) ||
    Object.keys(value).length !== fields.length ||
    !fields.every((field) => Object.hasOwn(value, field))
  ) {
    throw new Error(`Invalid record schema at ${where}`);
  }
  return value as Record<string, unknown>;
}

function isIndex(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isKind(value: unknown): value is Kind {
  return value === "user" || value === "talk" || value === "tool" ||
    value === "echo" || value === "note";
}

function parseMessage(value: unknown, where: string): Message {
  const row = record(value, messageFields, where);
  if (
    !isIndex(row.i) || !isKind(row.kind) || typeof row.text !== "string" ||
    typeof row.size !== "number" || row.size !== row.kind.length + 2 + Buffer.byteLength(row.text, "utf8") ||
    typeof row.date !== "string" || !Number.isFinite(Date.parse(row.date)) ||
    new Date(row.date).toISOString() !== row.date
  ) {
    throw new Error(`Invalid message schema, size, date, or index at ${where}`);
  }
  return Object.freeze({
    i: row.i, kind: row.kind, text: row.text,
    size: row.size, date: row.date,
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
function parseView(
  value: unknown,
  where: string,
  messages: number,
  nodes: ReadonlyMap<string, TreeNode>,
): ViewSnapshot {
  const { version, length, parts, compacting } = record(value, viewFields, where);
  if (
    version !== 1 || !isIndex(length) || length > messages ||
    typeof compacting !== "boolean" || !Array.isArray(parts)
  ) {
    throw new Error(`Invalid view snapshot schema or length at ${where}`);
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
    if (l > 0 && !nodes.has(nodeKey(l, i))) {
      throw new Error(`View part ${nodeKey(l, i)} names an unbuilt summary at ${where}`);
    }
    copied.push(Object.freeze([l, i] as const));
    end = next;
  }
  if (end !== length) {
    throw new Error(`View parts do not cover messages [0, ${length}) at ${where}`);
  }
  return Object.freeze({ version: 1, length, parts: Object.freeze(copied), compacting });
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

function openStream(rootFd: number, directory: string, name: "main" | "tree"): Stream {
  const path = join(directory, name);
  makeDirectory(rootFd, name);
  return { path, fd: openDirectory(at(rootFd, name), path) };
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
        ? new Error("Store is already open by another writer", { cause: error })
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
): ViewSnapshot | undefined {
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
  return parseView(value, path, messages, nodes);
}

// Commits the view only after its complete private file is durable. Every name
// resolves against the leased root inode, even if the public root path moves.
// Only the exclusively created temporary is ever unlinked; a crash may leave an
// inert `.view-<uuid>.tmp` (0600, no text) that is never read or removed.
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

function reportSafely(report: Report | undefined, message: string): void {
  try { (report ?? console.warn)(message); } catch { /* Diagnostics must not change replay semantics. */ }
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
  private view?: ViewSnapshot;
  private closing?: Promise<void>;
  private closed = false;
  private failed = false;

  private constructor(
    /** Canonical root path when opened, for reporting; never re-resolved for I/O. */
    readonly directory: string,
    private readonly rootFd: number,
    private readonly main: Stream,
    private readonly tree: Stream,
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
      const store = new Store(canonical, rootFd, main, tree, lease);
      store.replay(report);
      store.view = loadView(rootFd, canonical, store.messages.length, store.nodes);
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

  append(kind: Kind, text: string, date = new Date()): Message {
    this.assertWritable();
    // Snapshot the supplied record date without invoking overridable Date methods.
    // It may be historical; the daily file is still the local day of this write.
    const time = date instanceof Date ? Date.prototype.getTime.call(date) : Number.NaN;
    if (!isKind(kind) || typeof text !== "string" || !Number.isFinite(time)) {
      throw new Error("Invalid message kind, text, or date");
    }
    const message: Message = Object.freeze({
      i: this.messages.length,
      kind,
      text,
      size: kind.length + 2 + Buffer.byteLength(text, "utf8"),
      date: new Date(time).toISOString(),
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

  /** The last committed view, deeply frozen; undefined until one is saved. */
  get viewSnapshot(): ViewSnapshot | undefined {
    return this.view;
  }

  /**
   * Durably commits a validated copy, then publishes it. Invalid input throws
   * without side effects; an I/O failure leaves the previous snapshot published
   * and fails the Store, since the replacement may or may not be durable.
   */
  saveView(value: ViewSnapshot): void {
    this.assertWritable();
    const view = parseView(value, "new view snapshot", this.messages.length, this.nodes);
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
    return this.closing ??= release(this.rootFd, [this.main, this.tree], this.lease);
  }
}
