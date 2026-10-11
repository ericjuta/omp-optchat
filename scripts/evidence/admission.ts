/**
 * Per-host compressor admission ledger. The extension reads it, admits or refuses, and writes the next
 * state before each provider attempt, so a crash after a write over-counts and never under-counts.
 * Two ceilings apply: a call count and a reserved worst-case dollar total. Reservations are never released.
 */
export interface AdmissionState {
	readonly dispatched: number;
	readonly reservedUsd: number;
	/** Attempts refused by either ceiling. OptChat fails that summary, so a refusal explains a later turn refusal. */
	readonly refused: number;
}

export type AdmissionDecision =
	| { readonly admitted: true; readonly state: AdmissionState }
	| { readonly admitted: false; readonly reason: "call-cap" | "cost-cap"; readonly state: AdmissionState };

const FIELDS = ["dispatched", "reservedUsd", "refused"] as const;
const USD_DECIMAL = /^(?:\d+(?:\.\d+)?|\.\d+)$/;

export function initialAdmission(): AdmissionState {
	return { dispatched: 0, reservedUsd: 0, refused: 0 };
}

/** Parses a non-negative decimal dollar amount from an environment value. Scientific notation and signs are rejected. */
export function parseUsdDecimal(raw: string, name: string): number {
	if (!USD_DECIMAL.test(raw)) throw new Error(`${name} must be a non-negative decimal`);
	const value = Number(raw);
	if (!Number.isFinite(value)) throw new Error(`${name} must be a finite decimal`);
	return value;
}

/** Strict parse of the admission file. Throws on missing, unknown, or malformed fields. */
export function parseAdmissionState(value: unknown): AdmissionState {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("admission file is malformed");
	const record = value as Record<string, unknown>;
	if (Object.keys(record).sort().join(",") !== [...FIELDS].sort().join(",")) throw new Error("admission file has unexpected or missing fields");
	const { dispatched, reservedUsd, refused } = record;
	if (typeof dispatched !== "number" || !Number.isSafeInteger(dispatched) || dispatched < 0) throw new Error("admission dispatched must be a non-negative integer");
	if (typeof reservedUsd !== "number" || !Number.isFinite(reservedUsd) || reservedUsd < 0) throw new Error("admission reservedUsd must be a non-negative finite number");
	if (typeof refused !== "number" || !Number.isSafeInteger(refused) || refused < 0) throw new Error("admission refused must be a non-negative integer");
	return { dispatched, reservedUsd, refused };
}

/**
 * Admits one compressor call against the file state. Refuses when the call count is already at its
 * allowance, or when reserved dollars plus this call's worst case would exceed the dollar allowance.
 * On admission the returned state must be written before the request is sent; on refusal it records the refusal.
 */
export function admitCompressorCall(file: unknown, callAllowance: number, perCallUsd: number, usdAllowance: number): AdmissionDecision {
	const state = parseAdmissionState(file);
	if (!Number.isSafeInteger(callAllowance) || callAllowance < 0) throw new Error("call allowance must be a non-negative integer");
	if (!Number.isFinite(perCallUsd) || perCallUsd < 0) throw new Error("per-call USD must be a non-negative finite number");
	if (!Number.isFinite(usdAllowance) || usdAllowance < 0) throw new Error("USD allowance must be a non-negative finite number");
	const refusedState = { ...state, refused: state.refused + 1 };
	if (state.dispatched >= callAllowance) return { admitted: false, reason: "call-cap", state: refusedState };
	if (state.reservedUsd + perCallUsd > usdAllowance) return { admitted: false, reason: "cost-cap", state: refusedState };
	return { admitted: true, state: { ...state, dispatched: state.dispatched + 1, reservedUsd: state.reservedUsd + perCallUsd } };
}
