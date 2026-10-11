import type { ChildStatus, ChildTaskOutcome, ChildUsage } from "./child.ts";
import { MAX_SOURCES, MIN_SOURCES, QUESTION_KINDS, type QuestionKind } from "./corpus.ts";
import { MAX_CALLS, MAX_COMPRESSOR_OUTPUT_TOKENS, MAX_DEADLINE_MS, MAX_EXPIRY_WAIT_MS, type QuestionEmphasis } from "./plan.ts";
import { ARMS, EXPERIMENTS, MAX_COST_USD, MAX_VIEW_BYTES, MIN_MAIN_CONTEXT_WINDOW, MIN_VIEW_BYTES, TURN_MODES, type Arm, type Experiment, type TurnMode } from "./options.ts";
import { isRecord, type ArmTotals, type Failure } from "./scoring.ts";

/** Versioned evidence artifact: observed counters only; unknown values stay null, never zero. */
export const ARTIFACT_SCHEMA = "optchat-evidence-recall/3";

/** `auxiliary` is off-transcript session model usage (provider-reported, both arms). */
export type Role = "main" | "compressor" | "auxiliary" | "maintenance";

export interface Price {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
}

export interface UsageRecord {
	readonly role: Role;
	readonly purpose: string;
	readonly input: number | null;
	readonly output: number | null;
	readonly cacheRead: number | null;
	readonly cacheWrite: number | null;
	/**
	 * SDK-reported cost, or a catalog estimate from list prices. Neither is a provider invoice:
	 * the SDK figure is its own accounting and the estimate applies published list rates.
	 */
	readonly costUsd: number | null;
	readonly costSource: "sdk-reported" | "catalog-estimate" | "unavailable";
	readonly latencyMs: number | null;
}

/** `estimated-from-compaction-result` is only ever the source of a maintenance summary's interval. */
export type CostSource = "none" | "sdk-reported" | "catalog-estimate" | "mixed" | "unavailable" | "estimated-from-compaction-result";

/** Minimum distinct saved tree-node levels (levels >= 1) for the merge-depth requirement. */
export const MIN_TREE_LEVELS = 2;

export interface UsageSummary {
	readonly calls: number;
	/** Provider `input` is NON-cached input tokens. */
	readonly input: number | null;
	readonly output: number | null;
	readonly cacheRead: number | null;
	readonly cacheWrite: number | null;
	/** input + cacheRead + cacheWrite; null when any component is unobserved. */
	readonly promptTokens: number | null;
	/** Null with no calls (nothing was observed) and whenever any call's cost is unobserved. */
	readonly costUsd: number | null;
	readonly costSource: CostSource;
	readonly latencyMsTotal: number | null;
	/** True only when every token counter and the cost are observed for every call. */
	readonly complete: boolean;
}

function total(records: readonly UsageRecord[], pick: (record: UsageRecord) => number | null): number | null {
	let sum = 0;
	for (const record of records) {
		const value = pick(record);
		if (value === null) return null;
		sum += value;
	}
	return sum;
}

export function summarizeUsage(records: readonly UsageRecord[]): UsageSummary {
	const input = total(records, (record) => record.input);
	const output = total(records, (record) => record.output);
	const cacheRead = total(records, (record) => record.cacheRead);
	const cacheWrite = total(records, (record) => record.cacheWrite);
	const promptTokens = input === null || cacheRead === null || cacheWrite === null ? null : input + cacheRead + cacheWrite;
	const costUsd = records.length === 0 ? null : total(records, (record) => record.costUsd);
	const sources = new Set(records.map((record) => record.costSource));
	let costSource: CostSource = "none";
	if (records.length > 0) {
		if (sources.size > 1) costSource = sources.has("unavailable") ? "unavailable" : "mixed";
		else costSource = records[0]!.costSource;
	}
	return {
		calls: records.length,
		input,
		output,
		cacheRead,
		cacheWrite,
		promptTokens,
		costUsd,
		costSource,
		latencyMsTotal: total(records, (record) => record.latencyMs),
		complete: [input, output, cacheRead, cacheWrite, costUsd].every((value) => value !== null),
	};
}

/** Catalog estimate from list prices per million tokens; null when any counter is unobserved. */
export function estimateCostUsd(usage: Pick<UsageRecord, "input" | "output" | "cacheRead" | "cacheWrite">, price: Price): number | null {
	const { input, output, cacheRead, cacheWrite } = usage;
	if (input === null || output === null || cacheRead === null || cacheWrite === null) return null;
	return (input * price.input + output * price.output + cacheRead * price.cacheRead + cacheWrite * price.cacheWrite) / 1_000_000;
}

/** A USD interval. `lowUsd` and `highUsd` bracket every value consistent with the observations; a point value has low equal to high. */
export interface CostInterval {
	readonly lowUsd: number;
	readonly highUsd: number;
}

/** An arm's total cost. `estimated` is true exactly when maintenance was estimated from compaction results. */
export interface ArmTotalCost extends CostInterval {
	readonly estimated: boolean;
}

/**
 * Native compaction (maintenance) summary. OMP 18.9.0 does not meter compaction, so token counters and the point cost are
 * null whenever compactions > 0; the cost is the interval `costUsdLow`..`costUsdHigh` from the per-compaction estimate, or
 * null with a `reason`. Zero compactions is observed zero: counters 0, cost 0, complete, interval 0..0, not estimated.
 */
export interface MaintenanceSummary extends UsageSummary {
	/** Equals `calls`: one native compaction per call. */
	readonly compactions: number;
	readonly estimated: boolean;
	readonly costUsdLow: number | null;
	readonly costUsdHigh: number | null;
	/** Why the interval is unobserved; null when there are no compactions or the estimate is present. */
	readonly reason: string | null;
}

/** Builds a maintenance summary from the compaction count and its interval estimate (null when unobserved). */
export function maintenanceSummary(args: { readonly compactions: number; readonly interval: CostInterval | null; readonly reason?: string }): MaintenanceSummary {
	const { compactions, interval } = args;
	if (compactions === 0) {
		return {
			calls: 0,
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			promptTokens: 0,
			costUsd: 0,
			costSource: "none",
			latencyMsTotal: null,
			complete: true,
			compactions: 0,
			estimated: false,
			costUsdLow: 0,
			costUsdHigh: 0,
			reason: null,
		};
	}
	const estimated = interval !== null;
	return {
		calls: compactions,
		input: null,
		output: null,
		cacheRead: null,
		cacheWrite: null,
		promptTokens: null,
		costUsd: null,
		costSource: estimated ? "estimated-from-compaction-result" : "unavailable",
		latencyMsTotal: null,
		complete: false,
		compactions,
		estimated,
		costUsdLow: interval?.lowUsd ?? null,
		costUsdHigh: interval?.highUsd ?? null,
		reason: estimated ? null : (args.reason ?? "compaction cost unobserved"),
	};
}

/** Per-role cache-read shares; each is that role's own counters, null when unobserved or without prompt tokens. */
export interface RoleCacheReadShares {
	readonly main: number | null;
	readonly compressor: number | null;
	readonly auxiliary: number | null;
}

/** One arm's side of a paired comparison. Unobserved values are null; an unavailable side carries its reason. */
export interface ArmSide {
	readonly status: "completed" | "unavailable";
	readonly reason: string | null;
	readonly main: UsageSummary | null;
	readonly compressor: UsageSummary | null;
	/** Null when the session model usage was not collected; a null role leaves `totalCost` null. */
	readonly auxiliary: UsageSummary | null;
	readonly maintenance: MaintenanceSummary;
	/** Null exactly when some role is unobserved (null summary, unobserved cost, or unobserved maintenance interval). */
	readonly totalCost: ArmTotalCost | null;
	/** Why `totalCost` is null; null exactly when `totalCost` is present. */
	readonly totalCostReason: string | null;
	readonly totalPromptTokens: number | null;
	/** Cache-read share over every role; null when maintenance is estimated or unobserved, or any counter is unobserved. */
	readonly cacheReadShare: number | null;
	readonly cacheReadShareByRole: RoleCacheReadShares;
	/** Headline metric: main-model cache share over turns after the first (per-question mode). Independent of maintenance. */
	readonly mainSteadyStateCacheReadShare: number | null;
	readonly latencyMsPerTurn: readonly (number | null)[];
	readonly accuracy: ArmTotals | null;
}

/**
 * Paired difference. Costs are off-minus-on intervals: a positive value means the `on` arm cost less. Shares and
 * accuracy are on-minus-off. A share is null when either side did not observe it.
 */
export interface Delta {
	/** Interval bracketing every off-minus-on difference: low = offLow - onHigh, high = offHigh - onLow. */
	readonly totalCost: CostInterval;
	readonly cacheReadShare: number | null;
	readonly mainSteadyStateCacheReadShare: number | null;
	readonly accuracy: { readonly correct: number; readonly valueCorrect: number; readonly grounded: number; readonly hallucinated: number } | null;
}

export interface PairedComparison {
	readonly compressor: string;
	readonly on: ArmSide;
	readonly off: ArmSide;
	/** Present only when both sides completed and both totals are observed. */
	readonly delta: Delta | null;
	/** Why no delta was computed; null exactly when `delta` is present. */
	readonly reason: string | null;
}

/**
 * Cache-read share over summed counters: sum(cacheRead) / sum(promptTokens). An unobserved counter makes the share null, as
 * do an empty list and zero prompt tokens. A maintenance summary with compactions has null counters, so an estimated or
 * unobserved maintenance nulls the share; zero compactions contributes observed zeros.
 */
export function armCacheReadShare(usages: readonly UsageSummary[]): number | null {
	if (usages.length === 0) return null;
	let cacheRead = 0;
	let promptTokens = 0;
	for (const usage of usages) {
		if (usage.cacheRead === null || usage.promptTokens === null) return null;
		cacheRead += usage.cacheRead;
		promptTokens += usage.promptTokens;
	}
	return promptTokens === 0 ? null : cacheRead / promptTokens;
}

/** One role's cache-read share over its own counters; null when the role is absent or unobserved. */
export function roleCacheReadShare(usage: UsageSummary | null): number | null {
	return usage === null ? null : armCacheReadShare([usage]);
}

/** Headline steady-state share: main-model cache share over turns after the first (per-question mode). Null with fewer than two turns. */
export function mainSteadyStateCacheReadShare(turns: readonly UsageSummary[]): number | null {
	return turns.length < 2 ? null : armCacheReadShare(turns.slice(1));
}

/**
 * An arm's total cost interval. Main, compressor, and auxiliary sum exactly (point values); maintenance adds its interval
 * when estimated. A role with no calls costs zero. A null role summary, an unobserved cost, or an unobserved maintenance
 * interval makes the total null.
 */
export function armTotalCost(parts: {
	readonly main: UsageSummary | null;
	readonly compressor: UsageSummary | null;
	readonly auxiliary: UsageSummary | null;
	readonly maintenance: MaintenanceSummary;
}): ArmTotalCost | null {
	let lowUsd = 0;
	let highUsd = 0;
	for (const usage of [parts.main, parts.compressor, parts.auxiliary]) {
		if (usage === null) return null;
		if (usage.calls === 0) continue;
		if (usage.costUsd === null) return null;
		lowUsd += usage.costUsd;
		highUsd += usage.costUsd;
	}
	const { maintenance } = parts;
	if (maintenance.compactions > 0) {
		if (!maintenance.estimated || maintenance.costUsdLow === null || maintenance.costUsdHigh === null) return null;
		lowUsd += maintenance.costUsdLow;
		highUsd += maintenance.costUsdHigh;
	}
	return { lowUsd, highUsd, estimated: maintenance.estimated };
}

/**
 * Builds one compressor's comparison. A delta requires both sides completed with an observed total; otherwise the reason
 * says why. Costs are off-minus-on intervals; shares and accuracy are on-minus-off.
 */
export function pairedComparison(input: { readonly compressor: string; readonly on: ArmSide; readonly off: ArmSide }): PairedComparison {
	const { compressor, on, off } = input;
	const reasons: string[] = [];
	for (const [label, side] of [["on", on], ["off", off]] as const) {
		if (side.status !== "completed") reasons.push(`${label} arm unavailable${side.reason === null ? "" : `: ${side.reason}`}`);
		else if (side.totalCost === null) reasons.push(`${label} arm cost unobserved${side.totalCostReason === null ? "" : `: ${side.totalCostReason}`}`);
	}
	const onCost = on.totalCost;
	const offCost = off.totalCost;
	if (reasons.length > 0 || onCost === null || offCost === null) return { compressor, on, off, delta: null, reason: reasons.join("; ") };
	const accuracy =
		on.accuracy === null || off.accuracy === null
			? null
			: {
					correct: on.accuracy.correct - off.accuracy.correct,
					valueCorrect: on.accuracy.valueCorrect - off.accuracy.valueCorrect,
					grounded: on.accuracy.grounded - off.accuracy.grounded,
					hallucinated: on.accuracy.hallucinated - off.accuracy.hallucinated,
				};
	const delta: Delta = {
		totalCost: { lowUsd: offCost.lowUsd - onCost.highUsd, highUsd: offCost.highUsd - onCost.lowUsd },
		cacheReadShare: on.cacheReadShare === null || off.cacheReadShare === null ? null : on.cacheReadShare - off.cacheReadShare,
		mainSteadyStateCacheReadShare:
			on.mainSteadyStateCacheReadShare === null || off.mainSteadyStateCacheReadShare === null
				? null
				: on.mainSteadyStateCacheReadShare - off.mainSteadyStateCacheReadShare,
		accuracy,
	};
	return { compressor, on, off, delta, reason: null };
}

/** One child arm's grades and usage. `childUsage` is the child's own run usage, null when the host reported none. */
export interface ChildArmSummary {
	readonly tasks: readonly ChildTaskOutcome[];
	readonly parentUsage: UsageSummary;
	readonly childUsage: ChildUsage | null;
	readonly callsObserved: number;
}

/** The #13 child-memory experiment: `view` and `blind` arms; `reason` explains a null arm. */
export interface ChildReport {
	readonly arms: { readonly view: ChildArmSummary | null; readonly blind: ChildArmSummary | null };
	readonly reason: string | null;
}

const FORBIDDEN_KEY = /^(?:api[-_]?keys?|authorization|headers?|credentials?|secrets?|access[-_]?tokens?|refresh[-_]?tokens?|passwords?)$/i;
/** Savings and billing are never claimed by this artifact. Every key is checked, interval keys included. */
const CLAIM_KEY = /saving|saved|savings|bill|invoice/i;
/** Deltas are signed differences (off minus on for costs), so their negative values are real. Nothing else is exempt. */
const SIGNED_DELTA_PATH = /^\$\.paired\[\d+\]\.delta(?:\.|$)/;
const ROLES = ["main", "compressor", "auxiliary", "maintenance"] as const;
const RECORD_COST_SOURCES = ["sdk-reported", "catalog-estimate", "unavailable"] as const;
const CHILD_COST_SOURCES = ["sdk-reported", "unavailable"] as const;
const CHILD_STATUSES: readonly ChildStatus[] = ["completed", "not-delegated", "incomplete", "failed", "refused"];
const RUN_STATUSES = ["completed", "budget-stopped", "failed", "blocked", "not-run"] as const;
const SCENARIO_STATUSES = ["completed", "not-run", "budget-stopped", "failed"] as const;
const COST_SOURCES: readonly CostSource[] = ["none", "sdk-reported", "catalog-estimate", "mixed", "unavailable", "estimated-from-compaction-result"];
const TOKEN_KEYS = ["input", "output", "cacheRead", "cacheWrite", "promptTokens"] as const;
const ENFORCEMENTS = ["prompt-admission", "host-admission"] as const;
const COST_ENFORCEMENTS = ["dollar-admission", "none"] as const;
const OUTCOMES = ["correct", "abstained", "incorrect", "hallucinated"] as const;
const FAILURES: readonly Failure[] = ["schema", "no-answer", "ungrounded", "wrong-value", "forbidden-value", "fabricated-id", "fabricated-citation", "ambiguous-confident", "ambiguous-incomplete", "unanswerable-asserted"];
const REFUSALS = ["maxCalls", "deadline", "cost-cap", "unknown-cost"] as const;
const QUESTION_EMPHASES: readonly QuestionEmphasis[] = ["balanced", "adversarial"];
const ARM_STATUSES = ["completed", "unavailable"] as const;
const ACCURACY_KEYS = ["judged", "correct", "valueCorrect", "grounded", "abstained", "hallucinated", "incorrectSchema"] as const;
const DELTA_ACCURACY_KEYS = ["correct", "valueCorrect", "grounded", "hallucinated"] as const;

function isCount(node: unknown): boolean {
	return typeof node === "number" && Number.isSafeInteger(node) && node >= 0;
}

function isNullableCount(node: unknown): boolean {
	return node === null || isCount(node);
}

function isNullableMetric(node: unknown): boolean {
	return node === null || (typeof node === "number" && Number.isFinite(node) && node >= 0);
}

function isNullableFraction(node: unknown): boolean {
	return node === null || (typeof node === "number" && Number.isFinite(node) && node >= 0 && node <= 1);
}

function isNullableString(node: unknown): boolean {
	return node === null || typeof node === "string";
}

/** Any credential-shaped key, savings or billing claim, negative number, or non-finite number anywhere in the artifact. Signed delta values are exempt from the sign rule only. */
function walkClaims(node: unknown, path: string, errors: string[]): void {
	if (typeof node === "number") {
		if (!Number.isFinite(node)) errors.push(`${path}: non-finite number`);
		else if (node < 0 && !SIGNED_DELTA_PATH.test(path)) errors.push(`${path}: negative metric`);
		return;
	}
	if (Array.isArray(node)) {
		node.forEach((entry, index) => walkClaims(entry, `${path}[${index}]`, errors));
		return;
	}
	if (!isRecord(node)) return;
	for (const [key, entry] of Object.entries(node)) {
		if (FORBIDDEN_KEY.test(key)) errors.push(`${path}.${key}: credential-shaped field is forbidden`);
		if (CLAIM_KEY.test(key)) errors.push(`${path}.${key}: savings and billing claims are forbidden; costs are provider-reported or catalog estimates`);
		walkClaims(entry, `${path}.${key}`, errors);
	}
}

/** An interval is finite and ordered (low <= high); bounds are non-negative unless signed (cost deltas are off-minus-on). */
function validateInterval(lowUsd: unknown, highUsd: unknown, path: string, errors: string[], signed: boolean): void {
	if (typeof lowUsd !== "number" || typeof highUsd !== "number" || !Number.isFinite(lowUsd) || !Number.isFinite(highUsd)) {
		errors.push(`${path} bounds must be finite numbers`);
		return;
	}
	if (!signed && (lowUsd < 0 || highUsd < 0)) errors.push(`${path} bounds must be non-negative`);
	if (lowUsd > highUsd) errors.push(`${path}.lowUsd must not exceed highUsd`);
}

function validateUsage(node: unknown, path: string, errors: string[]): void {
	if (!isRecord(node)) {
		errors.push(`${path} must be a usage summary`);
		return;
	}
	if (!isCount(node.calls)) errors.push(`${path}.calls must be a non-negative integer`);
	for (const key of ["input", "output", "cacheRead", "cacheWrite", "promptTokens"]) {
		if (!isNullableCount(node[key])) errors.push(`${path}.${key} must be a non-negative integer or null`);
	}
	if (!isNullableMetric(node.costUsd)) errors.push(`${path}.costUsd must be a non-negative number or null`);
	if (!isNullableMetric(node.latencyMsTotal)) errors.push(`${path}.latencyMsTotal must be a non-negative number or null`);
	if (typeof node.complete !== "boolean") errors.push(`${path}.complete must be a boolean`);
	if (!COST_SOURCES.includes(node.costSource as CostSource)) errors.push(`${path}.costSource must be one of ${COST_SOURCES.join(", ")}`);
	if (errors.some((error) => error.startsWith(`${path}.`))) return;

	const { calls, input, output, cacheRead, cacheWrite, promptTokens, costUsd, costSource, complete } = node as {
		calls: number;
		input: number | null;
		output: number | null;
		cacheRead: number | null;
		cacheWrite: number | null;
		promptTokens: number | null;
		costUsd: number | null;
		costSource: CostSource;
		complete: boolean;
	};
	const expectedPrompt = input === null || cacheRead === null || cacheWrite === null ? null : input + cacheRead + cacheWrite;
	if (promptTokens !== expectedPrompt) errors.push(`${path}.promptTokens must equal input + cacheRead + cacheWrite, or be null when any part is null`);
	if (complete !== [input, output, cacheRead, cacheWrite, costUsd].every((value) => value !== null)) errors.push(`${path}.complete does not match observed counters`);
	if ((calls === 0) !== (costSource === "none")) errors.push(`${path}.costSource "none" applies exactly when there are no calls`);
	if ((costUsd === null) !== (costSource === "none" || costSource === "unavailable")) {
		errors.push(`${path}.costUsd is null exactly when costSource is "none" or "unavailable"`);
	}
}

function validateCompressor(node: unknown, path: string, errors: string[]): void {
	if (!isRecord(node)) {
		errors.push(`${path} must be a compressor usage summary or an unavailable marker`);
		return;
	}
	if (node.status === "unavailable") {
		if (typeof node.reason !== "string" || node.reason.length === 0) errors.push(`${path}.reason is required when unavailable`);
		if ("calls" in node) errors.push(`${path} must not report calls when unavailable`);
		return;
	}
	validateUsage(node, path, errors);
	if (!isRecord(node.purposes) || !Object.values(node.purposes).every(isCount)) errors.push(`${path}.purposes must map purposes to non-negative integers`);
	if (!isCount(node.maxAttempt) && node.maxAttempt !== null) errors.push(`${path}.maxAttempt must be a non-negative integer or null`);
	// Attempts are the admission ledger (including failed and shutdown work); observed are completed metric lines.
	if (!isCount(node.attempted) || !isCount(node.observed)) errors.push(`${path}.attempted and observed must be non-negative integers`);
	else if ((node.observed as number) > (node.attempted as number)) errors.push(`${path}.observed cannot exceed attempted`);
	else if (node.unobserved !== (node.attempted as number) - (node.observed as number)) errors.push(`${path}.unobserved must equal attempted minus observed`);
}

/**
 * Maintenance (native compaction) summary. Zero compactions is observed zero: counters 0, cost 0, complete. With
 * compactions, token counters and the point cost are null; the cost is only the per-compaction interval estimate, or null
 * with a reason.
 */
function validateMaintenance(node: unknown, path: string, errors: string[]): void {
	if (!isRecord(node)) {
		errors.push(`${path} must be a maintenance summary`);
		return;
	}
	if (!isCount(node.calls)) errors.push(`${path}.calls must be a non-negative integer`);
	if (!isCount(node.compactions) || node.compactions !== node.calls) errors.push(`${path}.compactions must equal calls`);
	if (typeof node.estimated !== "boolean") errors.push(`${path}.estimated must be a boolean`);
	if (node.latencyMsTotal !== null) errors.push(`${path}.latencyMsTotal must be null: compaction latency is not measured`);
	if (errors.some((error) => error.startsWith(`${path}.`))) return;
	if (node.compactions === 0) {
		for (const key of TOKEN_KEYS) {
			if (node[key] !== 0) errors.push(`${path}.${key} must be 0 with no compactions`);
		}
		const observedZero = node.costUsd === 0 && node.complete === true && node.costSource === "none";
		if (!observedZero || node.estimated !== false || node.costUsdLow !== 0 || node.costUsdHigh !== 0 || node.reason !== null) {
			errors.push(`${path} with no compactions is observed zero: cost 0, complete, costSource none, estimated false, interval 0..0, reason null`);
		}
		return;
	}
	if (node.complete !== false) errors.push(`${path}.complete must be false: compaction tokens are never metered`);
	if (node.costUsd !== null) errors.push(`${path}.costUsd must be null: compaction reports an interval, not a point cost`);
	for (const key of TOKEN_KEYS) {
		if (node[key] !== null) errors.push(`${path}.${key} must be null: compaction tokens are not metered`);
	}
	if (node.estimated === true) {
		if (node.costSource !== "estimated-from-compaction-result") errors.push(`${path}.costSource must be estimated-from-compaction-result when estimated`);
		if (node.reason !== null) errors.push(`${path}.reason must be null when estimated`);
		validateInterval(node.costUsdLow, node.costUsdHigh, `${path}.interval`, errors, false);
	} else {
		if (node.costSource !== "unavailable") errors.push(`${path}.costSource must be unavailable when the estimate is unobserved`);
		if (node.costUsdLow !== null || node.costUsdHigh !== null) errors.push(`${path} unobserved interval must be null`);
		if (typeof node.reason !== "string" || node.reason.length === 0) errors.push(`${path}.reason is required when the estimate is unobserved`);
	}
}

function validateTree(node: unknown, path: string, errors: string[]): void {
	if (node === null) return;
	if (!isRecord(node)) {
		errors.push(`${path} must be null or a tree summary`);
		return;
	}
	if (!Array.isArray(node.levels) || !node.levels.every(isCount)) errors.push(`${path}.levels must be non-negative integers`);
	if (!isCount(node.mainParts)) errors.push(`${path}.mainParts must be a non-negative integer`);
	if (!isCount(node.compactorParts)) errors.push(`${path}.compactorParts must be a non-negative integer`);
	if (typeof node.depthRequirementMet !== "boolean") errors.push(`${path}.depthRequirementMet must be a boolean`);
	else if (Array.isArray(node.levels) && node.depthRequirementMet !== (new Set(node.levels).size >= MIN_TREE_LEVELS)) {
		errors.push(`${path}.depthRequirementMet must be true exactly when at least ${MIN_TREE_LEVELS} distinct tree levels were observed`);
	}
}

function validateQuestion(node: unknown, path: string, errors: string[]): void {
	if (!isRecord(node)) {
		errors.push(`${path} must be an object`);
		return;
	}
	if (typeof node.id !== "string") errors.push(`${path}.id must be a string`);
	if (!QUESTION_KINDS.includes(node.kind as QuestionKind)) errors.push(`${path}.kind is not a known question kind`);
	if (node.status !== "judged" && node.status !== "unavailable") errors.push(`${path}.status must be judged or unavailable`);
	if (!isNullableString(node.reason) || !isNullableString(node.answerPreview)) errors.push(`${path}.reason and answerPreview must be strings or null`);
	for (const key of ["correct", "valueCorrect", "grounded", "hallucinated", "abstained", "zoomedSourceRecord"]) {
		if (node[key] !== null && typeof node[key] !== "boolean") errors.push(`${path}.${key} must be a boolean or null`);
	}
	for (const key of ["zoomCalls", "maxZoomN", "zoomDepth", "latencyMs"]) {
		if (!isNullableCount(node[key])) errors.push(`${path}.${key} must be a non-negative integer or null`);
	}
	if (node.outcome !== null && !OUTCOMES.includes(node.outcome as (typeof OUTCOMES)[number])) errors.push(`${path}.outcome must be a judged outcome or null`);
	if (node.failure !== null && !FAILURES.includes(node.failure as Failure)) errors.push(`${path}.failure must be a scoring failure or null`);
	if (node.status === "judged") {
		const booleans = ["correct", "valueCorrect", "grounded", "hallucinated", "abstained"].every((key) => typeof node[key] === "boolean");
		if (!booleans || node.outcome === null) errors.push(`${path} is judged but lacks boolean verdicts or an outcome`);
		if (node.reason !== null) errors.push(`${path}.reason must be null when judged`);
	}
	if (node.status === "unavailable") {
		if (typeof node.reason !== "string" || node.reason.length === 0) errors.push(`${path}.reason is required when unavailable`);
		if (node.correct !== null || node.valueCorrect !== null || node.outcome !== null) errors.push(`${path} must not carry verdicts when unavailable`);
	}
}

/** One per-question turn (per-question mode only); `usage` is that turn's main-model usage. */
function validateTurn(node: unknown, path: string, errors: string[]): void {
	if (!isRecord(node)) {
		errors.push(`${path} must be an object`);
		return;
	}
	if (!isNullableString(node.questionId)) errors.push(`${path}.questionId must be a string or null`);
	if (!isNullableMetric(node.latencyMs)) errors.push(`${path}.latencyMs must be a non-negative number or null`);
	validateUsage(node.usage, `${path}.usage`, errors);
}

function validatePhase(node: unknown, path: string, errors: string[], turnMode: unknown): void {
	if (!isRecord(node)) {
		errors.push(`${path} must be an object`);
		return;
	}
	if (typeof node.name !== "string" || typeof node.model !== "string") errors.push(`${path}.name and model must be strings`);
	if (!ARMS.includes(node.arm as Arm)) errors.push(`${path}.arm must be on or off`);
	if (!isNullableString(node.compressor)) errors.push(`${path}.compressor must be a string or null`);
	if (!isNullableString(node.error)) errors.push(`${path}.error must be a string or null`);
	if (node.refusal !== null && !REFUSALS.includes(node.refusal as (typeof REFUSALS)[number])) errors.push(`${path}.refusal must be maxCalls, deadline, cost-cap, unknown-cost, or null`);
	if (!isNullableMetric(node.latencyMs)) errors.push(`${path}.latencyMs must be a non-negative number or null`);
	if (!isRecord(node.usage)) {
		errors.push(`${path}.usage is required`);
	} else {
		validateUsage(node.usage.main, `${path}.usage.main`, errors);
		validateCompressor(node.usage.compressor, `${path}.usage.compressor`, errors);
		validateUsage(node.usage.auxiliary, `${path}.usage.auxiliary`, errors);
	}
	validateMaintenance(node.maintenance, `${path}.maintenance`, errors);
	if (!Array.isArray(node.turns)) {
		errors.push(`${path}.turns must be an array`);
	} else {
		node.turns.forEach((turn, index) => validateTurn(turn, `${path}.turns[${index}]`, errors));
		if (turnMode === "batch" && node.turns.length > 0) errors.push(`${path}.turns must be empty in batch turn mode`);
	}
	if (node.timestamps !== null) {
		const timestamps = isRecord(node.timestamps) ? node.timestamps : {};
		if (!isCount(timestamps.records) || !isCount(timestamps.matched) || (timestamps.matched as number) > (timestamps.records as number)) {
			errors.push(`${path}.timestamps must be null or {records, matched} with matched <= records`);
		}
	}
	if (!Array.isArray(node.questions)) errors.push(`${path}.questions must be an array`);
	else node.questions.forEach((entry, index) => validateQuestion(entry, `${path}.questions[${index}]`, errors));
	validateTree(node.tree, `${path}.tree`, errors);
}

function validateScenario(node: unknown, path: string, errors: string[], turnMode: unknown): void {
	if (!isRecord(node)) {
		errors.push(`${path} must be an object`);
		return;
	}
	if (typeof node.name !== "string" || node.name.length === 0) errors.push(`${path}.name must be a non-empty string`);
	if (!SCENARIO_STATUSES.includes(node.status as (typeof SCENARIO_STATUSES)[number])) errors.push(`${path}.status must be one of ${SCENARIO_STATUSES.join(", ")}`);
	if (!isNullableString(node.reason)) errors.push(`${path}.reason must be a string or null`);
	if (!Array.isArray(node.phases)) {
		errors.push(`${path}.phases must be an array`);
		return;
	}
	if (node.status === "completed" && node.phases.length === 0) errors.push(`${path} is completed but has no phases`);
	node.phases.forEach((phase, index) => validatePhase(phase, `${path}.phases[${index}]`, errors, turnMode));
}

function validateCorpus(node: unknown, path: string, errors: string[]): void {
	if (!isRecord(node)) {
		errors.push(`${path} must be an object`);
		return;
	}
	if (typeof node.version !== "string") errors.push(`${path}.version must be a string`);
	if (!isCount(node.seed)) errors.push(`${path}.seed must be a non-negative integer`);
	if (typeof node.digest !== "string" || !/^[0-9a-f]{64}$/.test(node.digest)) errors.push(`${path}.digest must be a sha256 hex digest`);
	if (!isCount(node.sources) || (node.sources as number) < MIN_SOURCES || (node.sources as number) > MAX_SOURCES) {
		errors.push(`${path}.sources must be an integer from ${MIN_SOURCES} to ${MAX_SOURCES}`);
	}
	if (!isCount(node.minSourceBytes)) errors.push(`${path}.minSourceBytes must be a non-negative integer`);
	if (!isCount(node.questionsTotal) || !isCount(node.questionsSelected) || (node.questionsSelected as number) > (node.questionsTotal as number)) {
		errors.push(`${path}.questionsSelected must be a non-negative integer no greater than questionsTotal`);
	}
}

function validateLimits(node: unknown, path: string, errors: string[]): void {
	if (!isRecord(node)) {
		errors.push(`${path} must be an object`);
		return;
	}
	const bounded = (value: unknown, max: number): boolean => Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= max;
	if (!bounded(node.maxCalls, MAX_CALLS)) errors.push(`${path}.maxCalls must be an integer from 1 to ${MAX_CALLS}`);
	if (!bounded(node.maxCompressorOutputTokens, MAX_COMPRESSOR_OUTPUT_TOKENS)) errors.push(`${path}.maxCompressorOutputTokens must be an integer from 1 to ${MAX_COMPRESSOR_OUTPUT_TOKENS}`);
	if (!bounded(node.deadlineMs, MAX_DEADLINE_MS)) errors.push(`${path}.deadlineMs must be an integer from 1 to ${MAX_DEADLINE_MS}`);
	if (node.expiryWaitMs !== null && !bounded(node.expiryWaitMs, MAX_EXPIRY_WAIT_MS)) errors.push(`${path}.expiryWaitMs must be null or an integer from 1 to ${MAX_EXPIRY_WAIT_MS}`);
	if (!ENFORCEMENTS.includes(node.enforcement as (typeof ENFORCEMENTS)[number])) errors.push(`${path}.enforcement must be prompt-admission or host-admission`);
	if (!isCount(node.callsUsed)) errors.push(`${path}.callsUsed must be a non-negative integer`);
	if (!Array.isArray(node.violations) || !node.violations.every((entry) => typeof entry === "string")) errors.push(`${path}.violations must be a string array`);
	if (node.maxCostUsd !== null && !(typeof node.maxCostUsd === "number" && node.maxCostUsd > 0 && node.maxCostUsd <= MAX_COST_USD)) {
		errors.push(`${path}.maxCostUsd must be null or a number above 0 and at most ${MAX_COST_USD}`);
	}
	if (!isNullableMetric(node.spentUsd)) errors.push(`${path}.spentUsd must be a non-negative number or null`);
	if (!COST_ENFORCEMENTS.includes(node.costEnforcement as (typeof COST_ENFORCEMENTS)[number])) errors.push(`${path}.costEnforcement must be dollar-admission or none`);
}

function validateArmTotals(node: unknown, path: string, errors: string[]): void {
	if (!isRecord(node)) {
		errors.push(`${path} must be an accuracy object or null`);
		return;
	}
	for (const key of ACCURACY_KEYS) {
		if (!isCount(node[key])) errors.push(`${path}.${key} must be a non-negative integer`);
	}
}

function validateRoleShares(node: unknown, path: string, errors: string[]): void {
	if (!isRecord(node)) {
		errors.push(`${path} must be an object`);
		return;
	}
	for (const role of ["main", "compressor", "auxiliary"] as const) {
		if (!isNullableFraction(node[role])) errors.push(`${path}.${role} must be a fraction from 0 to 1 or null`);
	}
}

function validateArmSide(node: unknown, path: string, errors: string[]): void {
	if (!isRecord(node)) {
		errors.push(`${path} must be an arm side`);
		return;
	}
	const before = errors.length;
	if (!ARM_STATUSES.includes(node.status as (typeof ARM_STATUSES)[number])) errors.push(`${path}.status must be completed or unavailable`);
	if (!isNullableString(node.reason)) errors.push(`${path}.reason must be a string or null`);
	if (node.status === "unavailable" && (typeof node.reason !== "string" || node.reason.length === 0)) errors.push(`${path}.reason is required when unavailable`);
	if (node.main === null) {
		if (node.status === "completed") errors.push(`${path}.main is required when completed`);
	} else validateUsage(node.main, `${path}.main`, errors);
	if (node.compressor !== null) validateUsage(node.compressor, `${path}.compressor`, errors);
	if (node.auxiliary !== null) validateUsage(node.auxiliary, `${path}.auxiliary`, errors);
	validateMaintenance(node.maintenance, `${path}.maintenance`, errors);
	if (!isNullableCount(node.totalPromptTokens)) errors.push(`${path}.totalPromptTokens must be a non-negative integer or null`);
	if (!isNullableFraction(node.cacheReadShare)) errors.push(`${path}.cacheReadShare must be a fraction from 0 to 1 or null`);
	validateRoleShares(node.cacheReadShareByRole, `${path}.cacheReadShareByRole`, errors);
	if (!isNullableFraction(node.mainSteadyStateCacheReadShare)) errors.push(`${path}.mainSteadyStateCacheReadShare must be a fraction from 0 to 1 or null`);
	if (!Array.isArray(node.latencyMsPerTurn) || !node.latencyMsPerTurn.every(isNullableMetric)) errors.push(`${path}.latencyMsPerTurn must be an array of non-negative numbers or null`);
	if (node.accuracy !== null) validateArmTotals(node.accuracy, `${path}.accuracy`, errors);

	const total = node.totalCost;
	if (total !== null) {
		if (!isRecord(total) || typeof total.estimated !== "boolean") errors.push(`${path}.totalCost must be null or {lowUsd, highUsd, estimated}`);
		else {
			validateInterval(total.lowUsd, total.highUsd, `${path}.totalCost`, errors, false);
			if (!total.estimated && total.lowUsd !== total.highUsd) errors.push(`${path}.totalCost must be a point value (lowUsd equal to highUsd) unless estimated`);
		}
		if (node.totalCostReason !== null) errors.push(`${path}.totalCostReason must be null when totalCost is present`);
	} else if (typeof node.totalCostReason !== "string" || node.totalCostReason.length === 0) {
		errors.push(`${path}.totalCostReason is required when totalCost is null`);
	}
	// Cross-checks read the parts, so they run only when every part above was structurally valid.
	if (errors.length !== before) return;
	const maintenance = node.maintenance as MaintenanceSummary;
	if (maintenance.compactions > 0 && node.cacheReadShare !== null) {
		errors.push(`${path}.cacheReadShare must be null when maintenance is estimated or unobserved`);
	}
	const expected = armTotalCost({
		main: node.main as UsageSummary | null,
		// An absent compressor (the off arm) is an observed zero, as in the runner's totals.
		compressor: (node.compressor ?? summarizeUsage([])) as UsageSummary,
		auxiliary: node.auxiliary as UsageSummary | null,
		maintenance,
	});
	if (expected === null && total !== null) errors.push(`${path}.totalCost must be null when a role is unobserved`);
	else if (expected !== null && total === null) errors.push(`${path}.totalCost must be present when every role is observed`);
	else if (expected !== null && isRecord(total) && total.estimated !== expected.estimated) errors.push(`${path}.totalCost.estimated must match maintenance.estimated`);
}

function validateDelta(node: unknown, path: string, errors: string[]): void {
	if (!isRecord(node)) {
		errors.push(`${path} must be an object`);
		return;
	}
	if ("totalCostUsd" in node) errors.push(`${path}.totalCostUsd is a single-point delta; costs are intervals under totalCost`);
	if (!isRecord(node.totalCost)) errors.push(`${path}.totalCost must be an interval {lowUsd, highUsd}`);
	else validateInterval(node.totalCost.lowUsd, node.totalCost.highUsd, `${path}.totalCost`, errors, true);
	for (const key of ["cacheReadShare", "mainSteadyStateCacheReadShare"] as const) {
		if (node[key] !== null && (typeof node[key] !== "number" || !Number.isFinite(node[key]))) errors.push(`${path}.${key} must be a finite number or null`);
	}
	if (node.accuracy !== null) {
		const accuracy = node.accuracy;
		if (!isRecord(accuracy) || !DELTA_ACCURACY_KEYS.every((key) => Number.isSafeInteger(accuracy[key]))) {
			errors.push(`${path}.accuracy must be null or signed integer differences for ${DELTA_ACCURACY_KEYS.join(", ")}`);
		}
	}
}

function validatePairedComparison(node: unknown, path: string, errors: string[]): void {
	if (!isRecord(node)) {
		errors.push(`${path} must be an object`);
		return;
	}
	if (typeof node.compressor !== "string" || node.compressor.length === 0) errors.push(`${path}.compressor must be a non-empty string`);
	validateArmSide(node.on, `${path}.on`, errors);
	validateArmSide(node.off, `${path}.off`, errors);
	const comparable = [node.on, node.off].every((side) => isRecord(side) && side.status === "completed" && isRecord(side.totalCost));
	if (node.delta === null) {
		if (typeof node.reason !== "string" || node.reason.length === 0) errors.push(`${path}.reason is required when delta is null`);
		if (comparable) errors.push(`${path}.delta is required when both arms completed with an observed total`);
		return;
	}
	if (node.reason !== null) errors.push(`${path}.reason must be null when delta is present`);
	if (!comparable) errors.push(`${path}.delta requires both arms completed with an observed total`);
	validateDelta(node.delta, `${path}.delta`, errors);
	if (isRecord(node.delta) && isRecord(node.on) && isRecord(node.off)) {
		// A share delta exists exactly when both arms observed that share.
		for (const key of ["cacheReadShare", "mainSteadyStateCacheReadShare"] as const) {
			const observed = node.on[key] !== null && node.off[key] !== null;
			if ((node.delta[key] !== null) !== observed) errors.push(`${path}.delta.${key} must be present exactly when both arms observed it`);
		}
	}
}

function validateUsageRecord(node: unknown, path: string, errors: string[]): void {
	if (!isRecord(node)) {
		errors.push(`${path} must be a usage record`);
		return;
	}
	if (!ROLES.includes(node.role as (typeof ROLES)[number])) errors.push(`${path}.role must be main, compressor, auxiliary, or maintenance`);
	if (typeof node.purpose !== "string") errors.push(`${path}.purpose must be a string`);
	for (const key of ["input", "output", "cacheRead", "cacheWrite"]) {
		if (!isNullableCount(node[key])) errors.push(`${path}.${key} must be a non-negative integer or null`);
	}
	if (!isNullableMetric(node.costUsd)) errors.push(`${path}.costUsd must be a non-negative number or null`);
	if (!RECORD_COST_SOURCES.includes(node.costSource as (typeof RECORD_COST_SOURCES)[number])) errors.push(`${path}.costSource must be sdk-reported, catalog-estimate, or unavailable`);
	if (!isNullableMetric(node.latencyMs)) errors.push(`${path}.latencyMs must be a non-negative number or null`);
}

function validateChildUsage(node: unknown, path: string, errors: string[]): void {
	if (!isRecord(node)) {
		errors.push(`${path} must be a child usage object`);
		return;
	}
	for (const key of ["calls", "input", "output", "cacheRead", "cacheWrite", "totalTokens"]) {
		if (!isNullableCount(node[key])) errors.push(`${path}.${key} must be a non-negative integer or null`);
	}
	if (!isNullableMetric(node.costUsd)) errors.push(`${path}.costUsd must be a non-negative number or null`);
	if (!CHILD_COST_SOURCES.includes(node.costSource as (typeof CHILD_COST_SOURCES)[number])) errors.push(`${path}.costSource must be sdk-reported or unavailable`);
	if (!isNullableMetric(node.latencyMs)) errors.push(`${path}.latencyMs must be a non-negative number or null`);
	if (!isNullableString(node.model)) errors.push(`${path}.model must be a string or null`);
	if (typeof node.aborted !== "boolean") errors.push(`${path}.aborted must be a boolean`);
}

function validateChildTask(node: unknown, path: string, errors: string[]): void {
	if (!isRecord(node)) {
		errors.push(`${path} must be an object`);
		return;
	}
	for (const key of ["taskId", "questionId", "kind"]) {
		if (typeof node[key] !== "string") errors.push(`${path}.${key} must be a string`);
	}
	if (!CHILD_STATUSES.includes(node.status as ChildStatus)) errors.push(`${path}.status must be a child status`);
	if (!isNullableString(node.reason)) errors.push(`${path}.reason must be a string or null`);
	if (typeof node.success !== "boolean") errors.push(`${path}.success must be a boolean`);
	if (node.valueCorrect !== null && typeof node.valueCorrect !== "boolean") errors.push(`${path}.valueCorrect must be a boolean or null`);
	if (node.outcome !== null && !OUTCOMES.includes(node.outcome as (typeof OUTCOMES)[number])) errors.push(`${path}.outcome must be a judged outcome or null`);
	if (node.failure !== null && !FAILURES.includes(node.failure as Failure)) errors.push(`${path}.failure must be a scoring failure or null`);
	if (node.grounded !== null && typeof node.grounded !== "boolean") errors.push(`${path}.grounded must be a boolean or null`);
	for (const key of ["childZoomCalls", "childWorkCalls"]) {
		if (!isNullableCount(node[key])) errors.push(`${path}.${key} must be a non-negative integer or null`);
	}
	if (!isNullableString(node.childOutputPreview)) errors.push(`${path}.childOutputPreview must be a string or null`);
	if (node.childUsage !== null) validateChildUsage(node.childUsage, `${path}.childUsage`, errors);
	if (!Array.isArray(node.parentUsage)) errors.push(`${path}.parentUsage must be an array`);
	else node.parentUsage.forEach((record, index) => validateUsageRecord(record, `${path}.parentUsage[${index}]`, errors));
}

function validateChildArm(node: unknown, path: string, errors: string[]): void {
	if (!isRecord(node)) {
		errors.push(`${path} must be a child arm summary`);
		return;
	}
	if (!Array.isArray(node.tasks)) errors.push(`${path}.tasks must be an array`);
	else node.tasks.forEach((task, index) => validateChildTask(task, `${path}.tasks[${index}]`, errors));
	validateUsage(node.parentUsage, `${path}.parentUsage`, errors);
	if (node.childUsage !== null) validateChildUsage(node.childUsage, `${path}.childUsage`, errors);
	if (!isCount(node.callsObserved)) errors.push(`${path}.callsObserved must be a non-negative integer`);
}

function validateChildReport(node: unknown, path: string, errors: string[]): void {
	if (!isRecord(node)) {
		errors.push(`${path} must be a child report or null`);
		return;
	}
	if (!isRecord(node.arms)) {
		errors.push(`${path}.arms must be an object`);
	} else {
		for (const arm of ["view", "blind"] as const) {
			if (node.arms[arm] !== null) validateChildArm(node.arms[arm], `${path}.arms.${arm}`, errors);
		}
	}
	if (!isNullableString(node.reason)) errors.push(`${path}.reason must be a string or null`);
}

function validateExperiments(node: unknown, requested: unknown, errors: string[]): void {
	if (!isRecord(node)) {
		errors.push("$.experiments must be an object");
		return;
	}
	const childRequested = Array.isArray(requested) && requested.includes("child");
	if (node.child === null) {
		if (childRequested) errors.push("$.experiments.child is required when the child experiment was requested");
		return;
	}
	if (!childRequested) errors.push("$.experiments.child must be null when the child experiment was not requested");
	validateChildReport(node.child, "$.experiments.child", errors);
}

/** Structural validation of an evidence artifact. Returns human-readable errors; an empty array means valid. */
export function validateArtifact(value: unknown): string[] {
	const errors: string[] = [];
	walkClaims(value, "$", errors);
	if (!isRecord(value)) return [...errors, "$: artifact must be an object"];
	if (value.schema !== ARTIFACT_SCHEMA) errors.push(`$.schema must be ${ARTIFACT_SCHEMA}`);
	if (typeof value.generatedAt !== "string" || Number.isNaN(Date.parse(value.generatedAt))) errors.push("$.generatedAt must be an ISO timestamp");
	if (!RUN_STATUSES.includes(value.status as (typeof RUN_STATUSES)[number])) errors.push(`$.status must be one of ${RUN_STATUSES.join(", ")}`);
	if (!isNullableString(value.error)) errors.push("$.error must be a string or null");
	if (value.synthetic !== true) errors.push("$.synthetic must be true");
	const armsValid = Array.isArray(value.arms) && value.arms.length > 0 && new Set(value.arms).size === value.arms.length && value.arms.every((arm) => ARMS.includes(arm as Arm));
	if (!armsValid) errors.push(`$.arms must be a non-empty subset of ${ARMS.join(", ")} with no duplicates`);
	if (!TURN_MODES.includes(value.turnMode as TurnMode)) errors.push(`$.turnMode must be one of ${TURN_MODES.join(", ")}`);
	const experimentsValid = Array.isArray(value.requestedExperiments) && new Set(value.requestedExperiments).size === value.requestedExperiments.length && value.requestedExperiments.every((entry) => EXPERIMENTS.includes(entry as Experiment));
	if (!experimentsValid) errors.push(`$.requestedExperiments must be a subset of ${EXPERIMENTS.join(", ")} with no duplicates`);
	if (!QUESTION_EMPHASES.includes(value.questionEmphasis as QuestionEmphasis)) errors.push("$.questionEmphasis must be balanced or adversarial");
	if (!Number.isSafeInteger(value.viewBytes) || (value.viewBytes as number) < MIN_VIEW_BYTES || (value.viewBytes as number) > MAX_VIEW_BYTES) {
		errors.push(`$.viewBytes must be an integer from ${MIN_VIEW_BYTES} to ${MAX_VIEW_BYTES}`);
	}
	if (!isRecord(value.models)) errors.push("$.models must be an object");
	else if (value.models.mainContextWindow !== null && (!Number.isSafeInteger(value.models.mainContextWindow) || (value.models.mainContextWindow as number) < MIN_MAIN_CONTEXT_WINDOW)) {
		errors.push(`$.models.mainContextWindow must be null or a safe integer of at least ${MIN_MAIN_CONTEXT_WINDOW}`);
	}
	validateCorpus(value.corpus, "$.corpus", errors);
	validateLimits(value.limits, "$.limits", errors);
	if (!Array.isArray(value.scenarios)) errors.push("$.scenarios must be an array");
	else value.scenarios.forEach((scenario, index) => validateScenario(scenario, `$.scenarios[${index}]`, errors, value.turnMode));
	validateExperiments(value.experiments, value.requestedExperiments, errors);
	if (!Array.isArray(value.paired)) {
		errors.push("$.paired must be an array");
	} else {
		const bothArms = Array.isArray(value.arms) && value.arms.includes("on") && value.arms.includes("off");
		if (!bothArms && value.paired.length > 0) errors.push("$.paired must be empty unless both arms ran");
		value.paired.forEach((entry, index) => validatePairedComparison(entry, `$.paired[${index}]`, errors));
	}
	if (!isRecord(value.accuracy)) errors.push("$.accuracy must be an object");
	if (!Array.isArray(value.limitations) || value.limitations.length === 0 || !value.limitations.every((entry) => typeof entry === "string")) {
		errors.push("$.limitations must be a non-empty string array");
	}
	return errors;
}
