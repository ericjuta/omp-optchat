import { readdirSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { parseMetadata, readTextPage } from "../../src/archive.ts";
import { Memory } from "../../src/memory.ts";
import type { Kind, Message, TreeNode } from "../../src/store.ts";
import { readSourcePage } from "../../src/source-page.ts";
import type { EvidenceMemory } from "../../src/system1/evidence.ts";
import type { RecallMemory } from "../../src/system1/recall.ts";
import { digest } from "./real-budget.ts";
import { secretFlags, type SecretFlag } from "./real-privacy.ts";
import { childPath, decode, INPUT_BYTES, integer, readBytes, record, text } from "./real-files.ts";

export interface FrozenFile { readonly path: string; readonly bytes: number; readonly sha256: string }
export interface SnapshotInput {
  readonly id: string;
  readonly originalStoreId: string;
  readonly expectedMessageCount: number;
  readonly root: string;
  readonly sha256: string;
  readonly files: readonly FrozenFile[];
}
export interface Citation {
  readonly snapshotId: string;
  readonly id: number;
  readonly start: number;
  readonly end: number;
  readonly totalBytes: number;
  readonly text: string;
  readonly sha256: string;
}
export interface FrozenSnapshot {
  readonly input: SnapshotInput;
  readonly messages: readonly Message[];
  readonly nodeCount: number;
  readonly privacyFlags: readonly (SecretFlag & { source: string })[];
  readonly viewSource: "saved-view" | "missing-view-built-leaves";
  readonly recall: RecallMemory;
  evidence(): EvidenceMemory;
  citation(id: number, start: number, end: number, expected?: string): Citation;
}
const kinds: readonly string[] = ["user", "talk", "tool", "echo", "note", "work"];
const fileName = /^(main|tree)\/\d{4}-\d{2}-\d{2}\.jsonl$/;
const key = (l: number, i: number) => `${l}:${i}`;

/** Same ID/size/metadata contracts as Store replay, without recovery, images or a writer lease. */
function message(value: unknown): Message {
  const row = record(value, "snapshot message");
  if (Object.keys(row).some((name) => !["i", "kind", "text", "size", "date", "metadata"].includes(name))) throw new Error("Unknown message field");
  const i = integer(row.i, "message ID");
  const kind = text(row.kind, "message kind");
  if (!kinds.includes(kind) || typeof row.text !== "string") throw new Error("Invalid message kind/text");
  const size = integer(row.size, "message size");
  if (size !== kind.length + 2 + Buffer.byteLength(row.text)) throw new Error("Invalid message byte size");
  const date = text(row.date, "message date");
  if (!Number.isFinite(Date.parse(date)) || new Date(date).toISOString() !== date) throw new Error("Invalid message date");
  const metadata = row.metadata === undefined ? undefined : parseMetadata(row.metadata);
  if ((kind === "work") !== (metadata?.work !== undefined) ||
    (metadata?.toolOutcome !== undefined && kind !== "echo") ||
    (metadata?.coordination !== undefined && kind !== "note") ||
    (metadata?.resultFor !== undefined && kind !== "work" && kind !== "echo")) throw new Error("Invalid message metadata coupling");
  return Object.freeze({ i, kind: kind as Kind, text: row.text, size, date, ...(metadata ? { metadata } : {}) });
}
function node(value: unknown): TreeNode {
  const row = record(value, "snapshot summary");
  if (Object.keys(row).some((name) => !["l", "i", "text", "size"].includes(name))) throw new Error("Unknown summary field");
  const l = integer(row.l, "summary level", 0, 52);
  const i = integer(row.i, "summary index");
  const summary = text(row.text, "summary text");
  const size = integer(row.size, "summary size");
  if (size !== Buffer.byteLength(summary)) throw new Error("Invalid summary byte size");
  return Object.freeze({ l, i, text: summary, size });
}
function tiling(value: unknown, limit: number, nodes: ReadonlyMap<string, TreeNode>, builtOnly: boolean) {
  const row = record(value, "snapshot view");
  const length = integer(row.length, "view length", 0, limit);
  if (!Array.isArray(row.parts) || typeof row.compacting !== "boolean") throw new Error("Invalid saved view");
  let end = 0;
  const parts = row.parts.map((part: unknown) => {
    if (!Array.isArray(part) || part.length !== 2) throw new Error("Invalid view part");
    const l = integer(part[0], "view level", 0, 52);
    const i = integer(part[1], "view index");
    const next = (i + 1) * 2 ** l;
    if (!Number.isSafeInteger(next) || i * 2 ** l !== end || next > length || ((l > 0 || builtOnly) && !nodes.has(key(l, i)))) throw new Error("Saved view has a gap, overlap or missing summary");
    end = next;
    return Object.freeze({ l, i });
  });
  if (end !== length) throw new Error("Saved view does not cover its cutoff");
  return { length, parts };
}
function inventory(root: string, prefix = ""): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error("Symlink in snapshot inventory");
    if (entry.isDirectory()) files.push(...inventory(join(root, entry.name), name));
    else if (entry.isFile()) files.push(name);
    else throw new Error("Non-regular snapshot entry");
  }
  return files.sort();
}
export function loadFrozenSnapshot(input: SnapshotInput): FrozenSnapshot {
  if (!lstatSync(input.root).isDirectory() || lstatSync(input.root).isSymbolicLink()) throw new Error("Invalid frozen snapshot root");
  const listed = input.files.map((file) => file.path).sort();
  if (new Set(listed).size !== listed.length || JSON.stringify(listed) !== JSON.stringify(inventory(input.root))) throw new Error("Snapshot inventory differs from frozen manifest");
  if (input.files.reduce((sum, file) => sum + file.bytes, 0) > INPUT_BYTES) throw new Error("Snapshot exceeds admission byte bound");
  const messages: Message[] = [];
  const nodes = new Map<string, TreeNode>();
  let saved: unknown;
  for (const file of input.files) {
    const bytes = readBytes(childPath(input.root, file.path), INPUT_BYTES, file.sha256);
    if (bytes.length !== file.bytes) throw new Error("Frozen file byte count differs");
    if (file.path === "view.json") { saved = JSON.parse(decode(bytes)); continue; }
    if (!fileName.test(file.path)) {
      if (file.path.startsWith("main/") || file.path.startsWith("tree/")) throw new Error("Unexpected frozen log entry");
      continue; // Bound/hash all sidecars, but never interpret them as source or credentials.
    }
    if (bytes.length && bytes.at(-1) !== 10) throw new Error("Incomplete snapshot JSONL tail; no repairs allowed");
    for (const line of decode(bytes).split("\n")) {
      if (!line) continue;
      const value: unknown = JSON.parse(line);
      if (file.path.startsWith("main/")) messages.push(message(value));
      else {
        const summary = node(value);
        const old = nodes.get(key(summary.l, summary.i));
        if (old && (old.text !== summary.text || old.size !== summary.size)) throw new Error("Conflicting frozen summaries");
        nodes.set(key(summary.l, summary.i), summary);
      }
    }
  }
  messages.sort((a, b) => a.i - b.i);
  if (!messages.length || !nodes.size) throw new Error("Real snapshot needs original messages and stored summaries");
  if (messages.length !== input.expectedMessageCount) throw new Error("Frozen message count differs from source manifest");
  for (const [i, item] of messages.entries()) {
    if (item.i !== i) throw new Error("Snapshot IDs contain a gap or duplicate; never reindex history");
    if (item.metadata?.resultFor !== undefined && (item.metadata.resultFor >= i || messages[item.metadata.resultFor]?.kind !== "tool")) throw new Error("Invalid frozen result association");
  }
  for (const summary of nodes.values()) {
    const end = (summary.i + 1) * 2 ** summary.l;
    if (!Number.isSafeInteger(end) || end > messages.length || (summary.l > 0 &&
      (!nodes.has(key(summary.l - 1, summary.i * 2)) || !nodes.has(key(summary.l - 1, summary.i * 2 + 1))))) throw new Error("Invalid frozen summary coverage/dependencies");
  }
  let view = { length: 0, parts: [] as { l: number; i: number }[] };
  if (saved !== undefined) {
    const row = record(saved, "saved view");
    if (row.version !== 1 && row.version !== 2) throw new Error("Invalid saved view version");
    view = tiling(row, messages.length, nodes, false);
    if (row.version === 2) tiling(row.compactor, view.length, nodes, true);
  }
  // Read-only equivalent of Memory constructor's durable-suffix handling. No missing summary is fabricated.
  for (let i = view.length; i < messages.length; i++) view.parts.push(Object.freeze({ l: 0, i }));
  Object.freeze(messages);
  // Borrow ONLY production read methods. Constructing Memory schedules a pump and commits view.json.
  // This receiver has the exact read dependencies (store, view, node method on prototype), no Store handle.
  const reader = Object.create(Memory.prototype) as Memory;
  Object.defineProperties(reader, { store: { value: Object.freeze({ messages, nodes }) }, view: { value: Object.freeze(view.parts) } });
  Object.freeze(reader);
  const recall: RecallMemory = {
    viewLines: () => reader.viewLines(true), lineAt: (id, n) => reader.lineAt(id, n),
    page: (id) => readTextPage(messages[id]!.text, 0, 8_000),
    rank: (question, limit) => reader.rankMessages(question, { limit }),
  };
  const privacyFlags: (SecretFlag & { source: string })[] = [];
  for (const item of messages) for (const flag of secretFlags(item.text)) privacyFlags.push({ ...flag, source: `message:${item.i}` });
  for (const item of nodes.values()) for (const flag of secretFlags(item.text)) privacyFlags.push({ ...flag, source: `summary:${item.l}:${item.i}` });
  return {
    input, messages, nodeCount: nodes.size, privacyFlags, viewSource: saved === undefined ? "missing-view-built-leaves" : "saved-view", recall,
    evidence: () => ({
      // Fresh identity for every trial: repetitions never warm an earlier index.
      sourceIdentity: {},
      page(id, offset, maxBytes, maxTraversalBytes) {
        const source = messages[id];
        if (!source) throw new Error("Evidence requested an ID outside the frozen snapshot");
        return { ...readSourcePage(source, offset, maxBytes, maxTraversalBytes), kind: source.kind, metadata: source.metadata };
      },
    }),
    citation(id, start, end, expected) {
      integer(id, "citation ID", 0, messages.length - 1);
      const bytes = Buffer.from(messages[id]!.text);
      integer(start, "citation start", 0, bytes.length);
      integer(end, "citation end", start, bytes.length);
      const quote = bytes.subarray(start, end);
      const exact = decode(quote);
      if (expected !== undefined && exact !== expected) throw new Error("Citation does not reopen exact original bytes");
      return { snapshotId: input.id, id, start, end, totalBytes: bytes.length, text: exact, sha256: digest(quote) };
    },
  };
}
