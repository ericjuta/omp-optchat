import { ADVERSARIAL_KINDS, QUESTION_KINDS, type Question, type QuestionKind, type SourceRecord } from "./corpus.ts";
import { answerInstruction } from "./scoring.ts";

/** Hard ceilings for any live evidence run; the parent may lower them but never raise them. */
export const MAX_CALLS = 2000;
/** The default ceiling when --max-calls is omitted: unchanged, so a bare run never spends more than before. */
export const DEFAULT_MAX_CALLS = 80;
/** Compressor admissions a host may dispatch per phase. The seed build is bounded so it cannot take the whole pool. */
export const SEED_COMPRESSOR_ALLOWANCE = 90;
/** Every non-seed, non-restart phase is bounded and leaves RESTART_RESERVE_CALLS for restart. */
export const PHASE_COMPRESSOR_ALLOWANCE = 50;
export const RESTART_RESERVE_CALLS = 60;

/**
 * Compressor admissions one host may dispatch, from the calls spare after the main-prompt reserve. Restart takes
 * what remains so it can settle; seed and other phases never take the reserve. `share` splits one phase's
 * allowance across concurrent hosts.
 */
export function phaseCompressorAllowance(label: string, spare: number, share: number): number {
	const bound = label === "seed" ? SEED_COMPRESSOR_ALLOWANCE : label === "restart" ? spare : Math.min(PHASE_COMPRESSOR_ALLOWANCE, spare - RESTART_RESERVE_CALLS);
	return Math.max(0, Math.floor(Math.min(bound, spare) / share));
}
export const MAX_COMPRESSOR_OUTPUT_TOKENS = 512;
export const MAX_DEADLINE_MS = 600_000;
export const MAX_EXPIRY_WAIT_MS = 310_000;
/** Default worst-case provider calls one prompt may issue (main turn plus bounded host tool loop). */
export const DEFAULT_PROMPT_CALLS = 4;

/**
 * How the call and deadline limits are enforced. `prompt-admission` means the runner checks before
 * each prompt; calls already in flight are not stopped. `host-admission` requires an in-process gate
 * inside the host process, which this repository does not provide.
 */
export type Enforcement = "prompt-admission" | "host-admission";

export interface Limits {
	readonly maxCalls: number;
	readonly maxCompressorOutputTokens: number;
	readonly deadlineMs: number;
	readonly expiryWaitMs: number | null;
}

export function checkLimits(limits: Limits): string[] {
	const errors: string[] = [];
	if (!Number.isInteger(limits.maxCalls) || limits.maxCalls < 1 || limits.maxCalls > MAX_CALLS) errors.push(`maxCalls must be an integer from 1 to ${MAX_CALLS}`);
	if (!Number.isInteger(limits.maxCompressorOutputTokens) || limits.maxCompressorOutputTokens < 1 || limits.maxCompressorOutputTokens > MAX_COMPRESSOR_OUTPUT_TOKENS) {
		errors.push(`maxCompressorOutputTokens must be an integer from 1 to ${MAX_COMPRESSOR_OUTPUT_TOKENS}`);
	}
	if (!Number.isInteger(limits.deadlineMs) || limits.deadlineMs < 1 || limits.deadlineMs > MAX_DEADLINE_MS) errors.push(`deadlineMs must be an integer from 1 to ${MAX_DEADLINE_MS}`);
	if (limits.expiryWaitMs !== null && (!Number.isInteger(limits.expiryWaitMs) || limits.expiryWaitMs < 1 || limits.expiryWaitMs > MAX_EXPIRY_WAIT_MS)) {
		errors.push(`expiryWaitMs must be an integer from 1 to ${MAX_EXPIRY_WAIT_MS}`);
	}
	return errors;
}

/** Immutable accounting. Calls are observed counts from host and compressor sinks; nothing is reserved. */
export interface AccountingState {
	readonly startedAt: number;
	readonly mainCalls: number;
	readonly compressorCalls: number;
	readonly admittedPrompts: number;
	readonly refusedPrompts: number;
}

export type Refusal = "maxCalls" | "deadline";

export type Admission = { readonly admitted: true; readonly state: AccountingState } | { readonly admitted: false; readonly reason: Refusal; readonly state: AccountingState };

export function initialAccounting(now: number): AccountingState {
	return { startedAt: now, mainCalls: 0, compressorCalls: 0, admittedPrompts: 0, refusedPrompts: 0 };
}

export function observedCalls(state: AccountingState): number {
	return state.mainCalls + state.compressorCalls;
}

/** Adds calls observed after a prompt settled. A count is a fact, so it is never estimated or reserved. */
export function recordCalls(state: AccountingState, role: "main" | "compressor", count: number): AccountingState {
	if (!Number.isSafeInteger(count) || count < 0) throw new Error("observed call count must be a non-negative integer");
	return role === "main" ? { ...state, mainCalls: state.mainCalls + count } : { ...state, compressorCalls: state.compressorCalls + count };
}

/**
 * Prompt-level admission. The runner must call this serially, after the previous prompt settled and
 * its calls were recorded. Admission succeeds when the deadline has not passed and observed calls plus
 * the worst case for this prompt fit within maxCalls. It is a check, not a gate: it cannot stop calls
 * already in flight or calls made outside prompts.
 */
export function admitPrompt(state: AccountingState, limits: Limits, now: number, worstCaseCalls: number = DEFAULT_PROMPT_CALLS): Admission {
	if (!Number.isInteger(worstCaseCalls) || worstCaseCalls < 1) throw new Error("worst-case prompt calls must be a positive integer");
	if (now - state.startedAt >= limits.deadlineMs) {
		return { admitted: false, reason: "deadline", state: { ...state, refusedPrompts: state.refusedPrompts + 1 } };
	}
	if (observedCalls(state) + worstCaseCalls > limits.maxCalls) {
		return { admitted: false, reason: "maxCalls", state: { ...state, refusedPrompts: state.refusedPrompts + 1 } };
	}
	return { admitted: true, state: { ...state, admittedPrompts: state.admittedPrompts + 1 } };
}

/**
 * Compressor calls charged for one collection window. `dispatchedSince` is the admission counter's
 * growth (attempts that were sent); `completed` is the metric lines written in the window. A completed
 * call without an admission is a violation, and is still charged: the ceiling never under-counts.
 */
export function chargedAttempts(dispatchedTotal: number, completedTotal: number, chargedSoFar: number): { readonly charged: number; readonly total: number; readonly violation: string | null } {
	// Cumulative per host: an admission and its completion can land in different collection windows.
	const violation = completedTotal > dispatchedTotal ? `compressor metric lines ${completedTotal} exceed admissions ${dispatchedTotal}` : null;
	const total = Math.max(dispatchedTotal, completedTotal, chargedSoFar);
	return { charged: total - chargedSoFar, total, violation };
}

export function remainingCalls(state: AccountingState, limits: Limits): number {
	return Math.max(0, limits.maxCalls - observedCalls(state));
}

/** Observed counts that exceed the ceiling; reported in the artifact, never silently capped. */
export function accountingViolations(state: AccountingState, limits: Limits): string[] {
	const observed = observedCalls(state);
	return observed > limits.maxCalls ? [`observed calls ${observed} exceed maxCalls ${limits.maxCalls}`] : [];
}

const ACCOUNTING_KEYS = ["startedAt", "mainCalls", "compressorCalls", "admittedPrompts", "refusedPrompts"] as const;

/** Strict parse of persisted accounting. Throws on unknown, missing, or negative fields. */
export function parseAccountingState(value: unknown): AccountingState {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("accounting state must be an object");
	const record = value as Record<string, unknown>;
	const actual = Object.keys(record).sort().join(",");
	const expected = [...ACCOUNTING_KEYS].sort().join(",");
	if (actual !== expected) throw new Error("accounting state has unexpected or missing fields");
	for (const key of ACCOUNTING_KEYS) {
		const field = record[key];
		if (typeof field !== "number" || !Number.isSafeInteger(field) || field < 0) throw new Error(`accounting ${key} must be a non-negative integer`);
	}
	return {
		startedAt: record.startedAt as number,
		mainCalls: record.mainCalls as number,
		compressorCalls: record.compressorCalls as number,
		admittedPrompts: record.admittedPrompts as number,
		refusedPrompts: record.refusedPrompts as number,
	};
}

/** `adversarial` rotates the recall-stressing kinds first in every round; `balanced` rotates kinds in corpus order. */
export type QuestionEmphasis = "balanced" | "adversarial";

/** Stratified selection so a small budget still covers every question kind before any kind repeats. */
export function selectQuestions(questions: readonly Question[], limit: number, emphasis: QuestionEmphasis = "balanced"): Question[] {
	if (!Number.isInteger(limit) || limit < 1) throw new Error("question limit must be a positive integer");
	const buckets = Object.fromEntries(QUESTION_KINDS.map((kind) => [kind, [] as Question[]])) as Record<QuestionKind, Question[]>;
	for (const question of questions) buckets[question.kind].push(question);
	const order: readonly QuestionKind[] =
		emphasis === "adversarial" ? [...ADVERSARIAL_KINDS, ...QUESTION_KINDS.filter((kind) => !ADVERSARIAL_KINDS.includes(kind))] : QUESTION_KINDS;
	const selected: Question[] = [];
	for (let round = 0; selected.length < limit; round++) {
		let added = false;
		for (const kind of order) {
			const candidate = buckets[kind][round];
			if (candidate && selected.length < limit) {
				selected.push(candidate);
				added = true;
			}
		}
		if (!added) break;
	}
	return selected;
}

/** Splits source records into memory-seeding batches. Each record appears in exactly one batch, in recordId order. */
export function seedBatches(sources: readonly SourceRecord[], perBatch: number): SourceRecord[][] {
	if (!Number.isInteger(perBatch) || perBatch < 1) throw new Error("records per batch must be a positive integer");
	const batches: SourceRecord[][] = [];
	for (let start = 0; start < sources.length; start += perBatch) batches.push(sources.slice(start, start + perBatch));
	return batches;
}

/** Final-answer prompt for a set of questions. Source records must already be in memory; the model chooses its own zoom addresses. */
export function batchPrompt(questions: readonly Question[]): string {
	const lines = questions.map((question, index) => `${index + 1}. [${question.id}] ${question.prompt}`);
	return [
		"Answer each numbered question from memory. Use the memory tools to locate each source record, then quote its original text.",
		...lines,
		answerInstruction(questions.map((question) => question.id)),
	].join("\n");
}
