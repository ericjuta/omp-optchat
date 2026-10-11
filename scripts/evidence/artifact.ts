import type { QuestionKind } from "./corpus.ts";
import { isRecord, type Failure } from "./scoring.ts";
import { MAX_CALLS, MAX_COMPRESSOR_OUTPUT_TOKENS, MAX_DEADLINE_MS, MAX_EXPIRY_WAIT_MS } from "./plan.ts";

/** Versioned evidence artifact: observed counters only; unknown values stay null, never zero. */
export const ARTIFACT_SCHEMA = "optchat-evidence-recall/2";

export type Role = "main" | "compressor";

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

export type CostSource = "none" | "sdk-reported" | "catalog-estimate" | "mixed" | "unavailable";

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

const FORBIDDEN_KEY = /^(?:api[-_]?keys?|authorization|headers?|credentials?|secrets?|access[-_]?tokens?|refresh[-_]?tokens?|passwords?)$/i;
/** Savings and billing are never claimed by this artifact; costs are provider-reported or catalog estimates. */
const CLAIM_KEY = /saving|saved|savings|bill|invoice/i;
const QUESTION_KINDS: readonly QuestionKind[] = ["merge-depth", "correction", "negation", "exact-id", "minor-fact", "attribution", "ambiguity", "work-reference"];
const RUN_STATUSES = ["completed", "budget-stopped", "failed", "blocked", "not-run"] as const;
const SCENARIO_STATUSES = ["completed", "not-run", "budget-stopped", "failed"] as const;
const COST_SOURCES: readonly CostSource[] = ["none", "sdk-reported", "catalog-estimate", "mixed", "unavailable"];
const ENFORCEMENTS = ["prompt-admission", "host-admission"] as const;
const OUTCOMES = ["correct", "abstained", "incorrect", "hallucinated"] as const;
const FAILURES: readonly Failure[] = ["schema", "no-answer", "ungrounded", "wrong-value", "forbidden-value", "fabricated-id", "fabricated-citation", "ambiguous-confident", "ambiguous-incomplete"];
const REFUSALS = ["maxCalls", "deadline"] as const;

function isCount(node: unknown): boolean {
	return typeof node === "number" && Number.isSafeInteger(node) && node >= 0;
}

function isNullableCount(node: unknown): boolean {
	return node === null || isCount(node);
}

function isNullableMetric(node: unknown): boolean {
	return node === null || (typeof node === "number" && Number.isFinite(node) && node >= 0);
}

function isNullableString(node: unknown): boolean {
	return node === null || typeof node === "string";
}

/** Any credential-shaped key, savings or billing claim, negative number, or non-finite number anywhere in the artifact. */
function walkClaims(node: unknown, path: string, errors: string[]): void {
	if (typeof node === "number") {
		if (!Number.isFinite(node)) errors.push(`${path}: non-finite number`);
		else if (node < 0) errors.push(`${path}: negative metric`);
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

function validatePhase(node: unknown, path: string, errors: string[]): void {
	if (!isRecord(node)) {
		errors.push(`${path} must be an object`);
		return;
	}
	if (typeof node.name !== "string" || typeof node.model !== "string") errors.push(`${path}.name and model must be strings`);
	if (!isNullableString(node.error)) errors.push(`${path}.error must be a string or null`);
	if (node.refusal !== null && !REFUSALS.includes(node.refusal as (typeof REFUSALS)[number])) errors.push(`${path}.refusal must be maxCalls, deadline, or null`);
	if (!isNullableMetric(node.latencyMs)) errors.push(`${path}.latencyMs must be a non-negative number or null`);
	if (!isRecord(node.usage)) {
		errors.push(`${path}.usage is required`);
	} else {
		validateUsage(node.usage.main, `${path}.usage.main`, errors);
		validateCompressor(node.usage.compressor, `${path}.usage.compressor`, errors);
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

function validateScenario(node: unknown, path: string, errors: string[]): void {
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
	node.phases.forEach((phase, index) => validatePhase(phase, `${path}.phases[${index}]`, errors));
}

function validateCorpus(node: unknown, path: string, errors: string[]): void {
	if (!isRecord(node)) {
		errors.push(`${path} must be an object`);
		return;
	}
	if (typeof node.version !== "string") errors.push(`${path}.version must be a string`);
	if (!isCount(node.seed)) errors.push(`${path}.seed must be a non-negative integer`);
	if (typeof node.digest !== "string" || !/^[0-9a-f]{64}$/.test(node.digest)) errors.push(`${path}.digest must be a sha256 hex digest`);
	if (!isCount(node.sources) || (node.sources as number) < 16 || (node.sources as number) > 24) errors.push(`${path}.sources must be an integer from 16 to 24`);
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
	validateCorpus(value.corpus, "$.corpus", errors);
	validateLimits(value.limits, "$.limits", errors);
	if (!Array.isArray(value.scenarios)) errors.push("$.scenarios must be an array");
	else value.scenarios.forEach((scenario, index) => validateScenario(scenario, `$.scenarios[${index}]`, errors));
	if (!isRecord(value.accuracy)) errors.push("$.accuracy must be an object");
	if (!Array.isArray(value.limitations) || value.limitations.length === 0 || !value.limitations.every((entry) => typeof entry === "string")) {
		errors.push("$.limitations must be a non-empty string array");
	}
	return errors;
}
