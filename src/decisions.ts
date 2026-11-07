import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { EvidencePage, EvidencePassage } from "./system1/evidence.js";

/**
 * Query-time decision history; no ledger writes, model calls, or instruction injection.
 *
 * Integration: gatherDecisions({ page: (id, offset, bytes) => store.readMessagePage(id, offset, bytes) },
 * question, { upperBound: snapshotMessageCount, signal }), then renderDecisions(question, result, mode).
 * registerDecisionsTool follows registerEvidenceTool's callback convention: the caller must admit the
 * current session, await readiness and capture a fixed upperBound BEFORE reading. Children must use
 * their frozen reader/bound and check revocation on EVERY call, not the parent's live store.
 *
 * This is deliberately not a natural-language truth oracle. Only whole, single-statement forms are
 * actionable: `Decision <topic>: <value>`, `Accept <topic>: <value>`, `Change <topic> to <value>`,
 * `Revert <topic> to <value>`, `Withdraw <topic>`, and `Use <value> for <topic>` (optional final period).
 * Topics are literal, case-insensitive names. Natural `Use`/`Change`/`Revert` forms require a
 * single-atom topic; `Change <topic>: <value>`/`Revert <topic>: <value>` also support named topics.
 * Values are a plain atom, a descriptor plus a number (`port 5432`), or a JSON string literal.
 * `Proposal <topic>: <value>` and `Reported complete <topic>: <value>` are never acceptance.
 * `it` in a correction resolves only when exactly one topic has been seen in a complete prefix.
 * No fuzzy entity matching, pronoun guessing, negation stripping, or sentence extraction is done.
 * Ambiguous human prose after a decision prevents a definite current state until an explicit
 * correction/withdrawal resolves it. Single questions and explicit past-tense mentions do not.
 *
 * Smoke: user `Use port 5432 for staging.`, `Change staging to 6543.`, `Revert it to 5432.`,
 * `Yesterday's failed attempt used 6543.` => current staging=5432, two superseded decisions,
 * historical mention retained. A talk/work message saying tests passed is NOT observed completion.
 * Run tests/decisions.test.ts and the repository gates in the parent after integration. Add the result
 * mark to memory-result exclusions and document the new tool/opt-out there; no host wiring is done here.
 */
export const DECISIONS_MARK = "[optchat decisions]";
export const DECISIONS_LIMITS = Object.freeze({ messages: 256, scanBytes: 262_144, messageBytes: 4_096, events: 64, evidenceBytes: 32_768, timeoutMs: 1_000 });
export const DECISIONS_QUESTION_CHARS = 1_000;

export type DecisionStatus = "proposed" | "accepted" | "superseded" | "reported-complete" | "observed-complete" | "withdrawn" | "unresolved";
export type DecisionMode = "timeline" | "project-state";
type Action = "propose" | "accept" | "replace" | "withdraw" | "report" | "observe" | "mention";

/**
 * Supplied ONLY by a trusted host adapter from a captured tool outcome, never an extractor,
 * judge, prose parser, or model-produced relationship. `toolOutcome: success` means the host reports
 * this exact invocation returned without a tool error, NOT process/test/project success. The topic
 * must name the invocation, not a model-inferred accomplishment. Offsets cite its exact result bytes.
 * resultFor alone establishes linkage, NOT outcome; imported outcomes are not host observations.
 */
export interface CompletedDecisionResult {
  readonly topic: string;
  readonly start: number;
  readonly end: number;
}

export interface DecisionReader {
  /** Same bounded, UTF-8-aligned contract as Store.readMessagePage. Must enforce snapshot/revocation. */
  page(id: number, offset: number, maxBytes: number): EvidencePage;
  /** Called only on a full echo linked by trusted resultFor metadata to an earlier captured tool call. */
  completedResult?(id: number): CompletedDecisionResult | undefined;
}

export interface DecisionLimits {
  /** Exclusive message id; captured once per query. No source at or beyond it is read. */
  readonly upperBound: number;
  readonly maxMessages?: number;
  readonly maxScanBytes?: number;
  readonly maxMessageBytes?: number;
  readonly maxEvents?: number;
  readonly maxEvidenceBytes?: number;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly clock?: () => number;
}

export interface DecisionEvent {
  readonly id: number;
  readonly action: Action;
  readonly status: DecisionStatus;
  readonly topic: string | null;
  readonly value: string | null;
  /** Authorship is source-derived, never inferred from a name or claim in the text. */
  readonly authority: "human" | "non-human";
  readonly evidence: EvidencePassage;
  readonly reason: string;
  readonly supersedes: readonly number[];
  readonly supersededBy?: number;
  /** An observed result is linked to this exact captured tool-call message. */
  readonly resultFor?: number;
}

export interface DecisionState {
  readonly topic: string;
  readonly status: "accepted" | "withdrawn" | "unresolved";
  /** Present only for a single, unambiguous accepted value within a fully scanned snapshot. */
  readonly value?: string;
  readonly evidence: readonly number[];
  readonly reason: string;
}

export interface DecisionResult {
  readonly timeline: readonly DecisionEvent[];
  readonly project: {
    readonly decisions: readonly DecisionState[];
    readonly proposals: readonly number[];
    readonly reported: readonly number[];
    readonly observed: readonly number[];
    readonly unresolved: readonly number[];
  };
  readonly scan: {
    readonly upperBound: number;
    readonly from: number;
    readonly through: number;
    readonly messages: number;
    readonly bytes: number;
    readonly complete: boolean;
    readonly gaps: readonly { id: number; reason: string }[];
    readonly stopped: string | null;
  };
}

interface Parsed {
  action: Exclude<Action, "observe" | "mention">;
  topic: string;
  value: string | null;
}
interface Topic {
  name: string;
  active: number[];
  withdrawal?: number;
  blockers: number[];
}

function integer(value: number, name: string, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new RangeError(`${name} must be an integer between ${min} and ${max}`);
  return value;
}
const topicName = (text: string): string => text.toLowerCase().replace(/\s+/g, " ").trim();
// Conservative grammar exclusions, not domain-specific facts. Literal JSON values bypass this
// ambiguity check because their content is explicitly data, rather than a natural-language clause.
const CLAUSE_OR_MODAL = /\b(?:not|never|maybe|perhaps|possibly|if|unless|either|or|and|but|pending|when|until|assuming|hypothetically|previously|formerly|tomorrow|yesterday)\b/i;
const isTopic = (text: string): boolean => text.length > 0 && text.length <= 160 && /^[\p{L}\p{N}_][\p{L}\p{N}_ /.:\-]*$/u.test(text) && !/[.!?]\s/.test(text) && !CLAUSE_OR_MODAL.test(text);

function valueOf(text: string): string | undefined {
  // A delimited JSON string is literal data, not a clause whose semantics we pretend to understand.
  if (text.startsWith('"')) {
    try {
      const value: unknown = JSON.parse(text);
      return typeof value === "string" && value.length > 0 && value.length <= 256 ? value : undefined;
    } catch { return undefined; }
  }
  // Unquoted modal/conditional/negative phrases are not literal choices.
  if (CLAUSE_OR_MODAL.test(text)) return undefined;
  return /^[\p{L}\p{N}_/.:\-]+(?: [+-]?\d+(?:\.\d+)?)?$/u.test(text) && text.length <= 256 ? text : undefined;
}

function parse(text: string): Parsed | undefined {
  if (/[\r\n]/.test(text)) return undefined;
  const statement = text.endsWith(".") ? text.slice(0, -1) : text;
  const tagged = /^(Decision|Accept|Proposal|Reported complete|Change|Revert) (.+?): (.+)$/i.exec(statement);
  if (tagged) {
    const topic = tagged[2]!;
    const value = valueOf(tagged[3]!);
    if (!isTopic(topic) || value === undefined) return undefined;
    const tag = tagged[1]!.toLowerCase();
    const action = tag === "proposal" ? "propose" : tag === "reported complete" ? "report" : tag === "change" || tag === "revert" ? "replace" : "accept";
    return { action, topic, value };
  }
  // These are claims, even in a tool's output. Only completedResult can establish observation.
  const report = /^([\p{L}\p{N}_/.:\-]+) (?:passed|completed|finished|succeeded|is complete|is done)$/iu.exec(statement);
  if (report && isTopic(report[1]!)) return { action: "report", topic: report[1]!, value: statement };
  const correction = /^(Change|Revert) (.+?) to (.+)$/i.exec(statement);
  if (correction) {
    const value = valueOf(correction[3]!);
    if (!isTopic(correction[2]!) || /\s/.test(correction[2]!) || value === undefined) return undefined;
    return { action: "replace", topic: correction[2]!, value };
  }
  const use = /^Use (.+?) for (.+)$/i.exec(statement);
  if (use) {
    const value = valueOf(use[1]!);
    if (!isTopic(use[2]!) || /\s/.test(use[2]!) || value === undefined) return undefined;
    return { action: "accept", topic: use[2]!, value };
  }
  const withdrawal = /^Withdraw (.+)$/i.exec(statement);
  return withdrawal && isTopic(withdrawal[1]!) ? { action: "withdraw", topic: withdrawal[1]!, value: null } : undefined;
}

function pastMention(text: string): boolean {
  const past = /^(?:Yesterday(?:'s)?|Earlier|Previously|Historically) (?:[\p{L}\p{N}_-]+ ){0,6}(?:used|was|had) (.+?)\.?$/iu.exec(text);
  return past !== null && valueOf(past[1]!) !== undefined;
}

function citation(id: number, page: EvidencePage, start = 0, end = Buffer.byteLength(page.text)): EvidencePassage {
  const bytes = Buffer.from(page.text);
  return { id, kind: page.kind, start, end, totalBytes: page.totalBytes, text: bytes.subarray(start, end).toString("utf8"), complete: start === 0 && end === page.totalBytes && page.next === null };
}

function validSpan(bytes: Buffer, start: number, end: number): boolean {
  const boundary = (offset: number): boolean => offset === bytes.length || (bytes[offset]! & 0xc0) !== 0x80;
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && end > start && end <= bytes.length && boundary(start) && boundary(end);
}

/** Bounded chronological derivation over original sources, not rank order or compressed summaries. */
export async function gatherDecisions(reader: DecisionReader, question: string, limits: DecisionLimits): Promise<DecisionResult> {
  if (question.trim().length === 0 || question.length > DECISIONS_QUESTION_CHARS) throw new RangeError("question must contain 1–1000 characters");
  const upperBound = integer(limits.upperBound, "upperBound", 0);
  const maxMessages = integer(limits.maxMessages ?? DECISIONS_LIMITS.messages, "maxMessages", 1, DECISIONS_LIMITS.messages);
  const maxBytes = integer(limits.maxScanBytes ?? DECISIONS_LIMITS.scanBytes, "maxScanBytes", 4, DECISIONS_LIMITS.scanBytes);
  const pageBytes = integer(limits.maxMessageBytes ?? DECISIONS_LIMITS.messageBytes, "maxMessageBytes", 4, DECISIONS_LIMITS.messageBytes);
  const maxEvents = integer(limits.maxEvents ?? DECISIONS_LIMITS.events, "maxEvents", 1, DECISIONS_LIMITS.events);
  const maxEvidence = integer(limits.maxEvidenceBytes ?? DECISIONS_LIMITS.evidenceBytes, "maxEvidenceBytes", 1, DECISIONS_LIMITS.evidenceBytes);
  const timeout = integer(limits.timeoutMs ?? DECISIONS_LIMITS.timeoutMs, "timeoutMs", 0, DECISIONS_LIMITS.timeoutMs);
  const clock = limits.clock ?? (() => performance.now());
  const deadline = clock() + timeout;
  const signal = limits.signal;
  signal?.throwIfAborted();
  const terms = new Set(question.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []);
  const matches = (text: string): boolean => (text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []).some((word) => terms.has(word));
  const from = Math.max(0, upperBound - maxMessages);
  const events: DecisionEvent[] = [];
  const topics = new Map<string, Topic>();
  const toolCalls = new Set<number>();
  const gaps: { id: number; reason: string }[] = [];
  let bytesRead = 0;
  let evidenceBytes = 0;
  let through = from;
  let stopped: string | null = null;

  for (let id = from; id < upperBound; id++) {
    signal?.throwIfAborted();
    if (id !== from && (id - from) % 16 === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      signal?.throwIfAborted();
    }
    if (clock() >= deadline) { stopped = "time bound"; break; }
    const budget = Math.min(pageBytes, maxBytes - bytesRead);
    if (budget < 4) { stopped = "scan byte bound"; break; }
    // Reader errors propagate: in particular, never hide a revoked child view as an empty history.
    const page = reader.page(id, 0, budget);
    signal?.throwIfAborted();
    const size = Buffer.byteLength(page.text);
    if (!Number.isSafeInteger(page.totalBytes) || page.totalBytes < size || size > budget ||
        (page.next === null ? page.totalBytes !== size : page.next !== size || page.next >= page.totalBytes || size === 0)) {
      throw new Error("decision source violated the bounded page contract");
    }
    bytesRead += size;
    through = id + 1;
    if (clock() >= deadline) { stopped = "time bound"; break; }
    const partial = page.next !== null || page.metadata?.work?.completeness === "pointer-only" || page.text.startsWith("[incomplete:");
    if (partial) gaps.push({ id, reason: "source is partial or exceeds the message byte bound" });
    if (page.kind === "tool" && !partial) toolCalls.add(id);
    // Our own output is not new evidence; a captured tool call is not a result or an instruction.
    if (page.kind === "tool" || (page.kind === "echo" && page.text.startsWith(DECISIONS_MARK))) continue;
    const text = page.text.trim();
    if (text.length === 0) continue;
    const human = page.kind === "user" && page.metadata?.coordination === undefined && page.metadata?.work === undefined && page.metadata?.resultFor === undefined;
    const parsed = partial ? undefined : parse(text);
    let evidence = citation(id, page);
    let action: Action = parsed?.action ?? "mention";
    let topic = parsed?.topic ?? null;
    let value = parsed?.value ?? null;
    let status: DecisionStatus = "unresolved";
    let reason = partial ? "partial source cannot settle state" : "semantic relationship is unresolved; inspect the exact source";
    let resultFor: number | undefined;
    const linked = page.metadata?.resultFor;
    if (!partial && page.kind === "echo" && linked !== undefined && toolCalls.has(linked)) {
      const completion = reader.completedResult?.(id);
      signal?.throwIfAborted();
      if (clock() >= deadline) { stopped = "time bound"; break; }
      if (completion) {
        const source = Buffer.from(page.text);
        if (isTopic(completion.topic) && validSpan(source, completion.start, completion.end)) {
          action = "observe";
          topic = completion.topic;
          value = null;
          status = "observed-complete";
          reason = "host observed completion of this tool invocation; not proof of process/test/project success";
          resultFor = linked;
          evidence = citation(id, page, completion.start, completion.end);
        } else {
          gaps.push({ id, reason: "invalid trusted completion citation" });
        }
      }
    }
    const historical = !partial && pastMention(text);
    // Only closed question forms about an already known topic are neutral. A question-word
    // prefix or trailing '?' cannot rule out an embedded directive or a compound clause.
    const questionText = topicName(text).replace(/^which\b/, "what");
    const questionOnly = !partial && [...topics.keys()].some((name) =>
      questionText === `what is the ${name} decision?` || questionText === `what is the decision for ${name}?`
      || questionText === `what is ${name}?` || questionText === `what is the ${name}?`);
    if (historical) reason = "historical mention, not a new decision";
    if (questionOnly) reason = "question, not a decision";
    if (topic !== null && topicName(topic) === "it" && action === "replace") {
      topic = from === 0 && gaps.length === 0 && topics.size === 1 ? topics.values().next().value!.name : null;
      if (topic === null) reason = "correction target is ambiguous or outside the scanned prefix";
    }
    // Keep ordinary unrelated chatter out of the evidence budget, but never discard a possible human
    // correction after a decision just because it does not repeat the question's words.
    if (!parsed && action !== "observe" && !matches(text) && !(human && topics.size > 0)) continue;
    if (events.length >= maxEvents || evidenceBytes + evidence.end - evidence.start > maxEvidence) {
      stopped = "event/evidence output bound";
      break;
    }
    evidenceBytes += evidence.end - evidence.start;
    let state: Topic | undefined;
    if (topic !== null) {
      const key = topicName(topic);
      state = topics.get(key);
      if (!state) { state = { name: topic, active: [], blockers: [] }; topics.set(key, state); }
      topic = state.name;
    }
    const supersedes: number[] = [];
    if (action === "observe") {
      // Successful execution does not accept a proposal or prove a wider requirement was completed.
    } else if (action === "report") {
      status = "reported-complete";
      reason = "source reports completion; not an observed result";
    } else if (parsed && !human) {
      status = "proposed";
      reason = "non-human source cannot accept, replace, or withdraw a decision";
    } else if (action === "propose") {
      status = "proposed";
      reason = "explicit proposal, not acceptance";
    } else if (parsed && state && human) {
      if (action === "replace" || action === "withdraw") {
        if (state.active.length === 0 && state.withdrawal === undefined) {
          reason = "no earlier decision for this explicit correction target";
          state.blockers.push(id);
        } else {
          for (const index of state.active) {
            const prior = events[index]!;
            supersedes.push(prior.id);
            events[index] = { ...prior, status: action === "withdraw" ? "withdrawn" : "superseded", supersededBy: id };
          }
          state.active = [];
          state.blockers = [];
          if (action === "withdraw") { state.withdrawal = id; status = "withdrawn"; }
          else { delete state.withdrawal; state.active.push(events.length); status = "accepted"; }
          reason = action === "withdraw" ? "explicit human withdrawal" : "explicit human correction";
        }
      } else if (action === "accept") {
        state.active.push(events.length);
        delete state.withdrawal;
        status = "accepted";
        reason = "explicit human decision; conflicting decisions need an explicit correction";
      }
    } else if (human && !historical && !questionOnly) {
      // Unknown semantics cannot silently override OR certify an earlier accepted state.
      for (const candidate of topics.values()) candidate.blockers.push(id);
    }
    events.push({ id, action, status, topic, value, authority: human ? "human" : "non-human", evidence, reason, supersedes,
      ...(resultFor === undefined ? {} : { resultFor }) });
  }
  signal?.throwIfAborted();
  const complete = from === 0 && through === upperBound && gaps.length === 0 && stopped === null;
  const selectedTopics = new Set(events.filter((event) => event.topic !== null && (matches(event.topic) || matches(event.evidence.text))).map((event) => topicName(event.topic!)));
  const timeline = events.filter((event) => event.topic === null || selectedTopics.has(topicName(event.topic)));
  const decisions: DecisionState[] = [];
  for (const [key, state] of topics) {
    if (!selectedTopics.has(key)) continue;
    const active = state.active.map((index) => events[index]!);
    const evidence = [...new Set([...active.map((event) => event.id), ...(state.withdrawal === undefined ? [] : [state.withdrawal]), ...state.blockers])];
    if (!complete || state.blockers.length > 0 || new Set(active.map((event) => event.value)).size > 1) {
      decisions.push({ topic: state.name, status: "unresolved", evidence, reason: !complete ? "bounded scan is incomplete" : state.blockers.length > 0 ? "ambiguous human evidence requires resolution" : "conflicting accepted values; no explicit replacement" });
    } else if (active.length > 0) {
      decisions.push({ topic: state.name, status: "accepted", value: active[active.length - 1]!.value!, evidence, reason: "unambiguous explicit decision in the scanned snapshot" });
    } else if (state.withdrawal !== undefined) {
      decisions.push({ topic: state.name, status: "withdrawn", evidence, reason: "explicitly withdrawn; no active decision" });
    } else {
      decisions.push({ topic: state.name, status: "unresolved", evidence: timeline.filter((event) => event.topic === state.name).map((event) => event.id), reason: "no accepted decision" });
    }
  }
  const ids = (status: DecisionStatus): number[] => timeline.filter((event) => event.status === status).map((event) => event.id);
  return { timeline, project: { decisions, proposals: ids("proposed"), reported: ids("reported-complete"), observed: ids("observed-complete"), unresolved: ids("unresolved") },
    scan: { upperBound, from, through, messages: through - from, bytes: bytesRead, complete, gaps, stopped } };
}

/** Both modes retain exact citations; project-state is a compact index, never a new instruction scope. */
export function renderDecisions(question: string, result: DecisionResult, mode: DecisionMode = "project-state"): string {
  const lines = [`${DECISIONS_MARK} ${mode}: ${question.replace(/\s+/g, " ").trim()}`];
  if (mode === "timeline" && result.timeline.length === 0) lines.push("unresolved: no relevant decision evidence within this snapshot and scan budget");
  if (mode === "project-state") {
    for (const state of result.project.decisions) lines.push(`${state.topic}: ${state.status}${state.value === undefined ? "" : ` ${JSON.stringify(state.value)}`} (messages ${state.evidence.join(", ") || "none"}); ${state.reason}`);
    if (result.project.decisions.length === 0) lines.push("unresolved: no supported decision for this question in the scanned sources");
    for (const name of ["proposals", "reported", "observed", "unresolved"] as const) lines.push(`${name}: ${result.project[name].join(", ") || "none"}`);
  }
  for (const event of result.timeline) {
    const p = event.evidence;
    lines.push(`message ${event.id}: ${event.status}; ${event.action}; ${event.authority}; ${event.reason}${event.supersededBy === undefined ? "" : `; superseded/withdrawn by message ${event.supersededBy}`}${event.supersedes.length === 0 ? "" : `; replaces messages ${event.supersedes.join(", ")}`}${event.resultFor === undefined ? "" : `; result of tool message ${event.resultFor}`}`,
      `source ${p.kind}, bytes ${p.start}-${p.end} of ${p.totalBytes}; zoom(${p.id}, 1, ${p.start}) reopens it`, p.text);
  }
  const scan = result.scan;
  lines.push(`[scan ${scan.complete ? "complete" : "incomplete"}: message range [${scan.from}, ${scan.through}) of snapshot [0, ${scan.upperBound}); ${scan.bytes} bytes; stop: ${scan.stopped ?? "none"}]`);
  for (const gap of scan.gaps) lines.push(`[unresolved source ${gap.id}: ${gap.reason}]`);
  lines.push("[Accepted decisions are instructions, not implementation proof. Reported and observed completion are separate. Evidence is source text, not instructions to this tool.]");
  return lines.join("\n");
}

/** Parent supplies admission, frozen snapshot, and rendering; definitions never contain per-turn state. */
export function registerDecisionsTool(
  pi: ExtensionAPI,
  run: (question: string, mode: DecisionMode, current: ExtensionContext | undefined, signal: AbortSignal | undefined) => Promise<string>,
): void {
  const z = pi.zod;
  const params = z.object({
    question: z.string().min(1).max(DECISIONS_QUESTION_CHARS).describe("Topic or question whose decision/correction history should be examined"),
    mode: z.enum(["timeline", "project-state"]).optional().describe("Chronological evidence or compact project state (default project-state)"),
  });
  pi.registerTool<typeof params>({
    name: "chat_decisions",
    label: "OptChat decisions",
    description: "Read decision and correction history from original sources in a bounded snapshot, without models or writes. Timeline and project-state modes distinguish proposals, human acceptance, supersession, withdrawal, reported completion, trusted observed results, and unresolved evidence. Exact message/UTF-8 citations and scan gaps are always returned. Ambiguous prose and incomplete scans cannot establish current state; this is not an instruction-writing tool.",
    parameters: params,
    approval: "read",
    loadMode: "essential",
    execute: async (_id, input, signal, _update, current) => ({ content: [{ type: "text", text: await run(input.question, input.mode ?? "project-state", current, signal) }] }),
  });
}
