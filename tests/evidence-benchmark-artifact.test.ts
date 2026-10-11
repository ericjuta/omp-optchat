import { describe, expect, test } from "bun:test";
import {
	ARTIFACT_SCHEMA,
	armCacheReadShare,
	armTotalCost,
	mainSteadyStateCacheReadShare,
	maintenanceSummary,
	pairedComparison,
	roleCacheReadShare,
	summarizeUsage,
	validateArtifact,
	type ArmSide,
	type PairedComparison,
	type UsageRecord,
} from "../scripts/evidence/artifact.ts";
import { CORPUS_VERSION } from "../scripts/evidence/corpus.ts";

const record = (overrides: Partial<UsageRecord> = {}): UsageRecord => ({
	role: "main",
	purpose: "turn",
	input: 40,
	output: 10,
	cacheRead: 60,
	cacheWrite: 0,
	costUsd: 0.02,
	costSource: "sdk-reported",
	latencyMs: 100,
	...overrides,
});

const accuracy = { judged: 1, correct: 1, valueCorrect: 1, grounded: 1, abstained: 0, hallucinated: 0, incorrectSchema: 0 };
const unavailableCompressor = { status: "unavailable", reason: "no metrics sink" };
const limitsBlock = { maxCalls: 80, maxCompressorOutputTokens: 512, deadlineMs: 600_000, expiryWaitMs: null, enforcement: "prompt-admission", callsUsed: 2, violations: [], maxCostUsd: 5, spentUsd: 0.1, costEnforcement: "dollar-admission" };
const corpusBlock = { version: CORPUS_VERSION, seed: 1, digest: "a".repeat(64), sources: 24, minSourceBytes: 512, questionsTotal: 8, questionsSelected: 8 };

const zeroMaintenance = maintenanceSummary({ compactions: 0, interval: null });
const estimatedMaintenance = maintenanceSummary({ compactions: 1, interval: { lowUsd: 0.001, highUsd: 0.004 } });
const unobservedMaintenance = maintenanceSummary({ compactions: 1, interval: null, reason: "auto_compaction_end carried no result" });

type ArmParts = Pick<ArmSide, "main" | "compressor" | "auxiliary" | "maintenance">;

/** A completed arm side. Totals and shares are derived from the parts, so fixtures satisfy the cross-checks. Overrides replace fields wholesale. */
function side(parts: Partial<ArmParts> = {}, overrides: Partial<ArmSide> = {}): ArmSide {
	const full: ArmParts = {
		main: summarizeUsage([record()]),
		compressor: summarizeUsage([]),
		auxiliary: summarizeUsage([]),
		maintenance: zeroMaintenance,
		...parts,
	};
	const totalCost = armTotalCost(full);
	const cacheReadShare =
		full.main === null || full.compressor === null || full.auxiliary === null ? null : armCacheReadShare([full.main, full.compressor, full.auxiliary, full.maintenance]);
	return {
		status: "completed",
		reason: null,
		...full,
		totalCost,
		totalCostReason: totalCost === null ? (full.maintenance.reason ?? "a role is unobserved") : null,
		totalPromptTokens: 100,
		cacheReadShare,
		cacheReadShareByRole: {
			main: roleCacheReadShare(full.main),
			compressor: roleCacheReadShare(full.compressor),
			auxiliary: roleCacheReadShare(full.auxiliary),
		},
		mainSteadyStateCacheReadShare: null,
		latencyMsPerTurn: [100],
		accuracy,
		...overrides,
	};
}

function unavailableSide(reason: string): ArmSide {
	return {
		status: "unavailable",
		reason,
		main: null,
		compressor: null,
		auxiliary: null,
		maintenance: zeroMaintenance,
		totalCost: null,
		totalCostReason: reason,
		totalPromptTokens: null,
		cacheReadShare: null,
		cacheReadShareByRole: { main: null, compressor: null, auxiliary: null },
		mainSteadyStateCacheReadShare: null,
		latencyMsPerTurn: [],
		accuracy: null,
	};
}

function requireDelta(comparison: PairedComparison): NonNullable<PairedComparison["delta"]> {
	if (comparison.delta === null) throw new Error(`expected a delta: ${comparison.reason}`);
	return comparison.delta;
}

function phase(arm: "on" | "off", compressor: string | null): Record<string, unknown> {
	return {
		name: "cold",
		model: "synthetic/main",
		arm,
		compressor,
		latencyMs: 120,
		usage: { main: summarizeUsage([record()]), compressor: unavailableCompressor, auxiliary: summarizeUsage([]) },
		maintenance: zeroMaintenance,
		turns: [],
		questions: [],
		tree: null,
		error: null,
		refusal: null,
		timestamps: null,
	};
}

/** A well-formed v3 artifact running both arms with one compressor. Top-level overrides replace fields wholesale. */
function artifact(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		schema: ARTIFACT_SCHEMA,
		generatedAt: "2026-10-11T00:00:00.000Z",
		status: "completed",
		error: null,
		synthetic: true,
		arms: ["on", "off"],
		turnMode: "batch",
		requestedExperiments: [],
		experiments: { child: null },
		questionEmphasis: "balanced",
		viewBytes: 4096,
		corpus: corpusBlock,
		limits: limitsBlock,
		scenarios: [{ name: "cold", status: "completed", reason: null, phases: [phase("on", "synthetic/compressor"), phase("off", null)] }],
		paired: [pairedComparison({ compressor: "synthetic/compressor", on: side(), off: side({}, { cacheReadShare: 0.3 }) })],
		accuracy: {},
		limitations: ["synthetic provider only"],
		...overrides,
	};
}

function withMaintenance(maintenance: unknown): Record<string, unknown> {
	return artifact({ scenarios: [{ name: "cold", status: "completed", reason: null, phases: [{ ...phase("on", "synthetic/compressor"), maintenance }] }] });
}

function withAuxiliary(auxiliary: unknown): Record<string, unknown> {
	const usage = { main: summarizeUsage([record()]), compressor: unavailableCompressor, auxiliary };
	return artifact({ scenarios: [{ name: "cold", status: "completed", reason: null, phases: [{ ...phase("on", "synthetic/compressor"), usage }] }] });
}

describe("benchmark artifact v3 schema", () => {
	test("a well-formed v3 artifact with both arms and a paired comparison is valid", () => {
		expect(validateArtifact(artifact())).toEqual([]);
	});

	test("the /2 schema is rejected", () => {
		const errors = validateArtifact(artifact({ schema: "optchat-evidence-recall/2" }));
		expect(errors.some((error) => error.startsWith("$.schema"))).toBe(true);
	});

	test("arms must be a non-empty subset of on and off with no duplicates", () => {
		expect(validateArtifact(artifact({ arms: [] })).length).toBeGreaterThan(0);
		expect(validateArtifact(artifact({ arms: ["on", "on"] })).length).toBeGreaterThan(0);
		expect(validateArtifact(artifact({ arms: ["on", "maybe"] })).length).toBeGreaterThan(0);
	});

	test("paired comparisons must be empty unless both arms ran", () => {
		const single = artifact({ arms: ["on"], paired: [] });
		expect(validateArtifact(single)).toEqual([]);
		expect(validateArtifact(artifact({ arms: ["on"] })).length).toBeGreaterThan(0);
	});

	test("the question emphasis and turn mode are closed sets; batch turn mode carries no per-question turns", () => {
		expect(validateArtifact(artifact({ questionEmphasis: "hard" })).length).toBeGreaterThan(0);
		expect(validateArtifact(artifact({ turnMode: "stream" })).length).toBeGreaterThan(0);
		const turn = { questionId: "owner-Lumen", latencyMs: 9, usage: summarizeUsage([record()]) };
		const batchWithTurn = artifact({ scenarios: [{ name: "cold", status: "completed", reason: null, phases: [{ ...phase("on", "synthetic/compressor"), turns: [turn] }] }] });
		expect(validateArtifact(batchWithTurn).length).toBeGreaterThan(0);
		const perQuestion = artifact({ turnMode: "per-question", scenarios: [{ name: "cold", status: "completed", reason: null, phases: [{ ...phase("on", "synthetic/compressor"), turns: [turn] }] }] });
		expect(validateArtifact(perQuestion)).toEqual([]);
	});

	test("corpus sources must be sixteen to five hundred twelve", () => {
		expect(validateArtifact(artifact({ corpus: { ...corpusBlock, sources: 16 } }))).toEqual([]);
		expect(validateArtifact(artifact({ corpus: { ...corpusBlock, sources: 512 } }))).toEqual([]);
		expect(validateArtifact(artifact({ corpus: { ...corpusBlock, sources: 15 } })).length).toBeGreaterThan(0);
		expect(validateArtifact(artifact({ corpus: { ...corpusBlock, sources: 513 } })).length).toBeGreaterThan(0);
	});

	test("a phase stopped by the dollar cap or an unknown cost validates; other refusal names do not", () => {
		const stopped = (refusal: string) =>
			artifact({ status: "budget-stopped", scenarios: [{ name: "cold", status: "budget-stopped", reason: "a prompt was refused by admission", phases: [{ ...phase("on", "synthetic/compressor"), refusal }, phase("off", null)] }] });
		expect(validateArtifact(stopped("cost-cap"))).toEqual([]);
		expect(validateArtifact(stopped("unknown-cost"))).toEqual([]);
		expect(validateArtifact(stopped("budget")).some((error) => error.endsWith(".refusal must be maxCalls, deadline, cost-cap, unknown-cost, or null"))).toBe(true);
	});

	test("the cost ceiling is at most thirty dollars and cost enforcement is named", () => {
		expect(validateArtifact(artifact({ limits: { ...limitsBlock, maxCostUsd: 30 } }))).toEqual([]);
		expect(validateArtifact(artifact({ limits: { ...limitsBlock, maxCostUsd: 31 } })).length).toBeGreaterThan(0);
		expect(validateArtifact(artifact({ limits: { ...limitsBlock, maxCostUsd: 0 } })).length).toBeGreaterThan(0);
		expect(validateArtifact(artifact({ limits: { ...limitsBlock, costEnforcement: "soft" } })).length).toBeGreaterThan(0);
	});
});

describe("maintenance observability", () => {
	test("zero compactions is observed zero; an estimate is an ordered interval; an unobserved estimate needs a reason", () => {
		expect(zeroMaintenance).toMatchObject({ costUsd: 0, complete: true, estimated: false, costUsdLow: 0, costUsdHigh: 0, reason: null });
		expect(validateArtifact(withMaintenance(zeroMaintenance))).toEqual([]);
		expect(validateArtifact(withMaintenance(estimatedMaintenance))).toEqual([]);
		expect(validateArtifact(withMaintenance(unobservedMaintenance))).toEqual([]);
		expect(validateArtifact(withMaintenance({ ...unobservedMaintenance, reason: null })).length).toBeGreaterThan(0);
		expect(validateArtifact(withMaintenance({ ...zeroMaintenance, costUsd: null, complete: false })).length).toBeGreaterThan(0);
	});

	test("an unavailable marker in place of a maintenance summary is rejected", () => {
		const marker = { status: "unavailable", reason: "not metered", compactions: 0 };
		expect(validateArtifact(withMaintenance(marker)).length).toBeGreaterThan(0);
	});

	test("the compaction interval must be ordered, finite, and non-negative; token counters stay null", () => {
		expect(validateArtifact(withMaintenance({ ...estimatedMaintenance, costUsdLow: 0.004, costUsdHigh: 0.001 })).length).toBeGreaterThan(0);
		expect(validateArtifact(withMaintenance({ ...estimatedMaintenance, costUsdHigh: Number.NaN })).length).toBeGreaterThan(0);
		expect(validateArtifact(withMaintenance({ ...estimatedMaintenance, costUsdLow: -0.001 })).length).toBeGreaterThan(0);
		expect(validateArtifact(withMaintenance({ ...estimatedMaintenance, input: 5 })).length).toBeGreaterThan(0);
	});

	test("interval keys cannot carry claim words", () => {
		expect(validateArtifact(withMaintenance({ ...estimatedMaintenance, billedHighUsd: 0.01 })).length).toBeGreaterThan(0);
	});
});

describe("auxiliary usage", () => {
	test("auxiliary is a phase summary separate from main and compressor; a missing one is rejected", () => {
		const auxiliary = summarizeUsage([record({ role: "auxiliary", purpose: "cache-warm", input: 5, output: 1, cacheRead: 0, cacheWrite: 0, costUsd: 0.001 })]);
		expect(validateArtifact(withAuxiliary(auxiliary))).toEqual([]);
		expect(validateArtifact(withAuxiliary(undefined)).length).toBeGreaterThan(0);
	});

	test("auxiliary cost joins the arm total as a point value; a null role leaves the total unobserved", () => {
		const total = armTotalCost({
			main: summarizeUsage([record({ costUsd: 0.02 })]),
			compressor: summarizeUsage([]),
			auxiliary: summarizeUsage([record({ role: "auxiliary", costUsd: 0.001 })]),
			maintenance: zeroMaintenance,
		});
		expect(total?.lowUsd).toBeCloseTo(0.021, 10);
		expect(total?.highUsd).toBeCloseTo(0.021, 10);
		expect(total?.estimated).toBe(false);
		expect(armTotalCost({ main: summarizeUsage([record()]), compressor: null, auxiliary: summarizeUsage([]), maintenance: zeroMaintenance })).toBeNull();
		expect(armTotalCost({ main: summarizeUsage([record()]), compressor: summarizeUsage([]), auxiliary: summarizeUsage([]), maintenance: unobservedMaintenance })).toBeNull();
	});
});

describe("paired comparison", () => {
	test("the delta is null with a reason when the off arm is unavailable", () => {
		const comparison = pairedComparison({ compressor: "synthetic/compressor", on: side(), off: unavailableSide("off arm refused") });
		expect(comparison.delta).toBeNull();
		expect(comparison.reason).toBe("off arm unavailable: off arm refused");
		expect(validateArtifact(artifact({ paired: [comparison] }))).toEqual([]);
	});

	test("the cost delta is off minus on as a point interval; shares are on minus off", () => {
		const comparison = pairedComparison({
			compressor: "synthetic/compressor",
			on: side(),
			off: side({ main: summarizeUsage([record({ costUsd: 0.05, input: 70, cacheRead: 30 })]) }),
		});
		expect(comparison.reason).toBeNull();
		expect(requireDelta(comparison).totalCost.lowUsd).toBeCloseTo(0.03, 10);
		expect(requireDelta(comparison).totalCost.highUsd).toBeCloseTo(0.03, 10);
		expect(requireDelta(comparison).cacheReadShare).toBeCloseTo(0.3, 10);
		expect(requireDelta(comparison).mainSteadyStateCacheReadShare).toBeNull();
		expect(requireDelta(comparison).accuracy).toEqual({ correct: 0, valueCorrect: 0, grounded: 0, hallucinated: 0 });
		expect(validateArtifact(artifact({ paired: [comparison] }))).toEqual([]);
	});

	test("an estimated maintenance interval makes the cost delta an interval that brackets both sides", () => {
		const on = side({ maintenance: estimatedMaintenance });
		expect(on.totalCost?.lowUsd).toBeCloseTo(0.021, 10);
		expect(on.totalCost?.highUsd).toBeCloseTo(0.024, 10);
		expect(on.totalCost?.estimated).toBe(true);
		expect(on.cacheReadShare).toBeNull();
		const comparison = pairedComparison({ compressor: "synthetic/compressor", on, off: side({ main: summarizeUsage([record({ costUsd: 0.05 })]) }) });
		// off minus on: low = offLow - onHigh, high = offHigh - onLow
		expect(requireDelta(comparison).totalCost.lowUsd).toBeCloseTo(0.026, 10);
		expect(requireDelta(comparison).totalCost.highUsd).toBeCloseTo(0.029, 10);
		expect(requireDelta(comparison).cacheReadShare).toBeNull();
		expect(validateArtifact(artifact({ paired: [comparison] }))).toEqual([]);
	});

	test("an unobserved maintenance interval leaves the arm cost unobserved: no delta, and the reason names it", () => {
		const on = side({ maintenance: unobservedMaintenance });
		expect(on.totalCost).toBeNull();
		expect(on.cacheReadShare).toBeNull();
		const comparison = pairedComparison({ compressor: "synthetic/compressor", on, off: side() });
		expect(comparison.delta).toBeNull();
		expect(comparison.reason).toBe("on arm cost unobserved: auto_compaction_end carried no result");
		expect(validateArtifact(artifact({ paired: [comparison] }))).toEqual([]);
	});

	test("an unpriced main call leaves the arm cost unobserved", () => {
		const unpriced = side({ main: summarizeUsage([record({ costUsd: null, costSource: "unavailable" })]) });
		const comparison = pairedComparison({ compressor: "synthetic/compressor", on: unpriced, off: side() });
		expect(comparison.delta).toBeNull();
		expect(comparison.reason).toBe("on arm cost unobserved: a role is unobserved");
		expect(validateArtifact(artifact({ paired: [comparison] }))).toEqual([]);
	});

	test("a signed negative cost delta is valid, but a negative metric anywhere else is rejected", () => {
		const comparison = pairedComparison({
			compressor: "synthetic/compressor",
			on: side({ main: summarizeUsage([record({ costUsd: 0.05 })]) }),
			off: side({ main: summarizeUsage([record({ costUsd: 0.01 })]) }),
		});
		expect(requireDelta(comparison).totalCost.lowUsd).toBeCloseTo(-0.04, 10);
		expect(validateArtifact(artifact({ paired: [comparison] }))).toEqual([]);
		const negativeLatency = pairedComparison({ compressor: "synthetic/compressor", on: side({}, { latencyMsPerTurn: [-1] }), off: side() });
		expect(validateArtifact(artifact({ paired: [negativeLatency] })).length).toBeGreaterThan(0);
	});

	test("a single-point cost delta and a reversed delta interval are rejected", () => {
		const comparison = pairedComparison({ compressor: "synthetic/compressor", on: side(), off: side({ main: summarizeUsage([record({ costUsd: 0.05 })]) }) });
		const delta = requireDelta(comparison);
		expect(validateArtifact(artifact({ paired: [{ ...comparison, delta: { ...delta, totalCostUsd: 0.03 } }] })).length).toBeGreaterThan(0);
		expect(validateArtifact(artifact({ paired: [{ ...comparison, delta: { ...delta, totalCost: { lowUsd: 0.04, highUsd: 0.02 } } }] })).length).toBeGreaterThan(0);
	});

	test("a share delta is dropped when either side did not observe that share", () => {
		const comparison = pairedComparison({ compressor: "synthetic/compressor", on: side({ maintenance: estimatedMaintenance }), off: side() });
		const delta = requireDelta(comparison);
		expect(delta.cacheReadShare).toBeNull();
		expect(validateArtifact(artifact({ paired: [comparison] }))).toEqual([]);
		expect(validateArtifact(artifact({ paired: [{ ...comparison, delta: { ...delta, cacheReadShare: 0.1 } }] })).length).toBeGreaterThan(0);
	});

	test("side totals must agree with their parts", () => {
		const claimedPoint = side({}, { totalCost: { lowUsd: 0.02, highUsd: 0.02, estimated: true } });
		expect(validateArtifact(artifact({ paired: [pairedComparison({ compressor: "synthetic/compressor", on: claimedPoint, off: side() })] })).length).toBeGreaterThan(0);
		const claimedUnobserved = side({ maintenance: unobservedMaintenance }, { totalCost: { lowUsd: 0.02, highUsd: 0.02, estimated: false } });
		expect(validateArtifact(artifact({ paired: [pairedComparison({ compressor: "synthetic/compressor", on: claimedUnobserved, off: side() })] })).length).toBeGreaterThan(0);
	});
});

describe("cache shares", () => {
	test("the cache-read share sums counters across main and compressor usage", () => {
		const main = summarizeUsage([record({ input: 40, cacheRead: 60 })]);
		const compressor = summarizeUsage([record({ role: "compressor", input: 60, cacheRead: 40 })]);
		expect(main.promptTokens).toBe(100);
		expect(compressor.promptTokens).toBe(100);
		expect(armCacheReadShare([main, compressor])).toBe(0.5);
	});

	test("the cache-read share is null when any counter is unobserved, or there are no prompt tokens", () => {
		const main = summarizeUsage([record({ input: 40, cacheRead: 60 })]);
		expect(armCacheReadShare([main, summarizeUsage([record({ input: null })])])).toBeNull();
		expect(armCacheReadShare([])).toBeNull();
		expect(armCacheReadShare([summarizeUsage([record({ input: 0, cacheRead: 0, cacheWrite: 0 })])])).toBeNull();
		expect(roleCacheReadShare(null)).toBeNull();
	});

	test("an estimated or unobserved maintenance nulls the all-role share; zero compactions does not", () => {
		const main = summarizeUsage([record({ input: 40, cacheRead: 60 })]);
		expect(armCacheReadShare([main, estimatedMaintenance])).toBeNull();
		expect(armCacheReadShare([main, unobservedMaintenance])).toBeNull();
		expect(armCacheReadShare([main, zeroMaintenance])).toBeCloseTo(0.6, 10);
	});

	test("per-role shares come from each role's own counters", () => {
		const main = summarizeUsage([record({ input: 40, cacheRead: 60 })]);
		const compressor = summarizeUsage([record({ role: "compressor", input: 60, cacheRead: 40 })]);
		const auxiliary = summarizeUsage([record({ role: "auxiliary", purpose: "cache-warm", input: 90, cacheRead: 10 })]);
		const withRoles = side({ main, compressor, auxiliary });
		expect(withRoles.cacheReadShareByRole.main).toBeCloseTo(0.6, 10);
		expect(withRoles.cacheReadShareByRole.compressor).toBeCloseTo(0.4, 10);
		expect(withRoles.cacheReadShareByRole.auxiliary).toBeCloseTo(0.1, 10);
		expect(withRoles.cacheReadShare).toBeCloseTo(110 / 300, 10);
		expect(roleCacheReadShare(summarizeUsage([]))).toBeNull();
		expect(validateArtifact(artifact({ paired: [pairedComparison({ compressor: "synthetic/compressor", on: withRoles, off: side() })] }))).toEqual([]);
	});

	test("the main steady-state share uses only turns after the first", () => {
		const first = summarizeUsage([record({ input: 100, cacheRead: 0, cacheWrite: 0 })]);
		const second = summarizeUsage([record({ input: 10, cacheRead: 90, cacheWrite: 0 })]);
		expect(mainSteadyStateCacheReadShare([first, second])).toBeCloseTo(0.9, 10);
		expect(mainSteadyStateCacheReadShare([first])).toBeNull();
		expect(mainSteadyStateCacheReadShare([])).toBeNull();
		expect(mainSteadyStateCacheReadShare([first, summarizeUsage([record({ input: null, cacheRead: 90 })])])).toBeNull();
	});

	test("the steady-state share is not nulled by an estimated maintenance, and its delta needs both sides", () => {
		const first = summarizeUsage([record({ input: 100, cacheRead: 0, cacheWrite: 0 })]);
		const second = summarizeUsage([record({ input: 10, cacheRead: 90, cacheWrite: 0 })]);
		const on = side({ maintenance: estimatedMaintenance }, { mainSteadyStateCacheReadShare: mainSteadyStateCacheReadShare([first, second]) });
		expect(on.mainSteadyStateCacheReadShare).toBeCloseTo(0.9, 10);
		expect(on.cacheReadShare).toBeNull();
		const off = side({}, { mainSteadyStateCacheReadShare: mainSteadyStateCacheReadShare([first, summarizeUsage([record({ input: 50, cacheRead: 50 })])]) });
		expect(off.mainSteadyStateCacheReadShare).toBeCloseTo(0.5, 10);
		const comparison = pairedComparison({ compressor: "synthetic/compressor", on, off });
		expect(requireDelta(comparison).mainSteadyStateCacheReadShare).toBeCloseTo(0.4, 10);
		expect(requireDelta(comparison).cacheReadShare).toBeNull();
		expect(validateArtifact(artifact({ paired: [comparison] }))).toEqual([]);

		const withoutSteady = pairedComparison({ compressor: "synthetic/compressor", on, off: side() });
		expect(requireDelta(withoutSteady).mainSteadyStateCacheReadShare).toBeNull();
		expect(validateArtifact(artifact({ paired: [{ ...withoutSteady, delta: { ...requireDelta(withoutSteady), mainSteadyStateCacheReadShare: 0.4 } }] })).length).toBeGreaterThan(0);
	});
});

describe("claim and bound rules", () => {
	test("a savings claim is rejected anywhere in the artifact", () => {
		expect(validateArtifact(artifact({ savings: 1 })).length).toBeGreaterThan(0);
		const comparison = pairedComparison({ compressor: "synthetic/compressor", on: side(), off: side() });
		const nested = { ...comparison, on: { ...comparison.on, savingsUsd: 1 } };
		expect(validateArtifact(artifact({ paired: [nested] })).length).toBeGreaterThan(0);
	});

	test("an interval delta cannot carry a savings-shaped key", () => {
		const comparison = pairedComparison({ compressor: "synthetic/compressor", on: side({ maintenance: estimatedMaintenance }), off: side() });
		const claimed = { ...comparison, delta: { ...requireDelta(comparison), savedLowUsd: 0.01 } };
		expect(validateArtifact(artifact({ paired: [claimed] })).some((error) => error.includes("savings and billing"))).toBe(true);
	});

	test("the child experiment is null when not requested and present when requested", () => {
		const report = { arms: { view: null, blind: null }, reason: "child arm refused" };
		expect(validateArtifact(artifact({ experiments: { child: report } })).length).toBeGreaterThan(0);
		expect(validateArtifact(artifact({ requestedExperiments: ["child"], experiments: { child: null } })).length).toBeGreaterThan(0);
		expect(validateArtifact(artifact({ requestedExperiments: ["child"], experiments: { child: report } }))).toEqual([]);
	});

	test("the view-bytes budget must be an integer within the host bounds", () => {
		expect(validateArtifact(artifact({ viewBytes: 4095 })).length).toBeGreaterThan(0);
		expect(validateArtifact(artifact({ viewBytes: 128_001 })).length).toBeGreaterThan(0);
		expect(validateArtifact(artifact({ viewBytes: 128_000 }))).toEqual([]);
	});
});
