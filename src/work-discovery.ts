import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { WorkCompleteness, WorkSource } from "./archive.js";
import type { Message } from "./store.js";

export const WORK_DISCOVERY_MARK = "[optchat work]";
export const WORK_DISCOVERY_QUESTION_CHARS = 1_000;
export const WORK_DISCOVERY_MAX_RESULTS = 20;
export const WORK_DISCOVERY_SCAN_MESSAGES = 2_048;
export const WORK_DISCOVERY_SCAN_BYTES = 262_144;
export const WORK_DISCOVERY_PREFIX_BYTES = 8_192;
export const WORK_DISCOVERY_PASSAGE_BYTES = 1_024;
/** Includes the rendered JSON, mark and tool-envelope escaping, not just passage text. */
export const WORK_DISCOVERY_RESULT_BYTES = 32_768;
const RESULT_RESERVE_BYTES = 4_096;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export interface WorkDiscoveryQuery {
  /** Literal word overlap, not semantic inference. Omit both filters to list captures. */
  readonly question?: string;
  /** Exact recorded work id, agent id or name, as accepted by work(name). */
  readonly name?: string;
  readonly limit?: number;
  /** Exclusive report-message cursor. Does not widen the snapshot's upper bound. */
  readonly before?: number;
}

export interface WorkDiscoveryScope {
  /** Exclusive message cutoff captured before starting the query. */
  readonly upperBound: number;
  readonly signal?: AbortSignal;
}

/** Exact stored text with UTF-8 byte citations; zoom(messageId, 1, offset) reads onward. */
export interface WorkPassage {
  readonly messageId: number;
  readonly offset: number;
  readonly end: number;
  readonly next: number | null;
  readonly text: string;
}

export interface DiscoveredWork {
  /** One capture, not an inferred run. Reused names and even repeated ids never merge records. */
  readonly report: WorkPassage;
  readonly capturedAt: string;
  readonly source: WorkSource;
  /** Capture completeness, independent of the bounded passage returned here. */
  readonly completeness: WorkCompleteness;
  readonly identities: {
    /** Copied literally from WorkMetadata; its namespace depends on the source. */
    readonly workId: string | null;
    readonly agentId: string | null;
    readonly name: string | null;
    /** The current stored schema does not retain these host identities. Never parse them from text. */
    readonly callId: null;
    readonly runId: null;
    readonly reportId: null;
  };
  /**
   * Only an explicit resultFor association supplies this call. A wait call is a delivery,
   * not the original task. A task batch stays a whole invocation, never guessed per member.
   */
  readonly call: (WorkPassage & {
    readonly tool: string | null;
    readonly relation: "task-or-command" | "result-delivery" | "other";
  }) | null;
  /** Source citation of the original invocation, when the associated call itself launches work. */
  readonly originalTaskOrCommand: number | null;
  readonly matchedTerms: readonly string[];
}

export interface WorkDiscoveryResult {
  readonly captures: readonly DiscoveredWork[];
  readonly scope: {
    readonly upperBound: number;
    readonly before: number;
    /** Metadata reads, including associated calls, with duplicate reads counted. */
    readonly inspectedMessages: number;
    readonly scannedTextBytes: number;
    /** Number of inspected texts longer than their bounded search prefix. */
    readonly truncatedPrefixes: number;
    readonly stopped: "end" | "limit" | "scan-messages" | "scan-bytes" | "returned-bytes" | "aborted";
  };
  /** Resume with before=next and the same snapshot cutoff. Null means no older records remain. */
  readonly next: number | null;
  readonly notice: string;
}

const NOTICE = "Stored captures only; question matching uses literal word overlap in bounded text prefixes, newest first. " +
  "Null identity or original invocation means unknown, not absent. No live job, external artifact or child-transcript availability is checked. " +
  "Use zoom(report.messageId, 1, report.offset) for this exact capture; work(name) selects the newest matching capture and may select another run.";

function nonnegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a nonnegative safe integer`);
}

function termsOf(query: WorkDiscoveryQuery): string[] {
  if (query.question === undefined) return [];
  if (typeof query.question !== "string" || query.question.length === 0 || query.question.length > WORK_DISCOVERY_QUESTION_CHARS) {
    throw new Error(`question must contain 1 to ${WORK_DISCOVERY_QUESTION_CHARS} characters`);
  }
  // The same word splitting and minimum length as Memory.rankMessages; no model or summary is consulted.
  const terms = [...new Set(query.question.toLowerCase().split(/[^\p{L}\p{N}]+/u))].filter((term) => [...term].length >= 3);
  if (terms.length === 0) throw new Error("question must contain a word of at least three characters; use name for short identifiers");
  return terms;
}

interface Prefix {
  readonly text: string;
  readonly bytes: number;
  readonly complete: boolean;
}

/**
 * readTextPage first indexes the entire input. Here even indexing a large report would exceed
 * the scan budget: encodeInto stops at the fixed buffer without encoding or copying its suffix.
 */
function prefixOf(text: string, buffer: Uint8Array): Prefix {
  const { read, written } = encoder.encodeInto(text, buffer);
  return { text: decoder.decode(buffer.subarray(0, written)), bytes: written, complete: read === text.length };
}

function passageOf(message: Message, prefix: Prefix, terms: readonly string[], buffer: Uint8Array): WorkPassage {
  // Query words contain only letters and numbers, so the regexp needs no escaping. A regexp's
  // index is in the original text, unlike offsets into a Unicode-lowercased copy.
  const match = terms.length === 0 ? null : new RegExp(terms.join("|"), "iu").exec(prefix.text);
  let start = Math.max(0, (match?.index ?? 0) - 128);
  const unit = prefix.text.charCodeAt(start);
  if (start > 0 && unit >= 0xdc00 && unit <= 0xdfff) start--;
  const offset = Buffer.byteLength(prefix.text.slice(0, start), "utf8");
  const excerpt = prefixOf(prefix.text.slice(start), buffer);
  const end = offset + excerpt.bytes;
  return {
    messageId: message.i, offset, end,
    next: prefix.complete && end === prefix.bytes ? null : end,
    text: excerpt.text,
  };
}

function toolOf(text: string): string | null {
  // Only inspect the serializer's tool-name prefix, never parse arguments as identity.
  return /^[a-zA-Z_][a-zA-Z0-9_.-]* (?=\{)/u.exec(text)?.[0].trim() ?? null;
}

/**
 * Read-only discovery over Store.messages, whose metadata has already passed archive admission.
 * Only work-kind records with WorkMetadata qualify; report bodies/URIs never establish identity.
 * resultFor is the sole call association. The source array must be Store's contiguous id-indexed
 * log (or an equally admitted snapshot), not imported/unvalidated objects or model output.
 *
 * Scans at most 2,048 records/call lookups and 256 KiB of text per query, using at most the first
 * 8 KiB of each text. Results stop at 20 captures or the serialized response budget. A continuation
 * is conservative: it promises older records to inspect, never older matching runs. No IO, model,
 * host report patch, artifact hydration, body-derived identifiers or writer is used.
 */
export function discoverWork(
  messages: readonly Message[],
  query: WorkDiscoveryQuery,
  scope: WorkDiscoveryScope,
): WorkDiscoveryResult {
  nonnegativeInteger(scope.upperBound, "upperBound");
  if (scope.upperBound > messages.length) throw new Error("upperBound exceeds the admitted message snapshot");
  const before = query.before ?? scope.upperBound;
  nonnegativeInteger(before, "before");
  const cutoff = Math.min(before, scope.upperBound);
  const limit = query.limit ?? 8;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > WORK_DISCOVERY_MAX_RESULTS) {
    throw new Error(`limit must be an integer from 1 to ${WORK_DISCOVERY_MAX_RESULTS}`);
  }
  if (query.name !== undefined && (typeof query.name !== "string" || query.name.length === 0 ||
    query.name.length > 256 || Buffer.byteLength(query.name, "utf8") > 256)) {
    throw new Error("name must contain 1 to 256 UTF-8 bytes");
  }
  const terms = termsOf(query);
  const captures: DiscoveredWork[] = [];
  const scanBuffer = new Uint8Array(WORK_DISCOVERY_PREFIX_BYTES);
  const passageBuffer = new Uint8Array(WORK_DISCOVERY_PASSAGE_BYTES);
  let inspectedMessages = 0;
  let scannedTextBytes = 0;
  let truncatedPrefixes = 0;
  let returnedBytes = 0;
  let cursor = cutoff;
  let stopped: WorkDiscoveryResult["scope"]["stopped"] = "end";
  const readPrefix = (message: Message): Prefix => {
    const prefix = prefixOf(message.text, scanBuffer);
    scannedTextBytes += prefix.bytes;
    if (!prefix.complete) truncatedPrefixes++;
    return prefix;
  };
  while (cursor > 0) {
    if (scope.signal?.aborted) { stopped = "aborted"; break; }
    if (captures.length === limit) { stopped = "limit"; break; }
    // Reserve the possible associated call lookup, and both text prefixes, before consuming a
    // candidate. This makes the cursor resumable without skipping a partially inspected capture.
    if (inspectedMessages + 2 > WORK_DISCOVERY_SCAN_MESSAGES) { stopped = "scan-messages"; break; }
    if (scannedTextBytes + 2 * WORK_DISCOVERY_PREFIX_BYTES > WORK_DISCOVERY_SCAN_BYTES) { stopped = "scan-bytes"; break; }
    const message = messages[cursor - 1]!;
    inspectedMessages++;
    cursor--;
    const work = message.kind === "work" ? message.metadata?.work : undefined;
    if (!work) continue;
    if (query.name !== undefined && work.id !== query.name && work.name !== query.name && work.agentId !== query.name) continue;
    const reportPrefix = readPrefix(message);
    const target = message.metadata?.resultFor;
    let call: Message | undefined;
    if (target !== undefined && Number.isSafeInteger(target) && target >= 0 && target < message.i && target < cutoff) {
      inspectedMessages++;
      const candidate = messages[target];
      if (candidate?.i === target && candidate.kind === "tool") call = candidate;
    }
    const callPrefix = call === undefined ? undefined : readPrefix(call);
    const searchable = `${work.id ?? ""}\n${work.name ?? ""}\n${work.agentId ?? ""}\n${reportPrefix.text}\n${callPrefix?.text ?? ""}`.toLowerCase();
    const matchedTerms = terms.filter((term) => searchable.includes(term));
    if (terms.length > 0 && matchedTerms.length === 0) continue;
    const tool = callPrefix === undefined ? null : toolOf(callPrefix.text);
    const original = tool === "task" || tool === "bash" || tool === "launch";
    const hit: DiscoveredWork = {
      report: passageOf(message, reportPrefix, matchedTerms, passageBuffer),
      capturedAt: message.date,
      source: work.source,
      completeness: work.completeness,
      identities: {
        workId: work.id ?? null, agentId: work.agentId ?? null, name: work.name ?? null,
        callId: null, runId: null, reportId: null,
      },
      call: call === undefined || callPrefix === undefined ? null : {
        ...passageOf(call, callPrefix, matchedTerms, passageBuffer), tool,
        relation: original ? "task-or-command" : tool === "wait" ? "result-delivery" : "other",
      },
      originalTaskOrCommand: original && call !== undefined ? call.i : null,
      matchedTerms,
    };
    // The rendered JSON is itself a text field in the tool result. Account for that second
    // escaping layer too; control characters and backslashes must not evade the byte bound.
    const bytes = Buffer.byteLength(JSON.stringify(JSON.stringify(hit)), "utf8") + 1;
    if (returnedBytes + bytes > WORK_DISCOVERY_RESULT_BYTES - RESULT_RESERVE_BYTES) {
      cursor++; // This matching capture was not returned: the next page must reconsider it.
      stopped = "returned-bytes";
      break;
    }
    returnedBytes += bytes;
    captures.push(hit);
  }
  return {
    captures,
    scope: { upperBound: scope.upperBound, before: cutoff, inspectedMessages, scannedTextBytes, truncatedPrefixes, stopped },
    next: cursor === 0 ? null : cursor,
    notice: NOTICE,
  };
}

/** A stable text surface; the JSON carries exact citations and the conservative continuation. */
export function renderWorkDiscovery(result: WorkDiscoveryResult): string {
  return `${WORK_DISCOVERY_MARK}\n${JSON.stringify(result)}`;
}

/**
 * Registration/adapter contract (parent wiring deliberately lives outside this module):
 *
 * - Register once, with the usual getAllTools collision check, and add chat_work to the memory
 *   private-tool/result-mark exclusions so its own discovery output cannot become new evidence.
 * - Parent run(query, current, signal): prove the active Memory/Store, freeze messages.length as
 *   upperBound, then discoverWork(store.messages, query, { upperBound, signal }).
 * - Child: publish only a query callback on ChildView. Close over childSnapshot's fixed upperBound;
 *   call its live() guard before discovery, AND require the existing attached(current) admission
 *   before invoking it. Extend guarded(view, token) to revoke this callback too. A before argument
 *   must never widen upperBound. Do not hand the child a Store or its unrestricted messages array.
 * - Until all child guards/cutoff plumbing exist, register this only for parents. Never silently
 *   fall back to parent live memory when a child's callback is absent. Update tool lists/guidance
 *   only where registration actually succeeds. Existing work and zoom remain the reading API.
 *
 * run is synchronous so admission, snapshot capture and bounded discovery cannot race a session
 * switch across an await. No host-patch feature detection or availability claims are involved.
 */
export function registerWorkDiscoveryTool(
  pi: ExtensionAPI,
  run: (query: WorkDiscoveryQuery, current: ExtensionContext | undefined, signal: AbortSignal | undefined) => WorkDiscoveryResult,
): void {
  const z = pi.zod;
  const params = z.object({
    question: z.string().min(1).max(WORK_DISCOVERY_QUESTION_CHARS).optional().describe("Question words to match literally against recorded identities, report and associated call prefixes"),
    name: z.string().min(1).max(256).optional().describe("Exact recorded work id, agent id or name; combined with question when both are supplied"),
    limit: z.number().int().min(1).max(WORK_DISCOVERY_MAX_RESULTS).optional().describe("Captures to return, newest first (default 8)"),
    before: z.number().int().min(0).optional().describe("Exclusive report message cursor; pass next for older captures within the same snapshot"),
  });
  pi.registerTool<typeof params>({
    name: "chat_work",
    label: "OptChat work discovery",
    description: "Find stored work captures by question words or exact name; omit both to list captures. Read-only, no model: bounded prefix scans return exact report/call citations, recorded identities, capture completeness/time and snapshot cutoff. Reused names stay separate; missing identities stay unknown. Read the selected capture with zoom(messageId, 1, offset); work(name) reads the newest match, not necessarily this capture. next is a cursor for older records, not a promise of matches.",
    parameters: params,
    approval: "read",
    loadMode: "essential",
    execute: async (_id, query, signal, _update, current) => {
      const result = run(query, current, signal);
      return {
        content: [{ type: "text", text: renderWorkDiscovery(result) }],
        // Do not duplicate the passage payload in details. Together these fit the response budget.
        details: { next: result.next, upperBound: result.scope.upperBound, captures: result.captures.map((hit) => hit.report.messageId) },
      };
    },
  });
}
