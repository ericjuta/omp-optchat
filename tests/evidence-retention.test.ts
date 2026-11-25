import { describe, expect, test } from "bun:test";
import { type Grade, retentionReport, type Side, signTestP } from "../scripts/evidence/retention.ts";

const RIGHT: Grade = { correct: true, valueCorrect: true, grounded: true, hallucinated: false };
const WRONG: Grade = { correct: false, valueCorrect: false, grounded: false, hallucinated: false };
/** The value is right but no citation supports it. */
const UNGROUNDED: Grade = { correct: false, valueCorrect: true, grounded: false, hallucinated: false };

function side(arm: "on" | "off", grades: Record<string, Grade>, extra: Partial<Side> = {}): Side {
	return {
		file: `${arm}.json`,
		arm,
		compressor: arm === "on" ? "p/small" : null,
		viewBytes: arm === "on" ? 128_000 : null,
		providerMode: "live",
		host: "omp/19.2.1",
		pluginCommit: "abc",
		main: "p/main",
		turnMode: "per-question",
		seed: 1,
		digest: "d1",
		sources: 128,
		minSourceBytes: 1024,
		historyBytes: 140_000,
		grades: new Map(Object.entries(grades)),
		costUsd: { lowUsd: 1, highUsd: 1 },
		mainPromptTokens: 1000,
		compactions: 0,
		viewLines: null,
		...extra,
	};
}

describe("retention report", () => {
	test("retention is the view's correct answers over the whole-history arm's, on the questions both arms were judged on", () => {
		const report = retentionReport([
			side("on", { q1: RIGHT, q2: WRONG, q3: UNGROUNDED, q4: RIGHT, onlyOn: RIGHT }),
			side("off", { q1: RIGHT, q2: RIGHT, q3: RIGHT, q4: WRONG, onlyOff: RIGHT }),
		]);
		expect(report.retention).toHaveLength(1);
		const [row] = report.retention;
		expect(row!.on).toMatchObject({ judged: 4, correct: 2, valueCorrect: 3 });
		expect(row!.off).toMatchObject({ judged: 4, correct: 3, valueCorrect: 3 });
		expect(row!.retention).toBeCloseTo(2 / 3);
		expect(row!.valueRetention).toBe(1);
		expect(row!.paired).toMatchObject({ both: 1, firstOnly: 1, secondOnly: 2, neither: 0, unpaired: 2 });
	});

	test("an off arm that compacted is not a whole-history baseline and is left out", () => {
		const report = retentionReport([
			side("on", { q1: RIGHT }, { file: "fits-on.json", seed: 1, digest: "d1" }),
			side("off", { q1: RIGHT }, { seed: 1, digest: "d1" }),
			side("on", { q1: RIGHT }, { file: "compacted-on.json", seed: 2, digest: "d2" }),
			side("off", { q1: WRONG }, { seed: 2, digest: "d2", compactions: 1 }),
		]);
		const [row] = report.retention;
		expect(row!.baselineRuns).toBe(1);
		expect(row!.retention).toBe(1);
		expect(row!.excluded.map((entry) => entry.file)).toEqual(["compacted-on.json"]);
	});

	test("retention is undefined, not zero or infinite, when the whole-history arm got nothing right", () => {
		const [row] = retentionReport([side("on", { q1: RIGHT }), side("off", { q1: WRONG })]).retention;
		expect(row!.retention).toBeNull();
		expect(row!.valueRetention).toBeNull();
	});

	test("an unobserved cost in any pooled run makes the pooled cost unknown", () => {
		const [row] = retentionReport([
			side("on", { q1: RIGHT }, { seed: 1, digest: "d1" }),
			side("off", { q1: RIGHT }, { seed: 1, digest: "d1" }),
			side("on", { q1: RIGHT }, { seed: 2, digest: "d2", costUsd: null }),
			side("off", { q1: RIGHT }, { seed: 2, digest: "d2" }),
		]).retention;
		expect(row!.onCostUsd).toBeNull();
		expect(row!.offCostUsd).toEqual({ lowUsd: 2, highUsd: 2 });
	});

	test("different chat lengths get their own rows, shortest first", () => {
		const long = { sources: 512, historyBytes: 560_000, digest: "long" };
		const short = { sources: 48, historyBytes: 52_000, digest: "short" };
		const report = retentionReport([side("on", { q1: WRONG }, long), side("off", { q1: RIGHT }, long), side("on", { q1: RIGHT }, short), side("off", { q1: RIGHT }, short)]);
		expect(report.retention.map((row) => [row.sources, row.retention])).toEqual([[48, 1], [512, 0]]);
	});

	test("two view budgets pair on the same corpus only, and each gets its retention against the one whole-history run", () => {
		const report = retentionReport([
			side("off", { q1: RIGHT, q2: RIGHT }),
			side("on", { q1: RIGHT, q2: RIGHT }, { viewBytes: 128_000, viewLines: 250 }),
			side("on", { q1: RIGHT, q2: WRONG }, { viewBytes: 64_000, viewLines: 125, costUsd: { lowUsd: 0.5, highUsd: 0.5 } }),
			// Seed 2 ran at one budget only and has no whole-history run, so it pairs with nothing.
			side("on", { q1: WRONG, q2: WRONG }, { file: "s2.json", seed: 2, digest: "d2", viewBytes: 128_000 }),
		]);
		expect(report.retention.map((row) => [row.viewBytes, row.baselineRuns, row.retention])).toEqual([[128_000, 1, 1], [64_000, 1, 0.5]]);
		expect(report.retention[0]!.excluded.map((entry) => entry.file)).toEqual(["s2.json"]);
		expect(report.viewSize).toHaveLength(1);
		const [row] = report.viewSize;
		expect(row!.seeds).toEqual([1]);
		expect(row!.larger).toMatchObject({ viewBytes: 128_000, judged: 2, correct: 2, viewLines: [250], costUsd: { lowUsd: 1, highUsd: 1 } });
		expect(row!.smaller).toMatchObject({ viewBytes: 64_000, judged: 2, correct: 1, viewLines: [125], costUsd: { lowUsd: 0.5, highUsd: 0.5 } });
		expect(row!.paired).toMatchObject({ both: 1, firstOnly: 1, secondOnly: 0, neither: 0 });
	});

	test("view-size runs with no whole-history run report no retention row", () => {
		const report = retentionReport([side("on", { q1: RIGHT }, { viewBytes: 128_000 }), side("on", { q1: RIGHT }, { viewBytes: 64_000 })]);
		expect(report.retention).toEqual([]);
		expect(report.viewSize).toHaveLength(1);
	});

	test("arms asked of different main models never pair", () => {
		const report = retentionReport([
			side("off", { q1: RIGHT }, { main: "p/a" }),
			side("on", { q1: RIGHT }, { main: "p/b", viewBytes: 128_000 }),
			side("on", { q1: WRONG }, { main: "p/a", viewBytes: 64_000 }),
		]);
		expect(report.retention.map((row) => [row.main, row.retention])).toEqual([["p/a", 0]]);
		expect(report.viewSize).toEqual([]);
	});

	test("the same arm passed twice is refused instead of counted twice", () => {
		const one = side("on", { q1: RIGHT });
		expect(() => retentionReport([one, { ...one, file: "copy.json" }])).toThrow("copy.json");
	});
});

describe("sign test", () => {
	test("matches exact two-sided binomial values", () => {
		expect(signTestP(0, 0)).toBeNull();
		expect(signTestP(1, 4)).toBeCloseTo(0.375, 10);
		expect(signTestP(4, 1)).toBeCloseTo(0.375, 10);
		expect(signTestP(0, 6)).toBeCloseTo(0.03125, 10);
		expect(signTestP(5, 5)).toBe(1);
	});
});
