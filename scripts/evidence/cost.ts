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

/**
 * UTF-8 byte counts of one main-model prompt, by component. Tokens never exceed bytes, so no tokenizer
 * is assumed.
 */
export interface MainPromptBytes {
	readonly system: number;
	readonly tools: number;
	readonly history: number;
	readonly question: number;
	readonly retrieval: number;
}

/** Input tokens of fixed overhead on an OFF-arm compaction call, on top of its history and prompt bytes. */
const COMPACTION_OVERHEAD_TOKENS = 4096;

const isNonNegativeFinite = (value: number): boolean => Number.isFinite(value) && value >= 0;
const isPositiveInteger = (value: number): boolean => Number.isSafeInteger(value) && value > 0;
const isNonNegativeSafeInteger = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;

/**
 * Worst input-side and output rates, in USD per million tokens. The input side is the dearest of the
 * input, cache-read, and cache-write rates. Null when any of the four is unknown or invalid.
 */
function worstRates(model: ModelRates): { readonly input: number; readonly output: number } | null {
	const { inputRate, outputRate, cacheReadRate, cacheWriteRate } = model;
	if (inputRate === null || outputRate === null || cacheReadRate === null || cacheWriteRate === null) return null;
	if (![inputRate, outputRate, cacheReadRate, cacheWriteRate].every(isNonNegativeFinite)) return null;
	return { input: Math.max(inputRate, cacheReadRate, cacheWriteRate), output: outputRate };
}

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
 * Worst-case USD for `maxCalls` main-model calls from their prompt bytes. Each call's prompt is bounded by
 * its bytes, so tokens are at most bytes, clamped to the context window. The input side is priced at the
 * dearest input-side rate, and output at `outputCap`, which the runner pins as the request maxTokens.
 * The per-prompt bound is multiplied by the call count only; it is not multiplied by the number of
 * questions. Unknown rates or context window, and an invalid output cap, return null and fail closed.
 * Invalid bytes or call counts are programming errors and throw.
 */
export function mainPromptBoundUsd(model: ModelRates | null, bytes: MainPromptBytes, outputCap: number, maxCalls: number): number | null {
	const parts = [bytes.system, bytes.tools, bytes.history, bytes.question, bytes.retrieval];
	if (!parts.every(isNonNegativeSafeInteger)) throw new Error("prompt bytes must be non-negative safe integers");
	const totalBytes = parts.reduce((sum, part) => sum + part, 0);
	if (!Number.isSafeInteger(totalBytes)) throw new Error("prompt bytes must sum to a safe integer");
	if (!isNonNegativeSafeInteger(maxCalls)) throw new Error("max calls must be a non-negative safe integer");
	if (model === null || !isPositiveInteger(outputCap)) return null;
	const rates = worstRates(model);
	const { contextWindow } = model;
	if (rates === null || contextWindow === null || !isPositiveInteger(contextWindow)) return null;
	const promptTokens = Math.min(contextWindow, totalBytes);
	return ((promptTokens * rates.input + outputCap * rates.output) / 1e6) * maxCalls;
}

/**
 * OFF-only compaction bound from caller-supplied UTF-8 byte counts. Tokens are at most bytes, plus 4096
 * tokens of overhead. History is not capped to contextWindow, so a long prior transcript grows the bound.
 * The output is billed at `outputCap`, which defaults to the catalog ceiling. Unknown rates or an unknown
 * or invalid output cap fail closed, even for zero-rate models. Invalid byte counts are programming errors.
 */
export function offCompactionBoundUsd(
	model: ModelRates | null,
	historyBytes: number,
	promptBytes: number,
	outputCap: number | null = model === null ? null : model.maxOutput,
): number | null {
	if (!isNonNegativeSafeInteger(historyBytes)) throw new Error("history bytes must be a non-negative safe integer");
	if (!isNonNegativeSafeInteger(promptBytes)) throw new Error("prompt bytes must be a non-negative safe integer");
	if (model === null) return null;
	const rates = worstRates(model);
	if (rates === null || outputCap === null || !isPositiveInteger(outputCap)) return null;
	const inputTokens = historyBytes + promptBytes + COMPACTION_OVERHEAD_TOKENS;
	if (!Number.isSafeInteger(inputTokens)) throw new Error("compaction input tokens must be a safe integer");
	return (inputTokens * rates.input + outputCap * rates.output) / 1e6;
}

/** UTF-8 bytes of the OptChat system block (src/index.ts SYSTEM_BLOCK). Pinned by a test against the source. */
export const SYSTEM_BLOCK_BYTES = 6316;

/** Upper bound on one host's tool schemas: a fixed allowance, since the schema bytes are not observed per run. */
export const TOOL_SCHEMA_BYTES = 32 * 1024;

/** Layout of the OptChat compactor's prompts that bounds one compressor call. Defaults come from src/config.ts and src/memory.ts. */
export interface CompactorLayout {
	readonly nodeBytes: number;
	readonly pageBytes: number;
	readonly compactionViewBytes: number;
}

/** Fixed template overheads of the compactor prompts, in UTF-8 bytes, from the compactor's prompt builders. */
const COMPACTOR_VIEW_OVERHEAD_BYTES = 4096;
const COMPACTOR_BATCH_OVERHEAD_BYTES = 1007;
const COMPACTOR_BATCH_TWO_PAGE_OVERHEAD_BYTES = 889;
const COMPACTOR_SHORTEN_OVERHEAD_BYTES = 275;

/**
 * UTF-8 bytes of the largest prompt one compressor call can carry: system, compactor view, batch input, and
 * the shorten step (one page and one node). Each part is at most its layout bound; tokens are bounded by bytes.
 */
export function compressorPromptBytes(systemBytes: number, layout: CompactorLayout): number {
	if (!isNonNegativeSafeInteger(systemBytes)) throw new Error("system bytes must be a non-negative safe integer");
	if (!isPositiveInteger(layout.nodeBytes) || !isPositiveInteger(layout.pageBytes) || !isPositiveInteger(layout.compactionViewBytes)) {
		throw new Error("compactor layout bytes must be positive integers");
	}
	const { nodeBytes, pageBytes, compactionViewBytes } = layout;
	const view = compactionViewBytes + COMPACTOR_VIEW_OVERHEAD_BYTES;
	const batch = Math.max(pageBytes + COMPACTOR_BATCH_OVERHEAD_BYTES, 2 * pageBytes + COMPACTOR_BATCH_TWO_PAGE_OVERHEAD_BYTES);
	const shorten = pageBytes + nodeBytes + COMPACTOR_SHORTEN_OVERHEAD_BYTES;
	return systemBytes + view + batch + shorten;
}

/** Worst case for one compressor call: its byte bound priced as one prompt, with the compressor output cap. */
export function compressorCallBoundUsd(model: ModelRates | null, systemBytes: number, layout: CompactorLayout, outputCap: number): number | null {
	const total = compressorPromptBytes(systemBytes, layout);
	return mainPromptBoundUsd(model, { system: total, tools: 0, history: 0, question: 0, retrieval: 0 }, outputCap, 1);
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

/**
 * Reservation ledger for one run's dollar cap. Committed spend is the observed total plus every live
 * reservation: a compressor host's allowance or a main prompt's worst-case bound. Every method is
 * synchronous, so each admission sees all earlier reservations and no two can allocate the same dollars.
 * Unknown spend or an unknown host bound is null and stays null, so every later admission refuses.
 * Ids share one namespace; reusing a live id throws, and releasing an id that is not live throws.
 */
export class DollarReservations {
	private readonly capUsd: number;
	private observed: number | null = 0;
	/** A null allowance records a host admitted while spend was already unknown; it keeps committed null. */
	private readonly hosts = new Map<string, number | null>();
	private readonly prompts = new Map<string, number>();

	constructor(capUsd: number) {
		if (!Number.isFinite(capUsd) || capUsd <= 0) throw new Error("cost cap must be a positive finite number");
		this.capUsd = capUsd;
	}

	/** Observed spend so far, or null once any spend was unobservable. */
	get observedUsd(): number | null {
		return this.observed;
	}

	/** Observed spend plus every live host allowance and prompt bound, or null once spend is unknown. */
	get committedUsd(): number | null {
		if (this.observed === null) return null;
		let total = this.observed;
		for (const allowance of this.hosts.values()) {
			if (allowance === null) return null;
			total += allowance;
		}
		for (const bound of this.prompts.values()) total += bound;
		return total;
	}

	/**
	 * Reserves a compressor host's allowance: min(share × remaining, buildNeedUsd when given), where remaining
	 * is cap minus committed. Returns null when spend is unknown; the host is still recorded, so release works.
	 */
	reserveHost(id: string, share: number, buildNeedUsd: number | null = null): number | null {
		this.assertFree(id);
		if (!Number.isFinite(share) || share <= 0 || share > 1) throw new Error("host share must be above 0 and at most 1");
		if (buildNeedUsd !== null && !isNonNegativeFinite(buildNeedUsd)) throw new Error("build need must be a non-negative finite number");
		const committed = this.committedUsd;
		if (committed === null) {
			this.hosts.set(id, null);
			return null;
		}
		const remaining = Math.max(0, this.capUsd - committed);
		const allowance = buildNeedUsd === null ? share * remaining : Math.min(share * remaining, buildNeedUsd);
		this.hosts.set(id, allowance);
		return allowance;
	}

	/**
	 * Releases a host's allowance and replaces it with the host's observed compressor spend. The observed spend
	 * may not exceed its allowance; no tolerance is applied, so a violation throws. Null observed spend makes
	 * the whole ledger unknown.
	 */
	releaseHost(id: string, observedCompressorUsd: number | null): void {
		this.settle(id, this.reservationOf(this.hosts, id), observedCompressorUsd);
		this.hosts.delete(id);
	}

	/** Adds an exact observed spend or an upper bound. Null makes the ledger unknown for the rest of the run. */
	recordSpend(usd: number | null): void {
		if (usd === null) {
			this.observed = null;
			return;
		}
		if (!isNonNegativeFinite(usd)) throw new Error("observed spend must be a non-negative finite number");
		if (this.observed !== null) this.observed += usd;
	}

	/** Checks a prompt bound against committed spend without reserving it. Null bound or unknown spend refuses. */
	admitPrompt(bound: number | null): DollarAdmission {
		return dollarAdmission(this.committedUsd, bound, this.capUsd);
	}

	/**
	 * Admits a main prompt and, on admission, reserves its bound under `id` before the call is dispatched. A
	 * refused prompt leaves no reservation.
	 */
	reservePrompt(id: string, bound: number | null): DollarAdmission {
		this.assertFree(id);
		const admission = this.admitPrompt(bound);
		if (admission.admitted && bound !== null) this.prompts.set(id, bound);
		return admission;
	}

	/**
	 * Replaces a prompt's reserved bound with its observed cost. The observed cost may not exceed the bound; a
	 * null observed cost makes the ledger unknown.
	 */
	releasePrompt(id: string, observed: number | null): void {
		this.settle(id, this.reservationOf(this.prompts, id), observed);
		this.prompts.delete(id);
	}

	private assertFree(id: string): void {
		if (id.length === 0) throw new Error("reservation id must be non-empty");
		if (this.hosts.has(id) || this.prompts.has(id)) throw new Error(`duplicate reservation id: ${id}`);
	}

	private reservationOf<T>(map: Map<string, T>, id: string): T {
		const value = map.get(id);
		if (value === undefined) throw new Error(`no live reservation: ${id}`);
		return value;
	}

	/**
	 * Validates a release, then adds its observed spend in place of its reservation. Every check runs before any
	 * mutation, so a rejected release leaves the reservation live and the ledger unchanged. A null reservation was
	 * admitted while spend was unknown, so the ledger is already unknown and stays so.
	 */
	private settle(id: string, reserved: number | null, observed: number | null): void {
		if (observed !== null && !isNonNegativeFinite(observed)) throw new Error(`observed spend for ${id} must be a non-negative finite number or null`);
		if (observed !== null && reserved !== null && observed > reserved) throw new Error(`observed spend for ${id} exceeds its reservation`);
		if (observed === null) {
			this.observed = null;
			return;
		}
		if (reserved === null || this.observed === null) return;
		this.observed += observed;
	}
}
