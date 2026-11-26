import { readFileSync, writeFileSync } from "node:fs";
import type { Judge, JudgeOptions, JudgmentRequest, JudgmentResult, Questions } from "@oh-my-pi/pi-ai";

/**
 * Per-host judge counter. Judge spend is not observable to the runner (the host returns the winning candidate's
 * usage only), so a run that leaves System One gates on bounds judge calls by count instead of by dollars.
 */
export interface JudgeCapState {
	/** Calls sent to the judge. Written before the request leaves, so a crash over-counts. */
	readonly dispatched: number;
	/** Calls refused because the allowance was spent; no request was made. */
	readonly refused: number;
	/** Calls that returned. */
	readonly returned: number;
	/** Host cost diagnostic of each returned call; null when the host reported none. Never an invoice. */
	readonly diagnosticUsd: readonly (number | null)[];
	/** Model the host reported for each returned call. */
	readonly models: readonly string[];
}

export function initialJudgeCap(): JudgeCapState {
	return { dispatched: 0, refused: 0, returned: 0, diagnosticUsd: [], models: [] };
}

export function parseJudgeCap(value: unknown): JudgeCapState {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("judge cap file is malformed");
	const { dispatched, refused, returned, diagnosticUsd, models } = value as Record<string, unknown>;
	for (const count of [dispatched, refused, returned]) {
		if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) throw new Error("judge cap counters must be non-negative integers");
	}
	if (!Array.isArray(diagnosticUsd) || !diagnosticUsd.every((usd) => usd === null || (typeof usd === "number" && Number.isFinite(usd) && usd >= 0))) {
		throw new Error("judge cap diagnostics are malformed");
	}
	if (!Array.isArray(models) || !models.every((model) => typeof model === "string")) throw new Error("judge cap models are malformed");
	return { dispatched: dispatched as number, refused: refused as number, returned: returned as number, diagnosticUsd, models };
}

/**
 * Wraps a judge so at most `allowance` calls are sent, counted in `file` with a synchronous read-increment-write
 * before each request. A refused call throws; the gates treat a thrown judgment as a failed one and never retry it.
 * The wrapper keeps `primaryModel` and `sessionFallback`, which OptChat reads to decide whether a gate may run.
 */
export function cappedJudge<J extends Judge>(inner: J, file: string, allowance: number): J {
	if (!Number.isSafeInteger(allowance) || allowance < 0) throw new RangeError("judge allowance must be a non-negative integer");
	const read = (): JudgeCapState => parseJudgeCap(JSON.parse(readFileSync(file, "utf8")));
	const write = (state: JudgeCapState): void => writeFileSync(file, JSON.stringify(state));
	const judge = async <Q extends Questions>(request: JudgmentRequest<Q>, options?: JudgeOptions): Promise<JudgmentResult<Q>> => {
		const before = read();
		if (before.dispatched >= allowance) {
			write({ ...before, refused: before.refused + 1 });
			throw new Error("judge call refused: the run's judge allowance is spent");
		}
		write({ ...before, dispatched: before.dispatched + 1 });
		const result = await inner.judge(request, options);
		const after = read();
		const total = result.usage?.cost?.total;
		write({
			...after,
			returned: after.returned + 1,
			diagnosticUsd: [...after.diagnosticUsd, typeof total === "number" && Number.isFinite(total) && total >= 0 ? total : null],
			models: [...after.models, typeof result.model === "string" ? result.model : "unknown"],
		});
		return result;
	};
	// A prototype link keeps every other member of the host judge (label, primaryModel, sessionFallback) as it is.
	return Object.assign(Object.create(inner) as J, { judge });
}
