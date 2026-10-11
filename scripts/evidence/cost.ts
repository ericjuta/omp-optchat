/**
 * Dollar bounds for live provider calls. Rates are USD per million tokens. A bound is a worst case
 * computed before dispatch; an observed spend is a provider-reported fact. Any unknown value is null,
 * and null refuses: a call with no provable bound never runs, and an unobservable spend stops live calls.
 */
export interface ModelRates {
	readonly inputRate: number | null;
	readonly outputRate: number | null;
	readonly cacheReadRate: number | null;
	readonly cacheWriteRate: number | null;
	readonly contextWindow: number | null;
	/** Provider output ceiling; null when the catalog does not state one. */
	readonly maxOutput: number | null;
}

/**
 * Spend for one host. The retained `observedUsd` field holds exact observed costs plus an estimated
 * maintenance upper bound. Null means a spend could not be observed or bounded.
 */
export interface SpendLedger {
	readonly observedUsd: number | null;
}

export type DollarAdmission = { readonly admitted: true } | { readonly admitted: false; readonly reason: "cost-cap" | "unknown-cost" };

const isNonNegativeFinite = (value: number): boolean => Number.isFinite(value) && value >= 0;
const isPositiveInteger = (value: number): boolean => Number.isSafeInteger(value) && value > 0;

/**
 * Worst-case USD for one call. The prompt is billed at the dearest input-side rate and the output at the
 * output rate, with output clamped to the catalog ceiling when one is stated. Returns null when a rate or
 * the context window is unknown; the caller refuses. Invalid token counts are a programming error and throw.
 */
export function worstCaseCallUsd(model: ModelRates | null, maxPromptTokens: number, maxOutputTokens: number): number | null {
	if (!Number.isSafeInteger(maxPromptTokens) || maxPromptTokens < 0) throw new Error("max prompt tokens must be a non-negative integer");
	if (!isPositiveInteger(maxOutputTokens)) throw new Error("max output tokens must be a positive integer");
	if (model === null) return null;
	const { inputRate, outputRate, cacheReadRate, cacheWriteRate, contextWindow, maxOutput } = model;
	if (inputRate === null || outputRate === null || cacheReadRate === null || cacheWriteRate === null || contextWindow === null) return null;
	if (![inputRate, outputRate, cacheReadRate, cacheWriteRate].every(isNonNegativeFinite) || !isPositiveInteger(contextWindow)) return null;
	if (maxPromptTokens > contextWindow) throw new Error("max prompt tokens exceed the context window");
	const outputTokens = maxOutput === null ? maxOutputTokens : Math.min(maxOutputTokens, maxOutput);
	return (maxPromptTokens * Math.max(inputRate, cacheWriteRate, cacheReadRate) + outputTokens * outputRate) / 1e6;
}

/**
 * OFF-only compaction bound using caller-supplied UTF-8 byte counts, at four bytes per token plus
 * 4096 input tokens of overhead. History is not capped to contextWindow. Unknown rates or output
 * ceiling fail closed, even for zero-rate models; invalid byte counts are programming errors.
 */
export function offCompactionBoundUsd(model: ModelRates | null, historyBytes: number, promptBytes: number): number | null {
	if (!Number.isSafeInteger(historyBytes) || historyBytes < 0) throw new Error("history bytes must be a non-negative safe integer");
	if (!Number.isSafeInteger(promptBytes) || promptBytes < 0) throw new Error("prompt bytes must be a non-negative safe integer");
	if (model === null) return null;
	const { inputRate, outputRate, cacheReadRate, cacheWriteRate, maxOutput } = model;
	if (inputRate === null || outputRate === null || cacheReadRate === null || cacheWriteRate === null || maxOutput === null) return null;
	if (![inputRate, outputRate, cacheReadRate, cacheWriteRate].every(isNonNegativeFinite) || !isPositiveInteger(maxOutput)) return null;
	const inputTokens = Math.ceil(historyBytes / 4) + Math.ceil(promptBytes / 4) + 4096;
	return (inputTokens * Math.max(inputRate, cacheReadRate, cacheWriteRate) + maxOutput * outputRate) / 1e6;
}

export function initialSpend(): SpendLedger {
	return { observedUsd: 0 };
}

/** Adds an exact observed cost or estimated maintenance upper bound. Once unknown, the ledger stays unknown. */
export function recordSpend(ledger: SpendLedger, usd: number | null): SpendLedger {
	if (ledger.observedUsd === null || usd === null) return { observedUsd: null };
	if (!isNonNegativeFinite(usd)) throw new Error("observed spend must be a non-negative finite number");
	return { observedUsd: ledger.observedUsd + usd };
}

/** Admits a call only when spent plus its worst-case bound fits within the cap. Unknown spend or bound refuses. */
export function dollarAdmission(spentUsd: number | null, bound: number | null, capUsd: number): DollarAdmission {
	if (!Number.isFinite(capUsd) || capUsd <= 0) throw new Error("cost cap must be a positive finite number");
	if (spentUsd !== null && !isNonNegativeFinite(spentUsd)) throw new Error("spent USD must be a non-negative finite number");
	if (bound !== null && !isNonNegativeFinite(bound)) throw new Error("bound USD must be a non-negative finite number");
	if (spentUsd === null || bound === null) return { admitted: false, reason: "unknown-cost" };
	return spentUsd + bound <= capUsd ? { admitted: true } : { admitted: false, reason: "cost-cap" };
}
