/**
 * Private, append-only accounting for the merge experiment. No import-time I/O.
 *
 * Admission is deliberately narrow: direct Anthropic Messages, text input and
 * passive function definitions, a finite model output ceiling, and fixed token
 * tariffs. Native OpenRouter Jev Decisions uses the SDK judgment adapter and a
 * pinned input-only tariff; its explicit raw billed USD settles independently
 * from its tariff estimate. Unsupported billing/transport surfaces fail closed.
 * Chat costs are SDK configured-tariff estimates, not invoices. Input reservation treats every wire
 * UTF-8 byte as a token and adds 16,384 framing tokens; native admission reserves
 * that entire amount for EACH of its two questions (shared-state billing is not
 * assumed). Chat cache writes reserve the larger of the configured write tariff
 * and the one-hour 2x-input tariff.
 *
 * The SDK has independent retry loops despite its client's maxRetries:0. The
 * fetch gate below admits exactly one node:https request, with a fresh agent,
 * no redirect handler, no proxy and no retry handler. A second SDK fetch aborts
 * the logical call. This bounds local physical sends, not provider internals.
 * Unknown outcomes retain their full reservation and prevent further calls.
 */
import { createHash } from "node:crypto";
import {
  closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, openSync,
  readFileSync, unlinkSync, writeFileSync,
} from "node:fs";
import { request as httpsRequest } from "node:https";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
  completeSimple, createNativeJudge, resolveApiKeyOnce, type AssistantMessage, type Context,
  type FetchImpl, type JudgmentRequest, type JudgmentResult, type Model, type SimpleStreamOptions, type Usage,
} from "@oh-my-pi/pi-ai";
import { openrouterDecisionsWire } from "@oh-my-pi/pi-ai/judgment/systemone";
import { calculateUsageCost } from "@oh-my-pi/pi-catalog/models";
import { resolveJudgmentQuestionsMax } from "@oh-my-pi/pi-catalog/compat/judgment-questions";
import type { Models } from "../host.ts";

export interface FrozenTariff {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}
export interface CallSpec {
  readonly id: string;
  readonly phase: "compress" | "judge";
  readonly task: string;
  readonly arm: string;
  readonly attempt: number;
  readonly model: Model;
  readonly context: Context;
  /** Omission preserves the original SDK/model default; never replaced by a summary limit. */
  readonly maxTokens?: number;
  readonly options?: Omit<SimpleStreamOptions, "apiKey" | "maxTokens" | "maxRetries" | "signal">;
  /** Frozen manifest/code/prefix SHA-256; required with a transform, validated and bound whenever supplied. */
  readonly payloadBinding?: string;
}
export interface CompletedCall {
  readonly id: string;
  readonly phase: "compress" | "judge";
  readonly task: string;
  readonly arm: string;
  readonly attempt: number;
  readonly model: string;
  readonly requestHash: string;
  readonly wireHash: string;
  readonly reservedUsd: number;
  readonly costUsd: number;
  readonly reply: AssistantMessage;
  /** Unmodified SDK reply, including its original usage/cost evidence; private only. */
  readonly rawReply: Json;
}
export interface NativeCallSpec {
  readonly id: string;
  readonly phase: "judge";
  readonly task: string;
  readonly arm: string;
  readonly attempt: number;
  readonly model: Model;
  readonly request: JudgmentRequest;
  /** Exact approved manifest binding, supplied by the runner only after approval. */
  readonly payloadBinding: string;
}
export interface CompletedNativeCall {
  readonly kind: "native";
  readonly id: string;
  readonly phase: "judge";
  readonly task: string;
  readonly arm: string;
  readonly attempt: number;
  readonly model: string;
  readonly requestHash: string;
  /** SHA-256 of the exact serialized request body, distinct from full request/wire bindings. */
  readonly requestBodyHash: string;
  readonly wireHash: string;
  readonly reservedUsd: number;
  /** Actual explicit billed USD, not the configured-tariff estimate. */
  readonly costUsd: number;
  readonly billedUsd: number;
  readonly tariffEstimateUsd: number;
  readonly reply: JudgmentResult;
  readonly rawBody: string;
  readonly rawBodyHash: string;
}
export interface MergeAccounting {
  readonly capUsd: number;
  readonly spentUsd: number;
  readonly reservedUsd: number;
  readonly accountedUsd: number;
  readonly remainingUsd: number;
  readonly completed: number;
  readonly uncertain: number;
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonRecord = { [key: string]: Json };
interface Reservation {
  id: string;
  requestHash: string;
  request: JsonRecord;
  tariff: FrozenTariff;
  before: Json;
  transformedHash: string;
  wireHash: string;
  inputBound: number;
  outputBound: number;
  reservedUsd: number;
  /** Native wire evidence excludes authorization and is independently replay-validated. */
  wire?: NativeWire;
}
interface NativeWire {
  url: string;
  method: "POST";
  headers: string[][];
  body: string;
}
interface State { reservation: Reservation; completion?: CompletedCall; nativeCompletion?: CompletedNativeCall; uncertain: boolean; knownLiabilityUsd?: number }
/** Budget decisions use integer nano-USD; raw configured-tariff metrics remain unrounded. */
export const MERGE_LEDGER_USD_SCALE = 1_000_000_000;
/** Frozen manifest policy: no response aliases are inferred from provider model names. */
export const MERGE_LEDGER_PROVENANCE_POLICY = Object.freeze({
  provider: "anthropic",
  api: "anthropic-messages",
  upstreamModel: "exact-requested-model-id",
  responseAliases: Object.freeze([]),
  missingUpstreamModel: "allowed",
  mismatch: "uncertain",
});
/** Only exact requested identity or the explicitly authorized version alias; never infer or strip a tilde. */
export const MERGE_LEDGER_NATIVE_PROVENANCE_POLICY = Object.freeze({
  provider: "openrouter",
  api: "openrouter-decisions",
  endpoint: "https://openrouter.ai/api/alpha/decisions",
  upstreamModel: "exact-requested-wire-model-id-or-explicit-response-alias",
  responseAliases: Object.freeze(["typesafe/jev-1.14-20261014"]),
  missingUpstreamModel: "uncertain",
  mismatch: "uncertain",
});
export const MERGE_LEDGER_NATIVE_PRICE_PROVENANCE = "explicit raw OpenRouter Decisions usage.cost billed USD; configured input-tariff estimate recorded separately";
const NATIVE_TRANSPORT = "direct-openrouter-decisions-node-https-single-send-v1";
/** USD per million tokens. The bundled per-token conversion can differ by one float representation. */
export const MERGE_LEDGER_NATIVE_TARIFF: FrozenTariff = Object.freeze({ input: 0.042, output: 0, cacheRead: 0, cacheWrite: 0 });
const FRAMING_TOKENS = 16_384;
const PRICE_PROVENANCE = "provider-reported tokens at frozen SDK configured tariffs; not an invoice";
const TRANSPORT = "direct-anthropic-node-https-single-send-v1";
const OPTION_KEYS: readonly string[] = [
  "temperature", "topP", "topK", "minP", "presencePenalty", "repetitionPenalty",
  "frequencyPenalty", "stopSequences", "cacheRetention", "anthropicPrefixMismatchBehavior",
  "metadata", "sessionId", "promptCacheKey", "minimizeEffort", "toolChoice",
  "streamFirstEventTimeoutMs", "streamIdleTimeoutMs", "reasoning", "disableReasoning",
  "forceReasoningOff", "hideThinkingSummary", "thinkingBudgets",
];
class LedgerError extends Error {
  constructor(code: string) { super(`merge-ledger:${code}`); this.name = "MergeLedgerError"; }
}
class BoundBreach extends LedgerError {
  constructor(readonly knownLiabilityUsd: number) { super("usage-or-cost-exceeds-reservation"); }
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function integer(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
function budgetUnits(usd: number, rounding: "ceil" | "floor"): number {
  if (!Number.isFinite(usd) || usd < 0) throw new LedgerError("invalid-budget-amount");
  const scaled = usd * MERGE_LEDGER_USD_SCALE;
  const units = rounding === "ceil" ? Math.ceil(scaled) : Math.floor(scaled);
  if (!Number.isSafeInteger(units)) throw new LedgerError("budget-unit-overflow");
  return units;
}
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function sha(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
/** Owned JSON wire snapshot: symbol metadata is omitted like JSON.stringify; string fields and key order remain bound. */
function snapshot(value: unknown, seen = new Set<object>()): Json {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object" || seen.has(value)) throw new LedgerError("non-json-request");
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null && !Array.isArray(value)) throw new LedgerError("non-plain-request");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map(item => {
        if (item === undefined) throw new LedgerError("undefined-array-entry");
        return snapshot(item, seen);
      });
    }
    const result: JsonRecord = Object.create(null);
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable) continue;
      if (!Object.hasOwn(descriptor, "value")) throw new LedgerError("request-accessor");
      if (descriptor.value !== undefined) result[key] = snapshot(descriptor.value, seen);
    }
    return result;
  } finally { seen.delete(value); }
}
function canonical(value: unknown): string { return JSON.stringify(snapshot(value)); }
/** Only applied to in-process, already validated typed values; never a persisted-data decoder. */
function copy<T>(value: T): T { return JSON.parse(canonical(value)) as T; }
function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new LedgerError("unsupported-field");
}
function tariffOf(value: unknown): FrozenTariff {
  if (!record(value)) throw new LedgerError("missing-tariff");
  keys(value, ["input", "output", "cacheRead", "cacheWrite"]);
  const { input, output, cacheRead, cacheWrite } = value;
  if (!positive(input) || !positive(output) || !positive(cacheRead) || !positive(cacheWrite)) {
    throw new LedgerError("unknown-or-nonpositive-tariff");
  }
  return { input, output, cacheRead, cacheWrite };
}
function admitModel(model: Model): FrozenTariff {
  if (model.provider !== "anthropic" || model.api !== "anthropic-messages" ||
      !["https://api.anthropic.com", "https://api.anthropic.com/"].includes(model.baseUrl) ||
      model.transport !== undefined || model.resolveHeaders !== undefined ||
      model.omitMaxOutputTokens || model.preferWebsockets || model.pricingStatus !== undefined ||
      (model.providerType !== undefined && model.providerType !== "anthropic") ||
      (model.headers !== undefined && Object.keys(model.headers).length !== 0) ||
      !integer(model.maxTokens) || model.maxTokens === 0 || !model.id) {
    throw new LedgerError("unsupported-model-transport-or-pricing");
  }
  return tariffOf(model.cost);
}
function amount(tariff: FrozenTariff, input: number, output: number): number {
  if (!integer(input) || !integer(output) || output === 0) throw new LedgerError("invalid-reservation-bound");
  const value = (input * Math.max(tariff.input, tariff.cacheRead, tariff.cacheWrite, 2 * tariff.input) + output * tariff.output) / 1_000_000;
  if (!positive(value)) throw new LedgerError("invalid-reservation-cost");
  // Round reservations upward, never allow a fixed-dollar tolerance at the cap.
  const bounded = value + Math.abs(value) * Number.EPSILON;
  if (!positive(bounded)) throw new LedgerError("reservation-overflow");
  return bounded;
}
/** Preliminary only: paid admission uses the actual final serialized body below. */
export function reservationUsd(model: Model, context: Context, maxTokens?: number | null): number {
  const tariff = admitModel(model);
  const output = maxTokens ?? model.maxTokens;
  if (!integer(output) || output === 0) throw new LedgerError("missing-output-bound");
  // A requested visible-output cap can gain reasoning tokens; model ceiling bounds both.
  return amount(tariff, Buffer.byteLength(canonical(context), "utf8") + FRAMING_TOKENS, model.maxTokens ?? output);
}
function textBlocks(value: unknown): void {
  if (typeof value === "string") return;
  if (!Array.isArray(value)) throw new LedgerError("non-text-input");
  for (const block of value) {
    if (!record(block) || block.type !== "text" || typeof block.text !== "string") throw new LedgerError("non-text-input");
    keys(block, ["type", "text", "cache_control"]);
  }
}
function admitPayload(model: Model, payload: unknown): { input: number; output: number; tariff: FrozenTariff } {
  const tariff = admitModel(model);
  if (!record(payload)) throw new LedgerError("invalid-wire-payload");
  keys(payload, ["model", "messages", "system", "tools", "metadata", "max_tokens", "stream", "thinking", "context_management", "output_config", "tool_choice", "temperature", "top_p", "top_k", "stop_sequences"]);
  if (payload.model !== (model.requestModelId ?? model.id) || payload.stream !== true ||
      !integer(payload.max_tokens) || payload.max_tokens === 0 ||
      payload.max_tokens > (model.maxTokens ?? 0) || !Array.isArray(payload.messages) || payload.messages.length === 0) {
    throw new LedgerError("unbounded-or-mismatched-wire-request");
  }
  for (const message of payload.messages) {
    if (!record(message) || !["user", "assistant"].includes(String(message.role))) throw new LedgerError("unsupported-wire-message");
    keys(message, ["role", "content"]);
    textBlocks(message.content);
  }
  if (payload.system !== undefined) textBlocks(payload.system);
  if (payload.tools !== undefined) {
    if (!Array.isArray(payload.tools)) throw new LedgerError("invalid-tools");
    for (const tool of payload.tools) {
      if (!record(tool) || typeof tool.name !== "string" || !tool.name || !record(tool.input_schema) ||
          (tool.type !== undefined && tool.type !== "custom")) throw new LedgerError("hosted-or-unknown-tool");
      keys(tool, ["type", "name", "description", "input_schema", "cache_control", "strict", "defer_loading"]);
    }
  }
  if (payload.context_management !== undefined) {
    // The SDK's adaptive-thinking default preserves thinking; it does not run
    // compaction or a separately billed provider action. Admit that exact edit.
    const management = payload.context_management;
    if (!record(management) || !Array.isArray(management.edits) || management.edits.length !== 1) throw new LedgerError("unsupported-context-management");
    keys(management, ["edits"]);
    const edit = management.edits[0];
    if (!record(edit) || edit.type !== "clear_thinking_20251015" || edit.keep !== "all") throw new LedgerError("unsupported-context-management");
    keys(edit, ["type", "keep"]);
  }
  if (payload.output_config !== undefined) {
    if (!record(payload.output_config)) throw new LedgerError("invalid-output-config");
    keys(payload.output_config, ["effort"]);
  }
  if (payload.thinking !== undefined) {
    if (!record(payload.thinking) || !["enabled", "disabled", "adaptive", "between_tools"].includes(String(payload.thinking.type))) throw new LedgerError("unknown-thinking-mode");
    keys(payload.thinking, ["type", "budget_tokens", "display", "block_binding"]);
    if (payload.thinking.budget_tokens !== undefined && (!integer(payload.thinking.budget_tokens) || payload.thinking.budget_tokens >= payload.max_tokens)) throw new LedgerError("unbounded-thinking");
  }
  return { tariff, output: payload.max_tokens, input: Buffer.byteLength(canonical(payload), "utf8") + FRAMING_TOKENS };
}
/** Actual paid calls reserve at the final fetch boundary, after all SDK mutations. */
export function encodedReservationUsd(model: Model, payload: unknown): number {
  const bound = admitPayload(model, payload);
  return amount(bound.tariff, bound.input, bound.output);
}
function decodeUsage(value: unknown): Usage {
  if (!record(value)) throw new LedgerError("unknown-usage");
  keys(value, ["input", "output", "cacheRead", "cacheWrite", "totalTokens", "contextTokens", "reasoningTokens", "cttl", "cost"]);
  const { input, output, cacheRead, cacheWrite, totalTokens } = value;
  if (!integer(input) || !integer(output) || !integer(cacheRead) || !integer(cacheWrite) || !integer(totalTokens) ||
      input + cacheRead + cacheWrite === 0 || totalTokens !== input + output + cacheRead + cacheWrite) throw new LedgerError("unknown-usage");
  const usage: Usage = { input, output, cacheRead, cacheWrite, totalTokens, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  if (value.reasoningTokens !== undefined) {
    if (!integer(value.reasoningTokens) || value.reasoningTokens > output) throw new LedgerError("invalid-reasoning-usage");
    usage.reasoningTokens = value.reasoningTokens;
  }
  if (value.contextTokens !== undefined) {
    if (!integer(value.contextTokens)) throw new LedgerError("invalid-context-usage");
    usage.contextTokens = value.contextTokens;
  }
  if (value.cttl !== undefined) {
    if (!record(value.cttl)) throw new LedgerError("invalid-cache-usage");
    keys(value.cttl, ["ephemeral5m", "ephemeral1h"]);
    const five = value.cttl.ephemeral5m ?? 0; const hour = value.cttl.ephemeral1h ?? 0;
    if (!integer(five) || !integer(hour) || five + hour > cacheWrite) throw new LedgerError("invalid-cache-usage");
    usage.cttl = { ephemeral5m: five, ephemeral1h: hour };
  }
  return usage;
}
function settledReply(value: unknown, reservation: Reservation): { reply: AssistantMessage; costUsd: number } {
  if (!record(value) || value.role !== "assistant" || value.api !== "anthropic-messages" || value.provider !== "anthropic" ||
      typeof value.model !== "string" || `anthropic/${value.model}` !== reservation.request.selector ||
      !integer(value.timestamp) || !Array.isArray(value.content) ||
      !(value.stopReason === "stop" || value.stopReason === "length" || value.stopReason === "toolUse" ||
        (value.stopReason === "error" && typeof value.errorMessage === "string" && value.errorMessage.startsWith("Refusal")))) {
    throw new LedgerError("unknown-completion");
  }
  // Receiving a refusal credit handle is not redeeming it. Redemption/fallback
  // request options are forbidden, but a known refusal still settles its usage.
  if ((value.serviceTier !== undefined && value.serviceTier !== "standard") ||
      (value.upstreamProvider !== undefined && value.upstreamProvider !== "anthropic") ||
      (value.upstreamModel !== undefined && value.upstreamModel !== value.model)) throw new LedgerError("unpriced-completion");
  const content: AssistantMessage["content"] = [];
  for (const part of value.content) {
    if (!record(part)) throw new LedgerError("invalid-completion-content");
    if (part.type === "text" && typeof part.text === "string") {
      content.push({ type: "text", text: part.text, ...(typeof part.textSignature === "string" ? { textSignature: part.textSignature } : {}) });
    } else if (part.type === "thinking" && typeof part.thinking === "string") {
      content.push({ type: "thinking", thinking: part.thinking,
        ...(typeof part.thinkingSignature === "string" ? { thinkingSignature: part.thinkingSignature } : {}),
        ...(typeof part.itemId === "string" ? { itemId: part.itemId } : {}),
        ...(typeof part.summary === "boolean" ? { summary: part.summary } : {}),
      });
    } else if (part.type === "redactedThinking" && typeof part.data === "string") {
      content.push({ type: "redactedThinking", data: part.data });
    } else if (part.type === "toolCall" && typeof part.id === "string" && typeof part.name === "string" && record(part.arguments)) {
      content.push({ type: "toolCall", id: part.id, name: part.name, arguments: copy(part.arguments) });
    } else throw new LedgerError("unsupported-completion-content");
  }
  const usage = decodeUsage(value.usage);
  // One-hour writes must be identified; absence is not proof of five-minute pricing.
  if (usage.cacheWrite > 0 && (!usage.cttl || (usage.cttl.ephemeral5m ?? 0) + (usage.cttl.ephemeral1h ?? 0) !== usage.cacheWrite)) throw new LedgerError("unknown-cache-write-ttl");
  const priced = calculateUsageCost(reservation.tariff, usage, value.timestamp);
  if (!positive(priced.total)) throw new LedgerError("unknown-completion-cost");
  if (usage.output > reservation.outputBound || usage.input + usage.cacheRead + usage.cacheWrite > reservation.inputBound || priced.total > reservation.reservedUsd) {
    throw new BoundBreach(priced.total);
  }
  const reply: AssistantMessage = {
    role: "assistant", api: "anthropic-messages", provider: "anthropic", model: value.model,
    timestamp: value.timestamp, stopReason: value.stopReason, content, usage,
    ...(typeof value.errorMessage === "string" ? { errorMessage: value.errorMessage } : {}),
    ...(typeof value.responseId === "string" ? { responseId: value.responseId } : {}),
    ...(typeof value.upstreamModel === "string" ? { upstreamModel: value.upstreamModel } : {}),
    ...(typeof value.upstreamProvider === "string" ? { upstreamProvider: value.upstreamProvider } : {}),
  };
  return { reply, costUsd: priced.total };
}
function nonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
function admitNativeModel(model: unknown): FrozenTariff {
  if (!record(model) || model.provider !== "openrouter" || model.api !== "openrouter-decisions" || model.id !== "~typesafe/jev-latest" ||
      !["https://openrouter.ai/api/alpha", "https://openrouter.ai/api/alpha/"].includes(String(model.baseUrl)) ||
      (model.requestModelId !== undefined && model.requestModelId !== model.id) || model.transport !== undefined || model.resolveHeaders !== undefined ||
      model.pricingStatus !== undefined || model.preferWebsockets || model.omitMaxOutputTokens ||
      (model.providerType !== undefined && model.providerType !== "openrouter") ||
      (model.headers !== undefined && (!record(model.headers) || Object.keys(model.headers).length !== 0)) || !record(model.cost)) throw new LedgerError("unsupported-native-model-transport-or-pricing");
  keys(model.cost, ["input", "output", "cacheRead", "cacheWrite"]);
  if (![MERGE_LEDGER_NATIVE_TARIFF.input, 4.2e-8 * 1_000_000].includes(Number(model.cost.input)) || typeof model.cost.input !== "number" ||
      model.cost.output !== 0 || model.cost.cacheRead !== 0 || model.cost.cacheWrite !== 0) throw new LedgerError("unsupported-native-fixed-tariff");
  // Use the nominal fixed tariff rather than rounding the bundled float down.
  return { ...MERGE_LEDGER_NATIVE_TARIFF };
}
function nativeBody(model: unknown, request: unknown): string {
  admitNativeModel(model);
  if (!record(model)) throw new LedgerError("invalid-native-model");
  const owned = snapshot(request);
  nativeQuestions(owned);
  const wireModel = model.requestModelId ?? model.id;
  if (typeof wireModel !== "string") throw new LedgerError("invalid-native-wire-model");
  // Use the same SDK encoder as createNativeJudge, then compare its final fetch string exactly.
  return JSON.stringify(openrouterDecisionsWire.encode(owned, wireModel));
}
/** Unpaid exact System One body; SDK encoding drift is vetoed before any physical send. */
export function encodeNativeRequest(model: Model, request: JudgmentRequest): string {
  const cap = resolveJudgmentQuestionsMax(model);
  if (cap !== undefined && cap < 2) throw new LedgerError("native-chunking-forbidden");
  return nativeBody(model, request);
}
/** Reserve both questions independently: no assumption that upstream bills their shared state only once. */
function nativeInputBound(body: string): number {
  return 2 * (Buffer.byteLength(body, "utf8") + FRAMING_TOKENS);
}
/** Exact native encoded bytes plus framing, conservatively charged in full for each of the two questions. */
export function nativeEncodedReservationUsd(model: Model, request: JudgmentRequest): number {
  const body = encodeNativeRequest(model, request);
  return nativeAmount(admitNativeModel(model), nativeInputBound(body));
}
function nativeQuestions(value: unknown): asserts value is JudgmentRequest {
  if (!record(value)) throw new LedgerError("invalid-native-request");
  keys(value, ["state", "questions"]);
  if (!(typeof value.state === "string" || record(value.state) || Array.isArray(value.state)) || !record(value.questions)) throw new LedgerError("invalid-native-request");
  if (Object.keys(value.questions).length !== 2 || !Object.hasOwn(value.questions, "A") || !Object.hasOwn(value.questions, "B")) throw new LedgerError("native-two-questions-required");
  for (const question of Object.values(value.questions)) {
    if (!record(question) || question.type !== "choice" || typeof question.instructions !== "string" || !record(question.criteria)) throw new LedgerError("invalid-native-question");
    keys(question, ["type", "instructions", "criteria"]);
    keys(question.criteria, ["0", "0.5", "1"]);
    if (Object.keys(question.criteria).length !== 3 || Object.values(question.criteria).some(value => value !== null && typeof value !== "string")) throw new LedgerError("invalid-native-criteria");
  }
}
function nativeAmount(tariff: FrozenTariff, input: number): number {
  if (!integer(input) || input < FRAMING_TOKENS) throw new LedgerError("invalid-native-bound");
  const value = input * tariff.input / 1_000_000;
  if (!positive(value)) throw new LedgerError("invalid-native-reservation-cost");
  const bounded = value + Math.abs(value) * Number.EPSILON;
  budgetUnits(bounded, "ceil");
  return bounded;
}
/** Valid billed USD remains a liability even when other raw provenance is malformed. */
function nativeLiability(rawBody: string | undefined): number | undefined {
  if (rawBody === undefined) return undefined;
  let payload: unknown;
  try { payload = JSON.parse(rawBody); } catch { return undefined; }
  return record(payload) && record(payload.usage) && nonnegative(payload.usage.cost) ? payload.usage.cost : undefined;
}
function nativeSettledReply(rawBody: string, reservation: Reservation): { reply: JudgmentResult; costUsd: number; tariffEstimateUsd: number } {
  let payload: unknown;
  try { payload = JSON.parse(rawBody); } catch { throw new LedgerError("invalid-native-response-json"); }
  const model = reservation.request.model;
  const request = reservation.request.judgment;
  if (!record(model) || typeof model.id !== "string") throw new LedgerError("invalid-native-model-binding");
  nativeQuestions(request);
  if (!record(payload) || typeof payload.model !== "string" ||
      (payload.model !== (model.requestModelId ?? model.id) && !MERGE_LEDGER_NATIVE_PROVENANCE_POLICY.responseAliases.includes(payload.model)) ||
      !record(payload.usage) || !record(payload.answers)) throw new LedgerError("unknown-native-response-provenance");
  const { input_tokens: input, output_tokens: output, cost } = payload.usage;
  if (!integer(input) || !integer(output) || !Number.isSafeInteger(input + output) || !nonnegative(cost)) throw new LedgerError("unknown-native-usage-or-cost");
  // Presence is mandatory: SDK tokenUsage would otherwise turn missing billing into zero.
  for (const key of ["input_tokens", "output_tokens", "cost"]) {
    if (!Object.hasOwn(payload.usage, key)) throw new LedgerError("unknown-native-usage-or-cost");
  }
  budgetUnits(cost, "ceil");
  if (input > reservation.inputBound || cost > reservation.reservedUsd) throw new BoundBreach(cost);
  const answers: JudgmentResult["answers"] = {};
  keys(payload.answers, ["A", "B"]);
  for (const id of ["A", "B"]) {
    const answer = payload.answers[id];
    if (!record(answer) || answer.type !== "choice" || typeof answer.choice !== "string" ||
        !["0", "0.5", "1"].includes(answer.choice) || !record(answer.probabilities) ||
        !nonnegative(answer.confidence) || answer.confidence > 1) throw new LedgerError("invalid-native-answer");
    keys(answer, ["type", "choice", "probabilities", "confidence"]);
    keys(answer.probabilities, ["0", "0.5", "1"]);
    if (Object.keys(answer.probabilities).length !== 3 || Object.values(answer.probabilities).some(value => !nonnegative(value) || value > 1)) throw new LedgerError("invalid-native-probabilities");
    const probabilities: Record<string, number> = {};
    for (const label of ["0", "0.5", "1"]) {
      const probability = answer.probabilities[label];
      if (!nonnegative(probability)) throw new LedgerError("invalid-native-probabilities");
      probabilities[label] = probability;
    }
    answers[id] = { type: "choice", choice: answer.choice, probabilities, confidence: answer.confidence };
  }
  const tariffEstimateUsd = input * reservation.tariff.input / 1_000_000;
  if (!nonnegative(tariffEstimateUsd)) throw new LedgerError("invalid-native-tariff-estimate");
  return {
    costUsd: cost, tariffEstimateUsd,
    reply: {
      api: "openrouter-decisions", provider: "openrouter", model: payload.model, answers,
      usage: { input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output,
        cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost } },
    },
  };
}
function nativeReplyMatches(value: unknown, expected: JudgmentResult): boolean {
  if (!record(value)) return false;
  keys(value, ["api", "provider", "model", "answers", "usage"]);
  if (value.api !== expected.api || value.provider !== expected.provider || value.model !== expected.model ||
      canonical(value.usage) !== canonical(expected.usage) || !record(value.answers)) return false;
  keys(value.answers, ["A", "B"]);
  if (Object.keys(value.answers).length !== 2) return false;
  for (const id of ["A", "B"]) {
    const answer = value.answers[id]; const wanted = expected.answers[id];
    if (!record(answer) || wanted?.type !== "choice") return false;
    keys(answer, ["type", "choice", "probabilities", "confidence"]);
    if (answer.type !== wanted.type || answer.choice !== wanted.choice || answer.confidence !== wanted.confidence || !record(answer.probabilities)) return false;
    keys(answer.probabilities, ["0", "0.5", "1"]);
    if (Object.keys(answer.probabilities).length !== 3) return false;
    for (const label of ["0", "0.5", "1"]) if (answer.probabilities[label] !== wanted.probabilities[label]) return false;
  }
  return true;
}
function decodeNativeReservation(row: Record<string, unknown>): Reservation {
  keys(row, ["kind", "id", "requestHash", "request", "tariff", "before", "transformedHash", "wireHash", "wire", "inputBound", "outputBound", "reservedUsd"]);
  if (typeof row.id !== "string" || !row.id || !record(row.request) || !sha(row.requestHash) ||
      hash(canonical(row.request)) !== row.requestHash || row.request.id !== row.id ||
      !sha(row.transformedHash) || !sha(row.wireHash) || !integer(row.inputBound) || row.outputBound !== 0 || !positive(row.reservedUsd)) throw new LedgerError("invalid-native-reservation");
  const request = snapshot(row.request);
  if (!record(request)) throw new LedgerError("invalid-native-request-binding");
  keys(request, ["kind", "id", "phase", "task", "arm", "attempt", "selector", "model", "judgment", "payloadBinding", "authSessionId", "maxQuestions", "transport", "provenance", "pricing"]);
  if (request.kind !== "native" || request.phase !== "judge" || typeof request.task !== "string" || !request.task || typeof request.arm !== "string" || !request.arm ||
      !integer(request.attempt) || request.attempt === 0 || !sha(request.payloadBinding) || typeof request.authSessionId !== "string" || !request.authSessionId ||
      (request.maxQuestions !== null && (!integer(request.maxQuestions) || request.maxQuestions < 2)) ||
      request.transport !== NATIVE_TRANSPORT || canonical(request.provenance) !== canonical(MERGE_LEDGER_NATIVE_PROVENANCE_POLICY) ||
      request.pricing !== MERGE_LEDGER_NATIVE_PRICE_PROVENANCE || !record(request.model) || request.selector !== `${request.model.provider}/${request.model.id}`) throw new LedgerError("invalid-native-request-binding");
  const tariff = admitNativeModel(request.model);
  if (canonical(row.tariff) !== canonical(tariff)) throw new LedgerError("native-tariff-mismatch");
  const body = nativeBody(request.model, request.judgment);
  const inputBound = nativeInputBound(body);
  if (canonical(row.before) !== canonical(request.judgment) || row.transformedHash !== hash(body) || row.inputBound !== inputBound ||
      row.reservedUsd !== nativeAmount(tariff, inputBound)) throw new LedgerError("native-reservation-bound-mismatch");
  if (!record(row.wire)) throw new LedgerError("missing-native-wire-binding");
  keys(row.wire, ["url", "method", "headers", "body"]);
  const wire: NativeWire = { url: MERGE_LEDGER_NATIVE_PROVENANCE_POLICY.endpoint, method: "POST",
    headers: [["accept", "application/json"], ["accept-encoding", "identity"], ["content-length", String(Buffer.byteLength(body, "utf8"))], ["content-type", "application/json"]], body };
  if (canonical(row.wire) !== canonical(wire) || row.wireHash !== hash(canonical(wire))) throw new LedgerError("native-wire-binding-mismatch");
  return { id: row.id, requestHash: row.requestHash, request, tariff, before: snapshot(row.before),
    transformedHash: row.transformedHash, wireHash: row.wireHash, wire, inputBound, outputBound: 0, reservedUsd: row.reservedUsd };
}
function privateFile(fd: number): void {
  const stat = fstatSync(fd);
  if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw new LedgerError("unsafe-private-file");
}
function syncDirectory(dir: string): void {
  const fd = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
/** A single fresh HTTP/1.1 request: no retry, redirect, pool reuse, or environment proxy. */
function sendOnce(url: URL, headers: Headers, body: string, signal: AbortSignal): Promise<Response> {
  const { promise, resolve, reject } = Promise.withResolvers<Response>();
  try {
    const request = httpsRequest(url, {
      method: "POST", agent: false, signal, rejectUnauthorized: true,
      headers: Object.fromEntries(headers.entries()),
    }, response => {
      try {
        const encoding = response.headers["content-encoding"];
        if (encoding !== undefined && encoding !== "identity") throw new LedgerError("unsupported-response-encoding");
        const status = response.statusCode;
        if (!status || status < 200 || status > 599) throw new LedgerError("invalid-http-status");
        const responseHeaders = new Headers();
        for (let index = 0; index < response.rawHeaders.length; index += 2) {
          responseHeaders.append(response.rawHeaders[index]!, response.rawHeaders[index + 1]!);
        }
        if (status === 204 || status === 205 || status === 304) {
          response.resume(); resolve(new Response(null, { status, headers: responseHeaders }));
        } else {
          // Node's stream is structurally identical but has different ambient declarations.
          const stream = Readable.toWeb(response) as unknown as ReadableStream<Uint8Array>;
          resolve(new Response(stream, { status, headers: responseHeaders }));
        }
      } catch { response.destroy(); reject(new LedgerError("invalid-http-response")); }
    });
    request.once("error", () => reject(new LedgerError("transport-failed")));
    request.end(body, "utf8");
  } catch { reject(new LedgerError("transport-failed")); }
  return promise;
}

export class MergeLedger {
  readonly #dir: string;
  readonly #path: string;
  readonly #lock: string;
  readonly #cap: number;
  readonly #capUnits: number;
  #states = new Map<string, State>();
  #sequence = 0;
  #lastHash = "";
  #busy = false;
  #poisoned = false;

  constructor(dir: string, cap: number) {
    if (!positive(cap) || cap > 4.5) throw new LedgerError("invalid-cap");
    this.#capUnits = budgetUnits(cap, "floor");
    if (this.#capUnits === 0) throw new LedgerError("cap-below-budget-unit");
    this.#dir = dir; this.#cap = cap;
    this.#path = join(dir, "merge-ledger.jsonl"); this.#lock = join(dir, "merge-ledger.lock");
    try {
      const stat = lstatSync(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw new LedgerError("unsafe-run-directory");
      this.#load();
    } catch (error) {
      if (error instanceof LedgerError) throw error;
      throw new LedgerError("journal-open-failed");
    }
  }

  #budget(): { spent: number; reserved: number; accounted: number; completed: number; uncertain: number } {
    let spent = 0; let reserved = 0; let completed = 0; let uncertain = 0;
    for (const state of this.#states.values()) {
      const completion = state.completion ?? state.nativeCompletion;
      if (completion) { spent += budgetUnits(completion.costUsd, "ceil"); completed++; }
      else { reserved += budgetUnits(Math.max(state.reservation.reservedUsd, state.knownLiabilityUsd ?? 0), "ceil"); uncertain++; }
      if (!Number.isSafeInteger(spent) || !Number.isSafeInteger(reserved) || !Number.isSafeInteger(spent + reserved)) throw new LedgerError("budget-unit-overflow");
    }
    return { spent, reserved, accounted: spent + reserved, completed, uncertain };
  }

  /** Conservative budget charges; costUsd()/completedCalls() retain unrounded actual tariff metrics. */
  summary(): MergeAccounting {
    const budget = this.#budget();
    return {
      capUsd: this.#cap, spentUsd: budget.spent / MERGE_LEDGER_USD_SCALE,
      reservedUsd: budget.reserved / MERGE_LEDGER_USD_SCALE,
      accountedUsd: budget.accounted / MERGE_LEDGER_USD_SCALE,
      remainingUsd: Math.max(0, this.#capUnits - budget.accounted) / MERGE_LEDGER_USD_SCALE,
      completed: budget.completed, uncertain: budget.uncertain,
    };
  }
  hasUncertain(): boolean { return this.#poisoned || this.summary().uncertain !== 0; }
  /** Private raw completions: callers must not print these or their source text. */
  completedCalls(): CompletedCall[] {
    return [...this.#states.values()].flatMap(state => state.completion ? [copy(state.completion)] : []);
  }
  /** Native raw responses are private and never synthesized into assistant messages. */
  completedNativeCalls(): CompletedNativeCall[] {
    return [...this.#states.values()].flatMap(state => state.nativeCompletion ? [copy(state.nativeCompletion)] : []);
  }
  costUsd(id: string): number | null {
    const state = this.#states.get(id);
    return state?.completion?.costUsd ?? state?.nativeCompletion?.costUsd ?? null;
  }
  #header(): JsonRecord {
    return snapshot({ kind: "header", version: 3, capUsd: this.#cap, capUnits: this.#capUnits,
      usdScale: MERGE_LEDGER_USD_SCALE, rounding: "ceil-per-call-floor-cap", provenance: PRICE_PROVENANCE, transport: TRANSPORT,
      native: { provenance: MERGE_LEDGER_NATIVE_PRICE_PROVENANCE, policy: MERGE_LEDGER_NATIVE_PROVENANCE_POLICY, tariff: MERGE_LEDGER_NATIVE_TARIFF,
        reservation: { questions: 2, perQuestion: "full-wire-utf8-bytes-plus-framing", framingTokens: FRAMING_TOKENS }, transport: NATIVE_TRANSPORT },
    }) as JsonRecord;
  }

  #append(entry: JsonRecord): void {
    const core = { seq: this.#sequence, previous: this.#lastHash, entry };
    const digest = hash(canonical(core));
    let fd: number | undefined;
    try {
      fd = openSync(this.#path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
      privateFile(fd);
      writeFileSync(fd, `${canonical({ ...core, hash: digest })}\n`, "utf8");
      fsyncSync(fd); syncDirectory(this.#dir);
    } catch { this.#poisoned = true; throw new LedgerError("durable-write-failed"); }
    finally { if (fd !== undefined) closeSync(fd); }
    this.#sequence++; this.#lastHash = digest;
  }

  #load(): void {
    this.#states.clear(); this.#sequence = 0; this.#lastHash = "";
    if (!existsSync(this.#path)) return;
    const fd = openSync(this.#path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let text: string;
    try { privateFile(fd); text = readFileSync(fd, "utf8"); } finally { closeSync(fd); }
    if (!text || !text.endsWith("\n")) throw new LedgerError("torn-or-empty-journal");
    for (const line of text.slice(0, -1).split("\n")) {
      let parsed: unknown;
      try { parsed = JSON.parse(line); } catch { throw new LedgerError("invalid-journal-json"); }
      if (!record(parsed) || !record(parsed.entry)) throw new LedgerError("invalid-journal-row");
      keys(parsed, ["seq", "previous", "entry", "hash"]);
      if (parsed.seq !== this.#sequence || parsed.previous !== this.#lastHash || !sha(parsed.hash) ||
          parsed.hash !== hash(canonical({ seq: parsed.seq, previous: parsed.previous, entry: parsed.entry }))) throw new LedgerError("journal-chain-mismatch");
      const row = parsed.entry;
      if ([...this.#states.values()].some(state => state.uncertain)) throw new LedgerError("journal-continues-after-uncertainty");
      if (this.#sequence === 0) {
        if (canonical(row) !== canonical(this.#header())) throw new LedgerError("journal-header-mismatch");
      } else if (row.kind === "reserved") {
        if (this.summary().uncertain !== 0) throw new LedgerError("overlapping-journal-reservations");
        keys(row, ["kind", "id", "requestHash", "request", "tariff", "before", "transformedHash", "wireHash", "inputBound", "outputBound", "reservedUsd"]);
        if (typeof row.id !== "string" || !row.id || this.#states.has(row.id) || !sha(row.requestHash) || !record(row.request) ||
            hash(canonical(row.request)) !== row.requestHash || row.request.id !== row.id ||
            !sha(row.transformedHash) || !sha(row.wireHash) || !integer(row.inputBound) || !integer(row.outputBound) || row.outputBound === 0 || !positive(row.reservedUsd)) throw new LedgerError("invalid-reservation");
        const request = snapshot(row.request);
        if (!record(request)) throw new LedgerError("invalid-request-binding");
        const tariff = tariffOf(row.tariff);
        if (row.reservedUsd !== amount(tariff, row.inputBound, row.outputBound)) throw new LedgerError("reservation-cost-mismatch");
        const reservation: Reservation = {
          id: row.id, requestHash: row.requestHash, request, tariff, before: snapshot(row.before),
          transformedHash: row.transformedHash, wireHash: row.wireHash, inputBound: row.inputBound,
          outputBound: row.outputBound, reservedUsd: row.reservedUsd,
        };
        this.#states.set(row.id, { reservation, uncertain: false });
      } else if (row.kind === "native-reserved") {
        if (this.summary().uncertain !== 0) throw new LedgerError("overlapping-journal-reservations");
        const reservation = decodeNativeReservation(row);
        if (this.#states.has(reservation.id)) throw new LedgerError("duplicate-native-reservation");
        this.#states.set(reservation.id, { reservation, uncertain: false });
      } else if (row.kind === "native-completed" || row.kind === "native-uncertain") {
        const state = typeof row.id === "string" ? this.#states.get(row.id) : undefined;
        if (!state || state.completion || state.nativeCompletion || state.uncertain || state.reservation.request.kind !== "native" || row.requestHash !== state.reservation.requestHash) throw new LedgerError("orphan-or-duplicate-native-settlement");
        if (row.kind === "native-uncertain") {
          keys(row, ["kind", "id", "requestHash", "reason", "knownLiabilityUsd", "rawBody", "rawBodyHash"]);
          if (row.reason !== "outcome-unknown" || (row.rawBody !== undefined && (typeof row.rawBody !== "string" || row.rawBodyHash !== hash(row.rawBody))) ||
              (row.rawBody === undefined && row.rawBodyHash !== undefined) ||
              (row.knownLiabilityUsd !== undefined && !nonnegative(row.knownLiabilityUsd))) throw new LedgerError("invalid-native-uncertainty");
          const knownLiabilityUsd = nativeLiability(typeof row.rawBody === "string" ? row.rawBody : undefined);
          if (knownLiabilityUsd !== row.knownLiabilityUsd) throw new LedgerError("native-liability-mismatch");
          state.uncertain = true; state.knownLiabilityUsd = knownLiabilityUsd;
        } else {
          keys(row, ["kind", "id", "requestHash", "reply", "rawBody", "rawBodyHash", "costUsd", "tariffEstimateUsd"]);
          if (typeof row.rawBody !== "string" || row.rawBodyHash !== hash(row.rawBody)) throw new LedgerError("invalid-native-raw-binding");
          const settled = nativeSettledReply(row.rawBody, state.reservation);
          if (settled.costUsd !== row.costUsd || settled.tariffEstimateUsd !== row.tariffEstimateUsd || !nativeReplyMatches(row.reply, settled.reply)) throw new LedgerError("native-completion-mismatch");
          state.nativeCompletion = this.#nativeCompletion(state.reservation, settled, row.rawBody);
        }
      } else if (row.kind === "completed" || row.kind === "uncertain") {
        const state = typeof row.id === "string" ? this.#states.get(row.id) : undefined;
        if (!state || state.completion || state.nativeCompletion || state.uncertain || state.reservation.request.kind === "native" || row.requestHash !== state.reservation.requestHash) throw new LedgerError("orphan-or-duplicate-settlement");
        if (row.kind === "uncertain") {
          keys(row, ["kind", "id", "requestHash", "reason", "knownLiabilityUsd", "rawReply"]);
          if (row.reason !== "outcome-unknown" || (row.knownLiabilityUsd !== undefined && !positive(row.knownLiabilityUsd)) ||
              (row.rawReply !== undefined && (!record(row.rawReply) || row.rawReply.role !== "assistant"))) throw new LedgerError("unknown-uncertainty-reason");
          state.uncertain = true;
          if (positive(row.knownLiabilityUsd)) state.knownLiabilityUsd = row.knownLiabilityUsd;
        } else {
          keys(row, ["kind", "id", "requestHash", "reply", "rawReply", "costUsd"]);
          const settled = settledReply(row.rawReply, state.reservation);
          if (settled.costUsd !== row.costUsd || canonical(settled.reply) !== canonical(row.reply)) throw new LedgerError("completion-cost-mismatch");
          state.completion = this.#completion(state.reservation, settled.reply, settled.costUsd, snapshot(row.rawReply));
        }
      } else throw new LedgerError("unknown-journal-event");
      this.#sequence++; this.#lastHash = parsed.hash;
      if (this.#budget().accounted > this.#capUnits && row.kind !== "uncertain" && row.kind !== "native-uncertain") throw new LedgerError("journal-over-cap");
    }
  }

  #completion(reservation: Reservation, reply: AssistantMessage, costUsd: number, rawReply: Json): CompletedCall {
    const { id, phase, task, arm, attempt, selector } = reservation.request;
    if (typeof id !== "string" || (phase !== "compress" && phase !== "judge") || typeof task !== "string" || typeof arm !== "string" || !integer(attempt) || typeof selector !== "string") throw new LedgerError("invalid-request-metadata");
    return { id, phase, task, arm, attempt, model: selector, requestHash: reservation.requestHash, wireHash: reservation.wireHash, reservedUsd: reservation.reservedUsd, costUsd, reply, rawReply };
  }

  #nativeCompletion(reservation: Reservation, settled: { reply: JudgmentResult; costUsd: number; tariffEstimateUsd: number }, rawBody: string): CompletedNativeCall {
    const { id, phase, task, arm, attempt, selector } = reservation.request;
    if (typeof id !== "string" || phase !== "judge" || typeof task !== "string" || typeof arm !== "string" || !integer(attempt) || typeof selector !== "string") throw new LedgerError("invalid-native-request-metadata");
    return { kind: "native", id, phase, task, arm, attempt, model: selector,
      requestHash: reservation.requestHash, requestBodyHash: reservation.transformedHash,
      wireHash: reservation.wireHash, reservedUsd: reservation.reservedUsd,
      costUsd: settled.costUsd, billedUsd: settled.costUsd, tariffEstimateUsd: settled.tariffEstimateUsd,
      reply: settled.reply, rawBody, rawBodyHash: hash(rawBody) };
  }

  /** The caller must have approved the exact frozen manifest before invoking this paid boundary. */
  async judge(models: Models, spec: NativeCallSpec, signal?: AbortSignal): Promise<CompletedNativeCall> {
    if (this.#busy || this.#poisoned) throw new LedgerError("ledger-unavailable");
    if (!spec.id || !spec.task || !spec.arm || spec.phase !== "judge" || !integer(spec.attempt) || spec.attempt === 0 || !sha(spec.payloadBinding)) throw new LedgerError("invalid-native-call-metadata");
    // Own the model/request before auth awaits. This exact body must be the SDK's one physical request.
    const id = spec.id; const model = copy(spec.model); const judgment = copy(spec.request);
    const tariff = admitNativeModel(model);
    const body = encodeNativeRequest(model, judgment);
    const maxQuestions = resolveJudgmentQuestionsMax(model) ?? null;
    if (maxQuestions !== null && maxQuestions < 2) throw new LedgerError("native-chunking-forbidden");
    const authSessionId = models.sessionId;
    if (!authSessionId) throw new LedgerError("missing-session-binding");
    const resolver = models.registry.resolver(copy(model), authSessionId);
    const bindingValue = snapshot({
      kind: "native", id, phase: spec.phase, task: spec.task, arm: spec.arm, attempt: spec.attempt,
      selector: `${model.provider}/${model.id}`, model, judgment, payloadBinding: spec.payloadBinding, authSessionId,
      maxQuestions, transport: NATIVE_TRANSPORT, provenance: MERGE_LEDGER_NATIVE_PROVENANCE_POLICY,
      pricing: MERGE_LEDGER_NATIVE_PRICE_PROVENANCE,
    });
    if (!record(bindingValue)) throw new LedgerError("invalid-native-binding");
    const binding: JsonRecord = bindingValue;
    const requestHash = hash(canonical(binding));
    this.#busy = true;
    let lockFd: number | undefined;
    let reservation: Reservation | undefined;
    let fetchEntered = false;
    let gateError: LedgerError | undefined;
    let rawBody: string | undefined;
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) controller.abort();
    try {
      try { lockFd = openSync(this.#lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
      catch { throw new LedgerError("run-locked-no-speculative-recovery"); }
      writeFileSync(lockFd, `${process.pid}\n`); fsyncSync(lockFd); syncDirectory(this.#dir);
      this.#load();
      if (this.hasUncertain()) throw new LedgerError("unresolved-reservation-no-resume");
      const previous = this.#states.get(id);
      if (previous) {
        if (!previous.nativeCompletion || previous.reservation.requestHash !== requestHash) throw new LedgerError("resume-request-mismatch");
        if (controller.signal.aborted) throw new LedgerError("cancelled-before-replay");
        return copy(previous.nativeCompletion);
      }
      if (controller.signal.aborted) throw new LedgerError("cancelled-before-auth");
      let apiKey: string | undefined;
      try { apiKey = await resolveApiKeyOnce(resolver, controller.signal); }
      catch { throw new LedgerError("credential-resolution-failed"); }
      if (!apiKey || apiKey === "N/A") throw new LedgerError("credential-unavailable");
      if (controller.signal.aborted) throw new LedgerError("cancelled-before-request");
      if (this.#sequence === 0) this.#append(this.#header());
      const guardedFetch: FetchImpl = async (input, init) => {
        // Latch before any await, so parallel chunks, auth rotation and SDK retries cannot spend twice.
        if (fetchEntered) {
          gateError = new LedgerError("physical-retry-veto"); controller.abort(); throw gateError;
        }
        fetchEntered = true;
        try {
          if (controller.signal.aborted || init?.signal?.aborted) throw new LedgerError("cancelled-before-request");
          if (input instanceof Request || (typeof input !== "string" && !(input instanceof URL)) || init?.method !== "POST" || init.body !== body) throw new LedgerError("native-encoded-request-mismatch");
          const url = new URL(String(input));
          if (url.href !== MERGE_LEDGER_NATIVE_PROVENANCE_POLICY.endpoint) throw new LedgerError("native-endpoint-mismatch");
          const headers = new Headers(init.headers);
          if (headers.get("authorization") !== `Bearer ${apiKey}` || headers.get("accept") !== "application/json" || headers.get("content-type") !== "application/json" ||
              [...headers.keys()].some(key => !["authorization", "accept", "content-type"].includes(key))) throw new LedgerError("native-header-mismatch");
          headers.set("accept-encoding", "identity");
          headers.set("content-length", String(Buffer.byteLength(body, "utf8")));
          const wire: NativeWire = { url: url.href, method: "POST", headers: [...headers.entries()].filter(([key]) => key !== "authorization"), body };
          const inputBound = nativeInputBound(body);
          const reservedUsd = nativeAmount(tariff, inputBound);
          if (budgetUnits(reservedUsd, "ceil") > this.#capUnits - this.#budget().accounted) throw new LedgerError("budget-stop");
          reservation = { id, requestHash, request: binding, tariff, before: snapshot(judgment),
            transformedHash: hash(body), wireHash: hash(canonical(wire)), wire, inputBound, outputBound: 0, reservedUsd };
          const entry = snapshot(reservation);
          if (!record(entry)) throw new LedgerError("invalid-native-reservation-record");
          this.#append({ kind: "native-reserved", ...entry });
          this.#states.set(id, { reservation, uncertain: false });
          if (controller.signal.aborted || init.signal?.aborted) throw new LedgerError("cancelled-after-reservation");
          const sendSignal = init.signal ? AbortSignal.any([controller.signal, init.signal]) : controller.signal;
          const response = await sendOnce(url, headers, body, sendSignal);
          if (!response.ok) {
            controller.abort();
            // Capture already available error evidence when possible; an interrupted body stays unknown.
            try { rawBody = await response.text(); } catch { /* Reservation remains unresolved. */ }
            throw new LedgerError("http-request-rejected");
          }
          // Read before returning to NativeJudge: its decoder substitutes zero for absent usage/cost.
          rawBody = await response.text();
          nativeSettledReply(rawBody, reservation);
          if (controller.signal.aborted || sendSignal.aborted) throw new LedgerError("cancelled-after-response");
          return new Response(rawBody, { status: response.status, headers: response.headers });
        } catch (error) {
          controller.abort();
          gateError = error instanceof LedgerError ? error : new LedgerError("native-send-not-settled");
          throw gateError;
        }
      };
      // Passing one resolved string, never the resolver, prevents SDK withAuth credential rotation.
      let result: JudgmentResult;
      try { result = await createNativeJudge(model, { apiKey, fetch: guardedFetch }).judge(judgment, { signal: controller.signal }); }
      catch { throw gateError ?? new LedgerError("native-completion-failed"); }
      if (gateError) throw gateError;
      if (!reservation || !fetchEntered || rawBody === undefined || controller.signal.aborted) throw new LedgerError("unknown-native-outcome");
      const settled = nativeSettledReply(rawBody, reservation);
      if (!nativeReplyMatches(result, settled.reply)) throw new LedgerError("native-sdk-raw-mismatch");
      const completion = this.#nativeCompletion(reservation, settled, rawBody);
      this.#append({ kind: "native-completed", id, requestHash, reply: snapshot(settled.reply), rawBody,
        rawBodyHash: hash(rawBody), costUsd: settled.costUsd, tariffEstimateUsd: settled.tariffEstimateUsd });
      this.#states.set(id, { reservation, nativeCompletion: completion, uncertain: false });
      return copy(completion);
    } catch (error) {
      if (reservation && !this.#states.get(id)?.nativeCompletion) {
        const knownLiabilityUsd = nativeLiability(rawBody);
        this.#states.set(id, { reservation, uncertain: true, knownLiabilityUsd });
        if (!this.#poisoned) this.#append({ kind: "native-uncertain", id, requestHash, reason: "outcome-unknown",
          ...(knownLiabilityUsd === undefined ? {} : { knownLiabilityUsd }),
          ...(rawBody === undefined ? {} : { rawBody, rawBodyHash: hash(rawBody) }) });
      }
      if (error instanceof LedgerError) throw error;
      throw new LedgerError("native-call-failed");
    } finally {
      controller.abort(); signal?.removeEventListener("abort", abort);
      try {
        if (lockFd !== undefined) {
          closeSync(lockFd);
          if (!this.#poisoned) { unlinkSync(this.#lock); syncDirectory(this.#dir); }
        }
      } catch { this.#poisoned = true; throw new LedgerError("lock-release-failed"); }
      finally { this.#busy = false; }
    }
  }

  async call(models: Models, spec: CallSpec, signal?: AbortSignal): Promise<AssistantMessage> {
    if (this.#busy || this.#poisoned) throw new LedgerError("ledger-unavailable");
    if (!spec.id || !spec.task || !spec.arm || !integer(spec.attempt) || spec.attempt === 0 || !["compress", "judge"].includes(spec.phase)) throw new LedgerError("invalid-call-metadata");
    if (spec.maxTokens !== undefined && (!integer(spec.maxTokens) || spec.maxTokens === 0)) throw new LedgerError("invalid-requested-output");
    // Capture everything before the first await: neither auth nor transforms can
    // observe subsequent mutations of caller-owned model/options/context objects.
    const id = spec.id;
    const authSessionId = models.sessionId;
    const model = copy(spec.model); const context = copy(spec.context);
    const tariff = admitModel(model);
    // Image preparation may run before the SDK fetch override. Admit text before
    // calling the SDK, not merely after its serializer has run.
    if (!Array.isArray(context.messages) || context.messages.length === 0) throw new LedgerError("missing-context");
    for (const message of context.messages) {
      if (message.role !== "user" && message.role !== "assistant") throw new LedgerError("unsupported-context-role");
      textBlocks(message.content);
    }
    if (context.systemPrompt !== undefined && (!Array.isArray(context.systemPrompt) || context.systemPrompt.some(part => typeof part !== "string"))) throw new LedgerError("invalid-system-prompt");
    const resolver = models.registry.resolver(copy(model), authSessionId);
    const transform = spec.options?.onPayload;
    if (spec.payloadBinding !== undefined && !sha(spec.payloadBinding)) throw new LedgerError("invalid-payload-binding");
    if (transform !== undefined && (typeof transform !== "function" || !sha(spec.payloadBinding))) throw new LedgerError("unbound-payload-transform");
    const optionData: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(spec.options ?? {})) {
      if (key === "onPayload" || value === undefined) continue;
      if (!OPTION_KEYS.includes(key)) throw new LedgerError("unsupported-call-option");
      optionData[key] = value;
    }
    const options: SimpleStreamOptions = copy(optionData);
    const sessionId = options.sessionId ?? authSessionId;
    if (!sessionId) throw new LedgerError("missing-session-binding");
    options.sessionId = sessionId;
    if (spec.maxTokens !== undefined) options.maxTokens = spec.maxTokens;
    const bindingValue = snapshot({
      id: spec.id, phase: spec.phase, task: spec.task, arm: spec.arm, attempt: spec.attempt,
      selector: `${model.provider}/${model.id}`, model, context, options,
      requestedMaxTokens: spec.maxTokens ?? null, payloadBinding: spec.payloadBinding ?? null, authSessionId,
      transformHash: transform ? hash(Function.prototype.toString.call(transform)) : null,
      transport: TRANSPORT,
    });
    if (!record(bindingValue)) throw new LedgerError("invalid-binding");
    const binding: JsonRecord = bindingValue;
    const requestHash = hash(canonical(binding));
    this.#busy = true;
    let lockFd: number | undefined;
    let reservation: Reservation | undefined;
    let failedGate = false;
    let gateError: LedgerError | undefined;
    let fetchEntered = false;
    let before: Json | undefined;
    let transformedHash: string | undefined;
    let rawReply: Json | undefined;
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) controller.abort();
    try {
      try { lockFd = openSync(this.#lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
      catch { throw new LedgerError("run-locked-no-speculative-recovery"); }
      writeFileSync(lockFd, `${process.pid}\n`); fsyncSync(lockFd); syncDirectory(this.#dir);
      this.#load();
      if (this.hasUncertain()) throw new LedgerError("unresolved-reservation-no-resume");
      const previous = this.#states.get(id);
      if (previous) {
        if (!previous.completion || previous.reservation.requestHash !== requestHash) throw new LedgerError("resume-request-mismatch");
        const original = copy(previous.reservation.before);
        const transformed = transform ? (await transform(original, copy(model), controller.signal)) ?? original : original;
        if (hash(canonical(transformed)) !== previous.reservation.transformedHash) throw new LedgerError("resume-transform-mismatch");
        if (controller.signal.aborted) throw new LedgerError("cancelled-before-replay");
        return copy(previous.completion.reply);
      }
      if (controller.signal.aborted) throw new LedgerError("cancelled-before-auth");
      let apiKey: string | undefined;
      try { apiKey = await resolveApiKeyOnce(resolver, controller.signal); }
      catch { throw new LedgerError("credential-resolution-failed"); }
      if (!apiKey || apiKey === "N/A") throw new LedgerError("credential-unavailable");
      if (controller.signal.aborted) throw new LedgerError("cancelled-before-request");
      if (this.#sequence === 0) this.#append(this.#header());
      const guardedFetch: FetchImpl = async (input, init) => {
        // Set the latch synchronously, before body reads or durable reservation.
        if (fetchEntered) { failedGate = true; controller.abort(); throw new LedgerError("physical-retry-veto"); }
        fetchEntered = true;
        try {
          if (controller.signal.aborted || init?.signal?.aborted || before === undefined || transformedHash === undefined) throw new LedgerError("cancelled-or-unencoded-request");
          if (input instanceof Request || (typeof input !== "string" && !(input instanceof URL)) || init?.method !== "POST") throw new LedgerError("unsupported-fetch-shape");
          const url = new URL(String(input));
          if (url.origin !== "https://api.anthropic.com" || url.username || url.password || url.pathname !== "/v1/messages" || url.hash || !["", "?beta=true"].includes(url.search)) throw new LedgerError("endpoint-mismatch");
          let body: string;
          if (typeof init.body === "string") body = init.body;
          else if (init.body instanceof Uint8Array) body = new TextDecoder("utf-8", { fatal: true }).decode(init.body);
          else throw new LedgerError("unsupported-body-encoding");
          const payload: unknown = JSON.parse(body);
          const bound = admitPayload(model, payload);
          const inputBound = Math.max(bound.input, Buffer.byteLength(body, "utf8") + FRAMING_TOKENS);
          const reservedUsd = amount(tariff, inputBound, bound.output);
          const headers = new Headers(init.headers);
          headers.set("accept-encoding", "identity");
          headers.delete("transfer-encoding"); headers.delete("content-length"); headers.delete("connection");
          if (headers.has("host") && headers.get("host") !== url.host) throw new LedgerError("host-header-mismatch");
          headers.set("content-length", String(Buffer.byteLength(body, "utf8")));
          const publicHeaders = [...headers.entries()].filter(([key]) => !["authorization", "x-api-key", "cookie", "proxy-authorization"].includes(key));
          const reservedUnits = budgetUnits(reservedUsd, "ceil");
          if (reservedUnits > this.#capUnits - this.#budget().accounted) throw new LedgerError("budget-stop");
          reservation = {
            id, requestHash, request: binding, tariff, before, transformedHash,
            wireHash: hash(canonical({ url: url.href, method: "POST", headers: publicHeaders, body })),
            inputBound, outputBound: bound.output, reservedUsd,
          };
          const reservedEntry = snapshot(reservation);
          if (!record(reservedEntry)) throw new LedgerError("invalid-reservation-record");
          this.#append({ kind: "reserved", ...reservedEntry });
          this.#states.set(id, { reservation, uncertain: false });
          if (controller.signal.aborted || init.signal?.aborted) throw new LedgerError("cancelled-after-reservation");
          const sendSignal = init.signal ? AbortSignal.any([controller.signal, init.signal]) : controller.signal;
          const response = await sendOnce(url, headers, body, sendSignal);
          if (!response.ok) {
            // Fail immediately: the SDK would otherwise honor retry-after before
            // reaching our second-send veto. The paid reservation stays unresolved.
            controller.abort();
            try { await response.body?.cancel(); } catch { /* Aborted transport is already closed. */ }
            throw new LedgerError("http-request-rejected");
          }
          return response;
        } catch (error) {
          failedGate = true; controller.abort();
          gateError = error instanceof LedgerError ? error : new LedgerError("send-not-settled");
          throw gateError;
        }
      };
      let result: AssistantMessage;
      try {
        result = await completeSimple(copy(model), context, {
          ...options, apiKey, signal: controller.signal, fetch: guardedFetch,
          statefulResponses: false, acceptEmptyResponse: true,
          onPayload: async payload => {
            if (fetchEntered || before !== undefined) { failedGate = true; controller.abort(); throw new LedgerError("encoding-retry-veto"); }
            before = snapshot(payload);
            const ownPayload = copy(before);
            const transformed = transform ? (await transform(ownPayload, copy(model), controller.signal)) ?? ownPayload : ownPayload;
            const owned = snapshot(transformed);
            admitPayload(model, owned);
            transformedHash = hash(canonical(owned));
            return copy(owned);
          },
        });
      } catch { throw new LedgerError("completion-failed"); }
      // Preserve provider evidence even when later validation cannot establish a
      // complete bill. It stays private and never releases an unknown reservation.
      rawReply = snapshot(result);
      if (gateError) throw gateError;
      if (!reservation || !fetchEntered || failedGate || controller.signal.aborted) throw new LedgerError("unknown-call-outcome");
      const settled = settledReply(result, reservation);
      const completion = this.#completion(reservation, settled.reply, settled.costUsd, rawReply);
      this.#append({ kind: "completed", id, requestHash, reply: snapshot(settled.reply), rawReply, costUsd: settled.costUsd });
      this.#states.set(id, { reservation, completion, uncertain: false });
      return copy(settled.reply);
    } catch (error) {
      if (reservation && !this.#states.get(id)?.completion) {
        const knownLiabilityUsd = error instanceof BoundBreach ? error.knownLiabilityUsd : undefined;
        this.#states.set(id, { reservation, uncertain: true, knownLiabilityUsd });
        if (!this.#poisoned) this.#append({ kind: "uncertain", id, requestHash, reason: "outcome-unknown", ...(knownLiabilityUsd === undefined ? {} : { knownLiabilityUsd }), ...(rawReply === undefined ? {} : { rawReply }) });
      }
      if (error instanceof LedgerError) throw error;
      throw new LedgerError("call-failed");
    } finally {
      controller.abort(); signal?.removeEventListener("abort", abort);
      try {
        if (lockFd !== undefined) {
          closeSync(lockFd);
          // Leave crash/torn-write locks in place; only this live owner releases its lock.
          if (!this.#poisoned) { unlinkSync(this.#lock); syncDirectory(this.#dir); }
        }
      } catch { this.#poisoned = true; throw new LedgerError("lock-release-failed"); }
      finally { this.#busy = false; }
    }
  }
}
