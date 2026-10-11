import { describe, expect, test } from "bun:test";
import { DollarReservations, mainPromptBoundUsd, offCompactionBoundUsd, type MainPromptBytes, type ModelRates } from "../scripts/evidence/cost.ts";

// Exact binary-fraction rates keep every boundary sum representable, so cap comparisons are exact.
// The cache-write rate is the dearest input-side rate; the cache-read rate is the cheapest.
const RATES: ModelRates = { inputRate: 1, outputRate: 4, cacheReadRate: 0.5, cacheWriteRate: 2, contextWindow: 1_000_000, maxOutput: 64_000 };
const BYTES: MainPromptBytes = { system: 100, tools: 200, history: 300, question: 50, retrieval: 64_000 };
// 64650 bytes bound 64650 tokens, priced at 2 per token; a 4096-token output cap is priced at 4 per token.
const ONE_CALL_USD = (64_650 * 2 + 4_096 * 4) / 1e6;

describe("main prompt bound", () => {
	test("tokens are bounded by bytes, priced at the dearest input-side rate, and multiplied by calls only", () => {
		expect(mainPromptBoundUsd(RATES, BYTES, 4096, 1)).toBeCloseTo(ONE_CALL_USD, 12);
		expect(mainPromptBoundUsd(RATES, BYTES, 4096, 8)).toBeCloseTo(8 * ONE_CALL_USD, 12);
		expect(mainPromptBoundUsd(RATES, BYTES, 4096, 0)).toBe(0);
	});

	test("prompt tokens are clamped to the context window, not the byte total", () => {
		expect(mainPromptBoundUsd({ ...RATES, contextWindow: 1000 }, BYTES, 4096, 1)).toBeCloseTo((1000 * 2 + 4096 * 4) / 1e6, 12);
	});

	test("the pinned output cap, not the context window, prices the output side", () => {
		const bound = mainPromptBoundUsd(RATES, BYTES, 4096, 1);
		expect(bound).not.toBeNull();
		expect(bound!).toBeLessThan(0.2);
		expect(mainPromptBoundUsd(RATES, BYTES, 32_000, 1)).toBeCloseTo((64_650 * 2 + 32_000 * 4) / 1e6, 12);
	});

	test("an unknown rate, context window, model, or output cap returns null", () => {
		expect(mainPromptBoundUsd(null, BYTES, 4096, 1)).toBeNull();
		expect(mainPromptBoundUsd({ ...RATES, inputRate: null }, BYTES, 4096, 1)).toBeNull();
		expect(mainPromptBoundUsd({ ...RATES, cacheWriteRate: null }, BYTES, 4096, 1)).toBeNull();
		expect(mainPromptBoundUsd({ ...RATES, outputRate: Number.NaN }, BYTES, 4096, 1)).toBeNull();
		expect(mainPromptBoundUsd({ ...RATES, contextWindow: null }, BYTES, 4096, 1)).toBeNull();
		expect(mainPromptBoundUsd(RATES, BYTES, 0, 1)).toBeNull();
		expect(mainPromptBoundUsd(RATES, BYTES, 1.5, 1)).toBeNull();
	});

	test("invalid byte counts and call counts are programming errors", () => {
		expect(() => mainPromptBoundUsd(RATES, { ...BYTES, system: -1 }, 4096, 1)).toThrow("non-negative safe integers");
		expect(() => mainPromptBoundUsd(RATES, { ...BYTES, tools: 1.5 }, 4096, 1)).toThrow("non-negative safe integers");
		expect(() => mainPromptBoundUsd(RATES, { ...BYTES, system: Number.MAX_SAFE_INTEGER, tools: 1 }, 4096, 1)).toThrow("safe integer");
		expect(() => mainPromptBoundUsd(RATES, BYTES, 4096, -1)).toThrow("max calls");
	});
});

describe("off-arm compaction bound", () => {
	test("tokens are the bytes plus 4096 overhead, with no four-bytes-per-token division", () => {
		// 400 + 40 + 4096 = 4536 tokens at the cache-write rate, plus the default 64000-token output ceiling.
		expect(offCompactionBoundUsd(RATES, 400, 40)).toBeCloseTo((4_536 * 2 + 64_000 * 4) / 1e6, 12);
	});

	test("the bound grows with prior-turn bytes at the full input rate", () => {
		const shortHistory = offCompactionBoundUsd(RATES, 4_000, 40);
		const longHistory = offCompactionBoundUsd(RATES, 44_000, 40);
		expect(shortHistory).not.toBeNull();
		expect(longHistory!).toBeGreaterThan(shortHistory!);
		expect(longHistory! - shortHistory!).toBeCloseTo((40_000 * 2) / 1e6, 12);
	});

	test("an explicit output cap replaces the catalog ceiling; a missing one fails closed", () => {
		expect(offCompactionBoundUsd(RATES, 0, 0, 1000)).toBeCloseTo((4_096 * 2 + 1000 * 4) / 1e6, 12);
		expect(offCompactionBoundUsd(RATES, 0, 0, null)).toBeNull();
		expect(offCompactionBoundUsd({ ...RATES, maxOutput: null }, 0, 0)).toBeNull();
		expect(offCompactionBoundUsd({ ...RATES, inputRate: null }, 0, 0, 1000)).toBeNull();
		expect(offCompactionBoundUsd(null, 0, 0)).toBeNull();
	});

	test("invalid byte counts are programming errors", () => {
		expect(() => offCompactionBoundUsd(RATES, -1, 0)).toThrow("history bytes");
		expect(() => offCompactionBoundUsd(RATES, 0, 0.5)).toThrow("prompt bytes");
	});
});

describe("dollar reservations: cap boundary", () => {
	test("a prompt is admitted exactly when committed plus its bound reaches the cap, and refused one step past it", () => {
		const ledger = new DollarReservations(10);
		expect(ledger.reservePrompt("p1", 9.5)).toEqual({ admitted: true });
		expect(ledger.reservePrompt("p2", 0.5)).toEqual({ admitted: true });
		expect(ledger.committedUsd).toBe(10);
		expect(ledger.reservePrompt("p3", 0.25)).toEqual({ admitted: false, reason: "cost-cap" });
		expect(ledger.committedUsd).toBe(10);
	});

	test("the refusal boundary of a computed main bound is exact", () => {
		const bound = mainPromptBoundUsd(RATES, BYTES, 4096, 1)!;
		expect(new DollarReservations(bound).reservePrompt("p", bound)).toEqual({ admitted: true });
		expect(new DollarReservations(bound * 0.999).reservePrompt("p", bound)).toEqual({ admitted: false, reason: "cost-cap" });
	});

	test("a host allowance is the share of remaining cap, or its build need when that is smaller", () => {
		const ledger = new DollarReservations(10);
		expect(ledger.reserveHost("h1", 0.5)).toBe(5);
		expect(ledger.reserveHost("h2", 0.5, 1)).toBe(1);
		expect(ledger.committedUsd).toBe(6);
		expect(ledger.reserveHost("h3", 1)).toBe(4);
		expect(ledger.committedUsd).toBe(10);
	});
});

describe("dollar reservations: release and concurrency", () => {
	test("a stopped host releases its unused allowance and keeps only its observed spend", () => {
		const ledger = new DollarReservations(10);
		expect(ledger.reserveHost("h", 0.5)).toBe(5);
		ledger.releaseHost("h", 0.75);
		expect(ledger.observedUsd).toBe(0.75);
		expect(ledger.committedUsd).toBe(0.75);
		expect(ledger.admitPrompt(9.25)).toEqual({ admitted: true });
		expect(ledger.admitPrompt(9.5)).toEqual({ admitted: false, reason: "cost-cap" });
	});

	test("interleaved host and prompt reservations never allocate the same dollars twice", () => {
		const ledger = new DollarReservations(10);
		expect(ledger.reserveHost("h1", 0.5)).toBe(5);
		expect(ledger.reservePrompt("p1", 3)).toEqual({ admitted: true });
		expect(ledger.reserveHost("h2", 0.5)).toBe(1);
		expect(ledger.reservePrompt("p2", 1.5)).toEqual({ admitted: false, reason: "cost-cap" });
		expect(ledger.reservePrompt("p3", 1)).toEqual({ admitted: true });
		expect(ledger.committedUsd).toBe(10);
		expect(ledger.admitPrompt(0.0001)).toEqual({ admitted: false, reason: "cost-cap" });
		expect(ledger.reserveHost("h3", 1)).toBe(0);
	});

	test("ids share one namespace; reusing a live id throws", () => {
		const ledger = new DollarReservations(10);
		ledger.reservePrompt("a", 1);
		expect(() => ledger.reservePrompt("a", 1)).toThrow("duplicate reservation id");
		expect(() => ledger.reserveHost("a", 0.5)).toThrow("duplicate reservation id");
		ledger.reserveHost("h", 0.5);
		expect(() => ledger.reserveHost("h", 0.5)).toThrow("duplicate reservation id");
		expect(() => ledger.reservePrompt("h", 1)).toThrow("duplicate reservation id");
	});

	test("releasing a prompt replaces its bound with observed spend and frees the difference", () => {
		const ledger = new DollarReservations(10);
		ledger.reservePrompt("p1", 3);
		ledger.reservePrompt("p2", 4);
		ledger.releasePrompt("p1", 2.5);
		expect(ledger.observedUsd).toBe(2.5);
		expect(ledger.committedUsd).toBe(6.5);
		expect(ledger.admitPrompt(3.5)).toEqual({ admitted: true });
	});

	test("a release that overspends its reservation throws and keeps the reservation live", () => {
		const ledger = new DollarReservations(10);
		ledger.reservePrompt("p", 2);
		expect(() => ledger.releasePrompt("p", 2.5)).toThrow("exceeds its reservation");
		expect(ledger.observedUsd).toBe(0);
		expect(ledger.committedUsd).toBe(2);
		ledger.releasePrompt("p", 2);
		expect(ledger.observedUsd).toBe(2);
		expect(ledger.committedUsd).toBe(2);
	});

	test("releasing an id that holds no live reservation throws", () => {
		const ledger = new DollarReservations(10);
		expect(() => ledger.releaseHost("missing", 0)).toThrow("no live reservation");
		expect(() => ledger.releasePrompt("missing", 0)).toThrow("no live reservation");
	});

	test("recorded spend counts toward the cap and never stops being observed", () => {
		const ledger = new DollarReservations(10);
		ledger.recordSpend(4);
		expect(ledger.admitPrompt(6)).toEqual({ admitted: true });
		expect(ledger.admitPrompt(6.5)).toEqual({ admitted: false, reason: "cost-cap" });
	});

	test("invalid shares, build needs, and spends throw without changing the ledger", () => {
		const ledger = new DollarReservations(10);
		expect(() => ledger.reserveHost("h", 0)).toThrow("host share");
		expect(() => ledger.reserveHost("h", 1.5)).toThrow("host share");
		expect(() => ledger.reserveHost("h", Number.NaN)).toThrow("host share");
		expect(() => ledger.reserveHost("h", 0.5, -1)).toThrow("build need");
		expect(() => ledger.recordSpend(-1)).toThrow("non-negative");
		expect(ledger.committedUsd).toBe(0);
		expect(ledger.reserveHost("h", 0.5)).toBe(5);
	});
});

describe("dollar reservations: unknown values fail closed", () => {
	test("an unknown rate refuses the prompt with unknown-cost and reserves nothing", () => {
		const ledger = new DollarReservations(10);
		const bound = mainPromptBoundUsd({ ...RATES, inputRate: null }, BYTES, 4096, 1);
		expect(bound).toBeNull();
		expect(ledger.reservePrompt("p", bound)).toEqual({ admitted: false, reason: "unknown-cost" });
		expect(ledger.committedUsd).toBe(0);
		expect(ledger.reservePrompt("p", 1)).toEqual({ admitted: true });
	});

	test("unobservable spend refuses every later admission and yields no host allowance", () => {
		const ledger = new DollarReservations(10);
		ledger.recordSpend(null);
		expect(ledger.observedUsd).toBeNull();
		expect(ledger.committedUsd).toBeNull();
		expect(ledger.admitPrompt(0)).toEqual({ admitted: false, reason: "unknown-cost" });
		expect(ledger.reservePrompt("p", 0)).toEqual({ admitted: false, reason: "unknown-cost" });
		expect(ledger.reserveHost("h", 0.5)).toBeNull();
		ledger.recordSpend(0);
		ledger.releaseHost("h", 0);
		expect(ledger.observedUsd).toBeNull();
		expect(ledger.committedUsd).toBeNull();
	});

	test("an unknown compressor spend at release makes the whole ledger unknown", () => {
		const ledger = new DollarReservations(10);
		expect(ledger.reserveHost("h", 0.5)).toBe(5);
		ledger.releaseHost("h", null);
		expect(ledger.observedUsd).toBeNull();
		expect(ledger.admitPrompt(0.5)).toEqual({ admitted: false, reason: "unknown-cost" });
	});

	test("an unknown prompt spend at release makes the whole ledger unknown", () => {
		const ledger = new DollarReservations(10);
		ledger.reservePrompt("p", 2);
		ledger.releasePrompt("p", null);
		expect(ledger.committedUsd).toBeNull();
		expect(ledger.reserveHost("h", 0.5)).toBeNull();
	});
});
