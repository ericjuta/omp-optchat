import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ARTIFACT_SCHEMA, estimateCostUsd, maintenanceSummary, summarizeUsage, validateArtifact, type UsageRecord } from "../scripts/evidence/artifact.ts";
import { offCompactionBoundUsd } from "../scripts/evidence/cost.ts";
import { buildCorpus, type Question } from "../scripts/evidence/corpus.ts";
import { hostStopReason, observeTurn, readMetricLines, readTreeStructure } from "../scripts/evidence/host.ts";
import { assertWorkspaceBoundary, createIsolatedDirs } from "../scripts/evidence/isolation.ts";
import { routingBlockers } from "../scripts/evidence/routing.ts";
import { compressorReasoning } from "../src/index.ts";
import {
	accountingViolations,
	admitPrompt,
	chargedAttempts,
	batchPrompt,
	checkLimits,
	initialAccounting,
	MAX_CALLS,
	parseAccountingState,
	recordCalls,
	seedBatches,
	selectQuestions,
	type Limits,
} from "../scripts/evidence/plan.ts";
import { answerInstruction, armTotals, assertedForbidden, parseAnswerSet, scoreAnswers, type RetrievedPage } from "../scripts/evidence/scoring.ts";
import { PHASE_COMPRESSOR_ALLOWANCE, phaseCompressorAllowance, RESTART_RESERVE_CALLS, SEED_COMPRESSOR_ALLOWANCE } from "../scripts/evidence/plan.ts";

const LIMITS: Limits = { maxCalls: 80, maxCompressorOutputTokens: 512, deadlineMs: 600_000, expiryWaitMs: null };
const SEED = 3;

/** Two projects, sixteen records: the second project carries a correction, so its owner question is a correction. */
const corpus = buildCorpus({ seed: SEED, projects: 2, sourceCount: 16, minSourceBytes: 1024 });

function questionOf(kind: Question["kind"]): Question {
	return corpus.questions.find((entry) => entry.kind === kind)!;
}

/** Exact original text of a record, retrieved as a page. */
function page(recordId: number): RetrievedPage {
	return { recordId, text: corpus.sources[recordId]!.text };
}

/** The fact sentence of a record: a substring of its original text, before the REF marker. */
function fact(recordId: number): string {
	return corpus.sources[recordId]!.text.split(" [")[0]!;
}

function answers(entries: readonly unknown[]): string {
	return "```json\n" + JSON.stringify({ answers: entries }) + "\n```";
}

describe("synthetic corpus", () => {
	test("same seed reproduces the corpus digest; a different seed changes it", () => {
		const again = buildCorpus({ seed: SEED, projects: 2, sourceCount: 16, minSourceBytes: 1024 });
		const other = buildCorpus({ seed: SEED + 1, projects: 2, sourceCount: 16, minSourceBytes: 1024 });
		expect(corpus.digest).toBe(again.digest);
		expect(corpus.digest).not.toBe(other.digest);
	});

	test("sixteen records (the two-project fact plan), each above the minimum size, numbered in order, each embedding its REF", () => {
		expect(corpus.sources.length).toBe(16);
		corpus.sources.forEach((source, index) => {
			expect(source.recordId).toBe(index);
			expect(source.text).toContain(`[${source.ref}]`);
			expect(new TextEncoder().encode(source.text).byteLength).toBeGreaterThanOrEqual(1024);
		});
	});

	test("every question cites records whose original text carries the value it asserts", () => {
		for (const entry of corpus.questions) {
			if (!entry.answerable) continue;
			expect(entry.sources.length).toBeGreaterThan(0);
			for (const source of entry.sources) {
				expect(corpus.sources[source.recordId]!.text).toContain(source.value);
			}
		}
	});

	test("the ambiguous question is grounded by both same-named records and expects no single answer", () => {
		const atlas = questionOf("ambiguity");
		expect(atlas.ambiguous).toBe(true);
		expect(atlas.expect).toEqual([]);
		expect(atlas.sources).toHaveLength(2);
		expect(atlas.sources.map((source) => source.value)).toEqual([...atlas.candidates]);
	});

	test("the work question is answered only by a host-work record; conversation records are memory-seeded", () => {
		const work = questionOf("work-reference");
		const record = corpus.sources[work.sources[0]!.recordId]!;
		expect(work.sourceKind).toBe("work");
		expect(record.kind).toBe("work");
		expect(record.provenance.channel).toBe("host-work");
		expect(record.provenance.work).toEqual({ source: "task", completeness: "full", id: record.ref, name: record.ref });
		for (const source of corpus.sources.filter((entry) => entry.kind === "conversation")) {
			expect(source.provenance.channel).toBe("memory-seed");
			expect(source.provenance.work).toBeNull();
		}
	});

	test("a correction cites the newer owner and forbids the superseded one", () => {
		const correction = questionOf("correction");
		expect(correction.expect).toHaveLength(1);
		expect(correction.forbid).toHaveLength(1);
		expect(corpus.sources[correction.sources[0]!.recordId]!.text).toContain(`owner is ${correction.expect[0]}, not ${correction.forbid[0]}`);
	});

	test("the negation record states both the true vendor and the rejected one", () => {
		const negation = questionOf("negation");
		const text = corpus.sources[negation.sources[0]!.recordId]!.text;
		expect(text).toContain(`uses vendor ${negation.expect[0]}`);
		expect(text).toContain(`not use vendor ${negation.forbid[0]}`);
	});

	test("attribution records name both the reporter and the report reference", () => {
		const attribution = questionOf("attribution");
		const record = corpus.sources[attribution.sources[0]!.recordId]!;
		expect(record.provenance.attribution).toBe(attribution.expect[0]);
		expect(record.provenance.reportId).toMatch(/^RPT-3-\d+$/);
	});

	test("known IDs are the sorted ticket IDs and every exact-ID answer is among them", () => {
		expect(corpus.knownIds).toEqual([...corpus.knownIds].sort());
		for (const entry of corpus.questions.filter((question) => question.kind === "exact-id")) {
			expect(corpus.knownIds).toContain(entry.expect[0]!);
		}
	});

	test("rejects counts, sizes, and seeds outside the bounds, and projects whose facts exceed sourceCount", () => {
		const base = { seed: SEED, projects: 2, sourceCount: 16, minSourceBytes: 1024 };
		expect(() => buildCorpus({ ...base, projects: 1 })).toThrow();
		expect(() => buildCorpus({ ...base, sourceCount: 15 })).toThrow();
		expect(() => buildCorpus({ ...base, sourceCount: 513 })).toThrow();
		expect(() => buildCorpus({ ...base, minSourceBytes: 511 })).toThrow();
		expect(() => buildCorpus({ ...base, seed: -1 })).toThrow();
		expect(() => buildCorpus({ ...base, projects: 3 })).toThrow();
	});
});

describe("strict answer parsing", () => {
	const ids = ["owner-Lumen", "ticket-Lumen"];
	const valid = answers([
		{ id: "owner-Lumen", value: "Ben", uncertain: false, citations: [{ recordId: 1, quote: "Ben" }] },
		{ id: "ticket-Lumen", value: null, uncertain: true, citations: [] },
	]);

	test("accepts exactly the schema, with null values and uncertainty kept distinct", () => {
		const parsed = parseAnswerSet(valid, ids);
		expect(parsed.ok).toBe(true);
		if (parsed.ok) {
			expect(parsed.answers.get("ticket-Lumen")?.value).toBeNull();
			expect(parsed.answers.get("ticket-Lumen")?.uncertain).toBe(true);
		}
	});

	test.each([
		["invalid JSON", "not json"],
		["extra top-level key", JSON.stringify({ answers: [], extra: 1 })],
		["unknown question id", answers([{ id: "other", value: "x", uncertain: false, citations: [] }])],
		[
			"duplicate id",
			answers([
				{ id: "owner-Lumen", value: "Ben", uncertain: false, citations: [] },
				{ id: "owner-Lumen", value: "Ben", uncertain: false, citations: [] },
			]),
		],
		["missing question", answers([{ id: "owner-Lumen", value: "Ben", uncertain: false, citations: [] }])],
		[
			"extra entry key",
			answers([
				{ id: "owner-Lumen", value: "Ben", uncertain: false, citations: [], note: "x" },
				{ id: "ticket-Lumen", value: null, uncertain: true, citations: [] },
			]),
		],
		[
			"non-boolean uncertainty",
			answers([
				{ id: "owner-Lumen", value: "Ben", uncertain: "no", citations: [] },
				{ id: "ticket-Lumen", value: null, uncertain: true, citations: [] },
			]),
		],
		[
			"numeric value",
			answers([
				{ id: "owner-Lumen", value: 4, uncertain: false, citations: [] },
				{ id: "ticket-Lumen", value: null, uncertain: true, citations: [] },
			]),
		],
				[
			"negative record id",
			answers([
				{ id: "owner-Lumen", value: "Ben", uncertain: false, citations: [{ recordId: -1, quote: "Ben" }] },
				{ id: "ticket-Lumen", value: null, uncertain: true, citations: [] },
			]),
		],
		[
			"empty quote",
			answers([
				{ id: "owner-Lumen", value: "Ben", uncertain: false, citations: [{ recordId: 1, quote: "" }] },
				{ id: "ticket-Lumen", value: null, uncertain: true, citations: [] },
			]),
		],
		[
			"citation with extra key",
			answers([
				{ id: "owner-Lumen", value: "Ben", uncertain: false, citations: [{ recordId: 1, quote: "Ben", source: "x" }] },
				{ id: "ticket-Lumen", value: null, uncertain: true, citations: [] },
			]),
		],
	])("rejects %s", (_label, raw) => {
		expect(parseAnswerSet(raw, ids).ok).toBe(false);
	});
});

describe("grounded scoring against original pages", () => {
	const ticket = questionOf("exact-id");
	const ticketRecord = ticket.sources[0]!.recordId;
	const ids = new Set(corpus.knownIds);
	const grade = (raw: string, pages: readonly RetrievedPage[] = [page(ticketRecord)], questions: readonly Question[] = [ticket]) =>
		scoreAnswers({ questions, raw, pages, knownIds: ids }).judgements[0]!;

	test("a correct answer citing the retrieved original sentence is correct and grounded", () => {
		const judgement = grade(answers([{ id: ticket.id, value: ticket.expect[0]!, uncertain: false, citations: [{ recordId: ticketRecord, quote: fact(ticketRecord) }] }]));
		expect(judgement.outcome).toBe("correct");
		expect(judgement.grounded).toBe(true);
		expect(judgement.failure).toBeNull();
	});

	test("a paraphrased citation is not in the original page, so it is fabricated", () => {
		const judgement = grade(answers([{ id: ticket.id, value: ticket.expect[0]!, uncertain: false, citations: [{ recordId: ticketRecord, quote: "the ticket is the correct one" }] }]));
		expect(judgement.outcome).toBe("hallucinated");
		expect(judgement.failure).toBe("fabricated-citation");
		expect(judgement.fabricatedCitations).toBe(1);
	});

	test("citing a record that was never retrieved is fabricated, even with the correct value", () => {
		const judgement = grade(answers([{ id: ticket.id, value: ticket.expect[0]!, uncertain: false, citations: [{ recordId: ticketRecord, quote: fact(ticketRecord) }] }]), []);
		expect(judgement.outcome).toBe("hallucinated");
		expect(judgement.failure).toBe("fabricated-citation");
	});

	test("the correct value without any citation is incorrect and ungrounded", () => {
		const judgement = grade(answers([{ id: ticket.id, value: ticket.expect[0]!, uncertain: false, citations: [] }]));
		expect(judgement.outcome).toBe("incorrect");
		expect(judgement.failure).toBe("ungrounded");
		expect(judgement.grounded).toBe(false);
	});

	test("a retrieved record that is not the source earns no grounding", () => {
		const other = corpus.sources.find((source) => source.recordId !== ticketRecord)!;
		const judgement = grade(
			answers([{ id: ticket.id, value: ticket.expect[0]!, uncertain: false, citations: [{ recordId: other.recordId, quote: other.text.split(" [")[0]! }] }]),
			[page(ticketRecord), page(other.recordId)],
		);
		expect(judgement.outcome).toBe("incorrect");
		expect(judgement.failure).toBe("ungrounded");
	});

	test("an invented ticket identifier is a hallucination", () => {
		const judgement = grade(answers([{ id: ticket.id, value: "ZX-1234-Z", uncertain: false, citations: [] }]));
		expect(judgement.outcome).toBe("hallucinated");
		expect(judgement.failure).toBe("fabricated-id");
	});

	test("a non-ID wrong value is a hallucination, distinct from an uncertain answer", () => {
		const reporter = questionOf("attribution");
		const wrong = scoreAnswers({
			questions: [reporter],
			raw: answers([{ id: reporter.id, value: "Nobody", uncertain: false, citations: [] }]),
			pages: [],
			knownIds: ids,
		}).judgements[0]!;
		expect(wrong.outcome).toBe("hallucinated");
		expect(wrong.failure).toBe("wrong-value");
		const hedged = scoreAnswers({
			questions: [reporter],
			raw: answers([{ id: reporter.id, value: "Nobody", uncertain: true, citations: [] }]),
			pages: [],
			knownIds: ids,
		}).judgements[0]!;
		expect(hedged.outcome).toBe("abstained");
		expect(hedged.uncertain).toBe(true);
	});

	test("a null answer with no uncertainty is incorrect, not hallucinated", () => {
		const judgement = grade(answers([{ id: ticket.id, value: null, uncertain: false, citations: [] }]));
		expect(judgement.outcome).toBe("incorrect");
		expect(judgement.failure).toBe("no-answer");
	});

	test("a correction answer that rejects the superseded owner is correct; asserting it is a hallucination", () => {
		const correction = questionOf("correction");
		const record = correction.sources[0]!.recordId;
		const rejecting = scoreAnswers({
			questions: [correction],
			raw: answers([
				{
					id: correction.id,
					value: `${correction.expect[0]} owns the project now, not ${correction.forbid[0]}.`,
					uncertain: false,
					citations: [{ recordId: record, quote: fact(record) }],
				},
			]),
			pages: [page(record)],
			knownIds: ids,
		}).judgements[0]!;
		expect(rejecting.outcome).toBe("correct");
		const asserting = scoreAnswers({
			questions: [correction],
			raw: answers([
				{
					id: correction.id,
					value: `${correction.forbid[0]} owns the project.`,
					uncertain: false,
					citations: [{ recordId: record, quote: fact(record) }],
				},
			]),
			pages: [page(record)],
			knownIds: ids,
		}).judgements[0]!;
		expect(asserting.outcome).toBe("hallucinated");
		expect(asserting.failure).toBe("forbidden-value");
	});

	test("an ambiguous question answered confidently with one candidate is a hallucination", () => {
		const atlas = questionOf("ambiguity");
		const judgement = scoreAnswers({
			questions: [atlas],
			raw: answers([{ id: atlas.id, value: `${atlas.candidates[0]} owns Atlas.`, uncertain: false, citations: [] }]),
			pages: [],
			knownIds: ids,
		}).judgements[0]!;
		expect(judgement.outcome).toBe("hallucinated");
		expect(judgement.failure).toBe("ambiguous-confident");
	});

	test("an ambiguous question is correct only when uncertain, naming both candidates, and citing both sources", () => {
		const atlas = questionOf("ambiguity");
		const [north, south] = atlas.sources.map((source) => source.recordId);
		const value = `Atlas north is ${atlas.candidates[0]} and Atlas south is ${atlas.candidates[1]}.`;
		const both = scoreAnswers({
			questions: [atlas],
			raw: answers([
				{
					id: atlas.id,
					value,
					uncertain: true,
					citations: [
						{ recordId: north!, quote: fact(north!) },
						{ recordId: south!, quote: fact(south!) },
					],
				},
			]),
			pages: [page(north!), page(south!)],
			knownIds: ids,
		}).judgements[0]!;
		expect(both.outcome).toBe("correct");
		expect(both.grounded).toBe(true);

		const oneSource = scoreAnswers({
			questions: [atlas],
			raw: answers([{ id: atlas.id, value, uncertain: true, citations: [{ recordId: north!, quote: fact(north!) }] }]),
			pages: [page(north!), page(south!)],
			knownIds: ids,
		}).judgements[0]!;
		expect(oneSource.outcome).toBe("incorrect");
		expect(oneSource.failure).toBe("ungrounded");

		const oneName = scoreAnswers({
			questions: [atlas],
			raw: answers([
				{
					id: atlas.id,
					value: `Atlas north is ${atlas.candidates[0]}.`,
					uncertain: true,
					citations: [
						{ recordId: north!, quote: fact(north!) },
						{ recordId: south!, quote: fact(south!) },
					],
				},
			]),
			pages: [page(north!), page(south!)],
			knownIds: ids,
		}).judgements[0]!;
		expect(oneName.outcome).toBe("incorrect");
		expect(oneName.failure).toBe("ambiguous-incomplete");
	});

	test("an invalid answer set fails every question with the schema failure and credits nothing", () => {
		const score = scoreAnswers({ questions: corpus.questions, raw: "not json", pages: [], knownIds: ids });
		expect(score.schemaValid).toBe(false);
		expect(score.judgements.every((judgement) => judgement.failure === "schema")).toBe(true);
		expect(score.totals.correct).toBe(0);
		expect(score.totals.hallucinated).toBe(0);
	});

	test("totals partition every judged question into exactly one outcome", () => {
		const score = scoreAnswers({
			questions: [ticket],
			raw: answers([{ id: ticket.id, value: null, uncertain: true, citations: [] }]),
			pages: [],
			knownIds: ids,
		});
		const { totals } = score;
		expect(totals.correct + totals.abstained + totals.incorrect + totals.hallucinated).toBe(totals.questions);
		expect(totals.abstained).toBe(1);
	});
});

describe("forbidden-value assertions", () => {
	test("explicit rejections are not assertions", () => {
		expect(assertedForbidden("the owner is not Ada", ["Ada"])).toEqual([]);
		expect(assertedForbidden("Ben owns Lumen, not Ada.", ["Ada"])).toEqual([]);
		expect(assertedForbidden("Ada is no longer the owner.", ["Ada"])).toEqual([]);
		expect(assertedForbidden("the owner changed from Ada to Ben", ["Ada"])).toEqual([]);
	});

	test("affirmative mentions are assertions, and a longer name does not match a shorter one", () => {
		expect(assertedForbidden("the owner is Ada", ["Ada"])).toEqual(["Ada"]);
		expect(assertedForbidden("Ada owns Lumen, not Ben.", ["Ada"])).toEqual(["Ada"]);
		expect(assertedForbidden("Benjamin owns Lumen.", ["Ben"])).toEqual([]);
	});
});

describe("question selection and prompts", () => {
	test("stratified selection covers every kind before repeating one", () => {
		const picked = selectQuestions(corpus.questions, 8);
		expect(picked).toHaveLength(8);
		expect(new Set(picked.map((entry) => entry.kind)).size).toBe(8);
	});

	test("batches place each record exactly once, in order, within the batch size", () => {
		const batches = seedBatches(corpus.sources, 5);
		expect(batches.flat().map((source) => source.recordId)).toEqual(corpus.sources.map((source) => source.recordId));
		for (const batch of batches) expect(batch.length).toBeLessThanOrEqual(5);
	});

	test("the batch prompt names every question id and requests the strict answer schema", () => {
		const picked = selectQuestions(corpus.questions, 3);
		const prompt = batchPrompt(picked);
		for (const entry of picked) expect(prompt).toContain(`[${entry.id}]`);
		expect(prompt).toContain('{"answers":[');
	});
});

describe("prompt-level budget accounting", () => {
	test("limits above the parent ceilings are rejected", () => {
		expect(checkLimits(LIMITS)).toEqual([]);
		expect(checkLimits({ ...LIMITS, maxCalls: MAX_CALLS + 1 }).length).toBeGreaterThan(0);
		expect(checkLimits({ ...LIMITS, maxCompressorOutputTokens: 513 }).length).toBeGreaterThan(0);
		expect(checkLimits({ ...LIMITS, deadlineMs: 600_001 }).length).toBeGreaterThan(0);
		expect(checkLimits({ ...LIMITS, expiryWaitMs: 310_001 }).length).toBeGreaterThan(0);
	});

	test("admission refuses a prompt whose worst case would exceed maxCalls, using observed calls", () => {
		const limits = { ...LIMITS, maxCalls: 8 };
		let state = initialAccounting(0);
		const first = admitPrompt(state, limits, 0, 4);
		expect(first.admitted).toBe(true);
		state = recordCalls(first.state, "main", 4);
		const second = admitPrompt(state, limits, 0, 4);
		expect(second.admitted).toBe(true);
		state = recordCalls(second.state, "main", 4);
		const third = admitPrompt(state, limits, 0, 4);
		expect(third.admitted).toBe(false);
		if (!third.admitted) {
			expect(third.reason).toBe("maxCalls");
			expect(third.state.refusedPrompts).toBe(1);
		}
	});

	test("admission refuses once the deadline has elapsed and admits just before it", () => {
		const limits = { ...LIMITS, deadlineMs: 1000 };
		const start = initialAccounting(0);
		expect(admitPrompt(start, limits, 999, 4).admitted).toBe(true);
		const late = admitPrompt(start, limits, 1000, 4);
		expect(late.admitted).toBe(false);
		if (!late.admitted) expect(late.reason).toBe("deadline");
	});

	test("admission is pure: the input state is not changed", () => {
		const state = initialAccounting(0);
		admitPrompt(state, LIMITS, 0, 4);
		expect(state.admittedPrompts).toBe(0);
	});

	test("observed calls above maxCalls are reported as violations, not silently capped", () => {
		const limits = { ...LIMITS, maxCalls: 8 };
		const state = recordCalls(recordCalls(initialAccounting(0), "main", 6), "compressor", 4);
		expect(accountingViolations(state, limits)).toHaveLength(1);
		expect(accountingViolations(initialAccounting(0), limits)).toEqual([]);
	});

	test("recorded counts must be non-negative integers", () => {
		expect(() => recordCalls(initialAccounting(0), "main", -1)).toThrow();
		expect(() => recordCalls(initialAccounting(0), "compressor", 1.5)).toThrow();
	});

	test("persisted accounting parses strictly: round trips, and rejects extra, missing, or negative fields", () => {
		const state = recordCalls(initialAccounting(42), "main", 3);
		expect(parseAccountingState(JSON.parse(JSON.stringify(state)))).toEqual(state);
		expect(() => parseAccountingState({ ...state, extra: 1 })).toThrow();
		expect(() => parseAccountingState({ ...state, mainCalls: -1 })).toThrow();
		const missing: Record<string, unknown> = { ...state };
		delete missing.startedAt;
		expect(() => parseAccountingState(missing)).toThrow();
	});
});

describe("usage accounting", () => {
	const complete: UsageRecord = { role: "main", purpose: "turn", input: 100, output: 20, cacheRead: 30, cacheWrite: 5, costUsd: 0.01, costSource: "sdk-reported", latencyMs: 250 };

	test("prompt tokens add non-cached input to cache reads and writes", () => {
		const summary = summarizeUsage([complete, complete]);
		expect(summary.calls).toBe(2);
		expect(summary.promptTokens).toBe(270);
		expect(summary.complete).toBe(true);
	});

	test("an unobserved counter stays null instead of becoming zero", () => {
		const partial: UsageRecord = { ...complete, cacheRead: null };
		const summary = summarizeUsage([complete, partial]);
		expect(summary.cacheRead).toBeNull();
		expect(summary.promptTokens).toBeNull();
		expect(summary.complete).toBe(false);
	});

	test("no calls is distinct from zero cost: cost is null and its source is none", () => {
		const empty = summarizeUsage([]);
		expect(empty.calls).toBe(0);
		expect(empty.costSource).toBe("none");
		expect(empty.costUsd).toBeNull();
	});

	test("an unobserved cost is unavailable, not zero, and a catalog estimate is labelled as one", () => {
		const unavailable = summarizeUsage([{ ...complete, costUsd: null, costSource: "unavailable" }]);
		expect(unavailable.costSource).toBe("unavailable");
		expect(unavailable.costUsd).toBeNull();
		const estimate = summarizeUsage([{ ...complete, costSource: "catalog-estimate" }]);
		expect(estimate.costSource).toBe("catalog-estimate");
		expect(estimate.costUsd).toBe(0.01);
	});

	test("catalog estimates use list prices per million and remain null without counters", () => {
		const price = { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 };
		expect(estimateCostUsd({ input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }, price)).toBe(1);
		expect(estimateCostUsd({ input: null, output: 0, cacheRead: 0, cacheWrite: 0 }, price)).toBeNull();
	});
});

describe("artifact validation", () => {
	const main = summarizeUsage([{ role: "main", purpose: "turn", input: 10, output: 2, cacheRead: 0, cacheWrite: 0, costUsd: 0.001, costSource: "sdk-reported", latencyMs: 100 }]);
	const unavailableCompressor = { status: "unavailable", reason: "no metrics sink" };
	const corpusBlock = { version: corpus.version, seed: SEED, digest: corpus.digest, sources: corpus.sources.length, minSourceBytes: 1024, questionsTotal: corpus.questions.length, questionsSelected: 8 };
	const limitsBlock = { ...LIMITS, enforcement: "prompt-admission", callsUsed: 1, violations: [], maxCostUsd: null, spentUsd: null, costEnforcement: "none" };
	const zeroMaintenance = maintenanceSummary({ compactions: 0, interval: null });

	/** A well-formed phase; overrides replace fields wholesale. */
	function phase(overrides: Record<string, unknown> = {}): Record<string, unknown> {
		return {
			name: "main",
			model: "synthetic/model",
			arm: "on",
			compressor: null,
			latencyMs: 120,
			usage: { main, compressor: unavailableCompressor, auxiliary: summarizeUsage([]) },
			maintenance: zeroMaintenance,
			turns: [],
			questions: [],
			tree: null,
			error: null,
			refusal: null,
			timestamps: null,
			...overrides,
		};
	}

	/** A well-formed artifact; top-level and phase overrides replace fields wholesale. */
	function artifact(overrides: Record<string, unknown> = {}, phaseOverrides: Record<string, unknown> = {}): Record<string, unknown> {
		return {
			schema: ARTIFACT_SCHEMA,
			generatedAt: "2026-10-11T00:00:00.000Z",
			status: "completed",
			error: null,
			synthetic: true,
			arms: ["on"],
			turnMode: "batch",
			requestedExperiments: [],
			experiments: { child: null },
			questionEmphasis: "balanced",
			viewBytes: 4096,
			models: { mainContextWindow: null },
			paired: [],
			corpus: corpusBlock,
			limits: limitsBlock,
			scenarios: [{ name: "cold", status: "completed", reason: null, phases: [phase(phaseOverrides)] }],
			accuracy: {},
			limitations: ["synthetic provider only"],
			...overrides,
		};
	}

	test("a well-formed artifact with an explicitly unavailable compressor is valid", () => {
		expect(validateArtifact(artifact())).toEqual([]);
	});

	test("savings, billing, and credential-shaped fields are rejected anywhere in the artifact", () => {
		expect(validateArtifact(artifact({ cacheSavingsUsd: 1 })).length).toBeGreaterThan(0);
		expect(validateArtifact(artifact({ apiKey: "x" })).length).toBeGreaterThan(0);
		expect(validateArtifact(artifact({}, { usage: { main: { ...main, billedUsd: 1 }, compressor: unavailableCompressor } })).length).toBeGreaterThan(0);
	});

	test("negative metrics are rejected, while null and zero latency are distinct and both valid", () => {
		expect(validateArtifact(artifact({}, { latencyMs: -1 })).length).toBeGreaterThan(0);
		expect(validateArtifact(artifact({}, { latencyMs: null }))).toEqual([]);
		expect(validateArtifact(artifact({}, { latencyMs: 0 }))).toEqual([]);
	});

	test("a cost reported with an unavailable source is an inconsistent cost provenance", () => {
		expect(validateArtifact(artifact({}, { usage: { main: { ...main, costSource: "unavailable" }, compressor: unavailableCompressor } })).length).toBeGreaterThan(0);
	});

	test("an unavailable compressor must state its reason and must not report calls", () => {
		expect(validateArtifact(artifact({}, { usage: { main, compressor: { status: "unavailable" } } })).length).toBeGreaterThan(0);
		expect(validateArtifact(artifact({}, { usage: { main, compressor: { status: "unavailable", reason: "r", calls: 0 } } })).length).toBeGreaterThan(0);
	});

	test("depthRequirementMet must agree with at least two distinct saved tree-node levels", () => {
		expect(validateArtifact(artifact({}, { tree: { levels: [3, 4], mainParts: 2, compactorParts: 2, depthRequirementMet: true } }))).toEqual([]);
		expect(validateArtifact(artifact({}, { tree: { levels: [4], mainParts: 1, compactorParts: 1, depthRequirementMet: true } })).length).toBeGreaterThan(0);
		expect(validateArtifact(artifact({}, { tree: { levels: [3, 4], mainParts: 2, compactorParts: 2, depthRequirementMet: false } })).length).toBeGreaterThan(0);
	});

	test("a judged question must carry boolean verdicts and an outcome; an unavailable one must carry neither", () => {
		const judged = {
			id: "owner-Lumen",
			kind: "merge-depth",
			status: "judged",
			reason: null,
			correct: true,
			valueCorrect: true,
			grounded: true,
			hallucinated: false,
			abstained: false,
			outcome: "correct",
			failure: null,
			zoomCalls: 1,
			maxZoomN: 2,
			zoomDepth: 1,
			zoomedSourceRecord: true,
			latencyMs: 9,
			answerPreview: "Ben",
		};
		expect(validateArtifact(artifact({}, { questions: [judged] }))).toEqual([]);
		expect(validateArtifact(artifact({}, { questions: [{ ...judged, outcome: null }] })).length).toBeGreaterThan(0);
		const unavailable = {
			...judged,
			status: "unavailable",
			reason: "no sink",
			correct: null,
			valueCorrect: null,
			grounded: null,
			hallucinated: null,
			abstained: null,
			outcome: null,
			failure: null,
			zoomCalls: null,
			maxZoomN: null,
			zoomDepth: null,
			zoomedSourceRecord: null,
			latencyMs: null,
			answerPreview: null,
		};
		expect(validateArtifact(artifact({}, { questions: [unavailable] }))).toEqual([]);
		expect(validateArtifact(artifact({}, { questions: [{ ...unavailable, correct: true }] })).length).toBeGreaterThan(0);
	});

	test("the corpus must have sixteen to five hundred twelve sources and an enforcement mode is required", () => {
		expect(validateArtifact(artifact({ corpus: { ...corpusBlock, sources: 15 } })).length).toBeGreaterThan(0);
		expect(validateArtifact(artifact({ corpus: { ...corpusBlock, sources: 513 } })).length).toBeGreaterThan(0);
		expect(validateArtifact(artifact({ corpus: { ...corpusBlock, sources: 512 } }))).toEqual([]);
		const { enforcement: _omitted, ...unmarked } = limitsBlock;
		expect(validateArtifact(artifact({ limits: unmarked })).length).toBeGreaterThan(0);
	});
});

describe("off-arm compaction admission bound", () => {
	const model = { inputRate: 1, outputRate: 2, cacheReadRate: 0.1, cacheWriteRate: 1.25, contextWindow: 100_000, maxOutput: 1000 };

	test("prices the whole history and prompt bytes as tokens at the dearest input rate, plus overhead and the catalog output ceiling", () => {
		// Tokens are bounded by UTF-8 bytes: 400 and 40 bytes bound 440 tokens, plus 4096 of overhead; the cache-write rate is the dearest input rate.
		expect(offCompactionBoundUsd(model, 400, 40)).toBeCloseTo(((400 + 40 + 4096) * 1.25 + 1000 * 2) / 1e6, 12);
	});

	test("an unknown or invalid catalog output ceiling fails closed", () => {
		expect(offCompactionBoundUsd({ ...model, maxOutput: null }, 400, 40)).toBeNull();
		expect(offCompactionBoundUsd({ ...model, maxOutput: 0 }, 400, 40)).toBeNull();
	});

	test("a history larger than the context window is priced in full, not clamped", () => {
		expect(offCompactionBoundUsd({ ...model, contextWindow: 10 }, 40_000, 0)).toBeCloseTo(((40_000 + 4096) * 1.25 + 1000 * 2) / 1e6, 12);
	});
});

describe("durable metric sink", () => {
	test("a missing compressor sink is distinct from an empty one", async () => {
		const directory = await mkdtemp(join(tmpdir(), "evidence-sink-"));
		try {
			expect(await readMetricLines(join(directory, "absent.jsonl"))).toBeNull();
			await writeFile(join(directory, "present.jsonl"), "");
			expect(await readMetricLines(join(directory, "present.jsonl"))).toEqual([]);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});

describe("value before citations, saved-view grounding, and per-phase budget", () => {
	const ticket = questionOf("exact-id");
	const rec = ticket.sources[0]!.recordId;
	const ids = new Set(corpus.knownIds);
	const grade = (raw: string, viewText?: string) => scoreAnswers({ questions: [ticket], raw, pages: [page(rec)], knownIds: ids, viewText }).judgements[0]!;
	const right = (citations: unknown[]) => answers([{ id: ticket.id, value: ticket.expect[0]!, uncertain: false, citations }]);
	const wrong = (citations: unknown[]) => answers([{ id: ticket.id, value: "NOPE", uncertain: false, citations }]);

	test("a wrong value with a fabricated citation is wrong-value, and its value is not correct", () => {
		const judgement = grade(wrong([{ recordId: rec, quote: "invented words" }]));
		expect(judgement.failure).toBe("wrong-value");
		expect(judgement.outcome).toBe("hallucinated");
		expect(judgement.valueCorrect).toBe(false);
	});

	test("a correct value whose quote is only in the saved view is ungrounded, not fabricated", () => {
		const quote = "a sentence present only in the saved view";
		const judgement = grade(right([{ recordId: rec, quote }]), `{"summary":"${quote}"}`);
		expect(judgement.failure).toBe("ungrounded");
		expect(judgement.outcome).toBe("incorrect");
		expect(judgement.valueCorrect).toBe(true);
		expect(judgement.fabricatedCitations).toBe(0);
	});

	test("a correct value whose quote is in neither a retrieved page nor the view is fabricated-citation; valueCorrect stays true", () => {
		const judgement = grade(right([{ recordId: rec, quote: "not anywhere in memory" }]), "unrelated view text");
		expect(judgement.failure).toBe("fabricated-citation");
		expect(judgement.outcome).toBe("hallucinated");
		expect(judgement.valueCorrect).toBe(true);
		expect(judgement.fabricatedCitations).toBe(1);
	});

	test("the seed is bounded so restart keeps its reserve; cold leaves the reserve; restart takes what remains", () => {
		const spare = 200 - 8;
		const seed = phaseCompressorAllowance("seed", spare, 1);
		expect(seed).toBe(SEED_COMPRESSOR_ALLOWANCE);
		expect(phaseCompressorAllowance("cold", spare, 1)).toBe(PHASE_COMPRESSOR_ALLOWANCE);
		expect(phaseCompressorAllowance("cold", 70, 1)).toBe(10);
		expect(phaseCompressorAllowance("cold", 40, 1)).toBe(0);
		expect(phaseCompressorAllowance("restart", spare - seed, 1)).toBeGreaterThanOrEqual(RESTART_RESERVE_CALLS);
		expect(phaseCompressorAllowance("restart", 70, 1)).toBe(70);
		expect(phaseCompressorAllowance("concurrent-0", 100, 2)).toBe(20);
	});
});

describe("arm-aware scoring, unanswerable questions, and totals", () => {
	const ticket = questionOf("exact-id");
	const rec = ticket.sources[0]!.recordId;
	const ids = new Set(corpus.knownIds);
	const seeded = new Map([[String(rec), corpus.sources[rec]!.text]]);
	const right = answers([{ id: ticket.id, value: ticket.expect[0]!, uncertain: false, citations: [{ recordId: rec, quote: fact(rec) }] }]);
	const unknown: Question = { ...ticket, id: "unanswerable-probe", answerable: false, ambiguous: false, expect: [], forbid: [], candidates: [], sources: [] };
	const probe = (entry: Record<string, unknown>) => scoreAnswers({ questions: [unknown], raw: answers([entry]), pages: [], knownIds: ids }).judgements[0]!;

	test("off arm: a quote that is an exact substring of the seeded record grounds the value without retrieved pages", () => {
		const judgement = scoreAnswers({ arm: "off", seededRecords: seeded, questions: [ticket], raw: right, pages: [], knownIds: ids }).judgements[0]!;
		expect(judgement.outcome).toBe("correct");
		expect(judgement.grounded).toBe(true);
		expect(judgement.fabricatedCitations).toBe(0);
	});

	test("off arm: a paraphrased quote is fabricated-citation, and the value is still counted right", () => {
		const raw = answers([{ id: ticket.id, value: ticket.expect[0]!, uncertain: false, citations: [{ recordId: rec, quote: "the ticket is the correct one" }] }]);
		const judgement = scoreAnswers({ arm: "off", seededRecords: seeded, questions: [ticket], raw, pages: [], knownIds: ids }).judgements[0]!;
		expect(judgement.outcome).toBe("hallucinated");
		expect(judgement.failure).toBe("fabricated-citation");
		expect(judgement.valueCorrect).toBe(true);
		expect(judgement.fabricatedCitations).toBe(1);
	});

	test("off arm refuses to score without the seeded history", () => {
		expect(() => scoreAnswers({ arm: "off", questions: [ticket], raw: right, pages: [], knownIds: ids })).toThrow("seededRecords");
	});

	test("a citation to any one of several non-ambiguous sources grounds the value", () => {
		const value = ticket.expect[0]!;
		const other = 99;
		const multi: Question = { ...ticket, sources: [...ticket.sources, { recordId: other, value }] };
		const text = `Staff note: the verified owner is ${value}.`;
		const raw = answers([{ id: ticket.id, value, uncertain: false, citations: [{ recordId: other, quote: text }] }]);
		const judgement = scoreAnswers({ questions: [multi], raw, pages: [{ recordId: other, text }], knownIds: ids }).judgements[0]!;
		expect(judgement.outcome).toBe("correct");
		expect(judgement.grounded).toBe(true);
	});

	test("an uncertain reply stating an explicit abstention on an unanswerable question is correct and abstained", () => {
		const judgement = probe({ id: unknown.id, value: "not stated", uncertain: true, citations: [] });
		expect(judgement.outcome).toBe("correct");
		expect(judgement.abstained).toBe(true);
		expect(judgement.failure).toBeNull();
	});

	test("an explicit abstention is matched after normalization: case, spacing, and a trailing period", () => {
		const judgement = probe({ id: unknown.id, value: "  Not   Stated. ", uncertain: true, citations: [] });
		expect(judgement.outcome).toBe("correct");
		expect(judgement.abstained).toBe(true);
	});

	test("an uncertain unanswerable reply with a definite value that is not an abstention is hallucinated unanswerable-asserted", () => {
		const judgement = probe({ id: unknown.id, value: "Ada", uncertain: true, citations: [] });
		expect(judgement.outcome).toBe("hallucinated");
		expect(judgement.failure).toBe("unanswerable-asserted");
		expect(judgement.abstained).toBe(false);
	});

	test("an uncertain unanswerable reply with no value abstains without credit", () => {
		const judgement = probe({ id: unknown.id, value: null, uncertain: true, citations: [] });
		expect(judgement.outcome).toBe("abstained");
		expect(judgement.abstained).toBe(true);
	});

	test("a definite value on an unanswerable question is hallucinated unanswerable-asserted", () => {
		const judgement = probe({ id: unknown.id, value: "Ada", uncertain: false, citations: [] });
		expect(judgement.outcome).toBe("hallucinated");
		expect(judgement.failure).toBe("unanswerable-asserted");
		expect(judgement.abstained).toBe(false);
	});

	test("any citation on an unanswerable question is hallucinated unanswerable-asserted, even while uncertain", () => {
		const judgement = probe({ id: unknown.id, value: "not stated", uncertain: true, citations: [{ recordId: rec, quote: fact(rec) }] });
		expect(judgement.outcome).toBe("hallucinated");
		expect(judgement.failure).toBe("unanswerable-asserted");
	});

	test("armTotals counts a correct abstention as correct and abstained, and separates schema failures", () => {
		const score = scoreAnswers({
			questions: [ticket, unknown],
			raw: answers([
				{ id: ticket.id, value: ticket.expect[0]!, uncertain: false, citations: [{ recordId: rec, quote: fact(rec) }] },
				{ id: unknown.id, value: "not stated", uncertain: true, citations: [] },
			]),
			pages: [page(rec)],
			knownIds: ids,
		});
		expect(armTotals(score.judgements)).toEqual({ judged: 2, correct: 2, valueCorrect: 2, grounded: 2, abstained: 1, hallucinated: 0, incorrectSchema: 0 });
		const invalid = scoreAnswers({ questions: [ticket, unknown], raw: "not json", pages: [], knownIds: ids });
		expect(armTotals(invalid.judgements)).toEqual({ judged: 2, correct: 0, valueCorrect: 0, grounded: 0, abstained: 0, hallucinated: 0, incorrectSchema: 2 });
	});

	test("the answer instruction asks for exactly one fenced json block, not a bare JSON object", () => {
		const instruction = answerInstruction([ticket.id]);
		expect(instruction).toContain("```json");
		expect(instruction).not.toContain("bare JSON");
		expect(instruction).toContain('value to "not stated"');
	});
});

describe("live instrument regressions", () => {
	const ANSWER = '{"answers":[{"id":"q1","value":"Ada","uncertain":false,"citations":[]}]}';

	test("defect 1: exactly one fenced block is accepted anywhere in the reply; zero, two, or bare JSON stay schema failures", () => {
		expect(parseAnswerSet("```json\n" + ANSWER + "\n```", ["q1"]).ok).toBe(true);
		expect(parseAnswerSet("```\n" + ANSWER + "\n```", ["q1"]).ok).toBe(true);
		expect(parseAnswerSet("Here it is:\n```json\n" + ANSWER + "\n```\nDone.", ["q1"]).ok).toBe(true);
		expect(parseAnswerSet("```json\n" + ANSWER + "\n```\n```json\n" + ANSWER + "\n```", ["q1"]).ok).toBe(false);
		expect(parseAnswerSet(ANSWER, ["q1"]).ok).toBe(false);
		expect(parseAnswerSet("Now I have the records. " + ANSWER + " trailing", ["q1"]).ok).toBe(false);
	});

	test("defect 2: a host abort or a missing assistant message is a stop, and a finished answer is not", () => {
		const aborted = observeTurn([{ type: "message_end", message: { role: "assistant", stopReason: "aborted", content: [] } }], null);
		expect(hostStopReason(aborted)).toBe("host stopped the turn (stopReason aborted)");
		expect(hostStopReason(observeTurn([], null))).toBe("host produced no assistant message");
		const done = observeTurn([{ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: ANSWER }] } }], null);
		expect(hostStopReason(done)).toBeNull();
		expect(done.answer).toBe(ANSWER);
	});

	test("defect 3: saved v2 parts read their first coordinate as the level; leaves alone have no levels", async () => {
		const directory = await mkdtemp(join(tmpdir(), "optchat-tree-"));
		try {
			await writeFile(join(directory, "view.json"), JSON.stringify({
				version: 2,
				length: 6,
				parts: [[2, 0], [1, 2], [0, 6]],
				compactor: { length: 6, parts: [[2, 0], [1, 2]], compacting: false },
			}));
			const tree = await readTreeStructure(directory);
			expect(tree?.levels).toEqual([1, 2]);
			expect(tree?.mainParts).toBe(3);
			expect(tree?.compactorParts).toBe(2);
			await writeFile(join(directory, "view.json"), JSON.stringify({ version: 2, length: 2, parts: [[0, 0], [0, 1]], compactor: { length: 2, parts: [[0, 0], [0, 1]], compacting: false } }));
			expect((await readTreeStructure(directory))?.levels).toEqual([]);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("defect 4: every completed call is charged once, and a completion without an admission is a violation", () => {
		expect(chargedAttempts(4, 4, 0)).toEqual({ charged: 4, total: 4, violation: null });
		expect(chargedAttempts(3, 5, 0)).toEqual({ charged: 5, total: 5, violation: "compressor metric lines 5 exceed admissions 3" });
		// Admitted in one window, completed in the next: charged once, and never a violation.
		const first = chargedAttempts(4, 0, 0);
		expect(first).toEqual({ charged: 4, total: 4, violation: null });
		expect(chargedAttempts(4, 4, first.total)).toEqual({ charged: 0, total: 4, violation: null });
	});

	test("defect 5: an output cap turns reasoning off, so the SDK cannot raise max_tokens above the cap", () => {
		expect(compressorReasoning({} as Parameters<typeof compressorReasoning>[0], 512)).toBeUndefined();
	});

	describe("F: routingBlockers fails closed on selected providers and uncertainty", () => {
		const sourceCanary = "optchat-routing-source-canary";
		const valueCanary = "optchat-routing-value-canary";
		const pathCanary = "optchat-routing-path-canary";
		type Fixture = readonly [filename: string, contents: string | null];
		type Blocker = readonly [filename: string, provider?: string];
		const yaml = (body: string) => `source: "${sourceCanary}"\nvalue: "${valueCanary}"\n${body}\n`;
		const json = (body: string) => `{"source":"${sourceCanary}","value":"${valueCanary}",${body}}`;

		/**
		 * Writes fixtures (null = a directory at the filename), requires the directory to be byte-for-byte
		 * unchanged after the check, and requires each expected blocker to name its file (and provider) without
		 * leaking the source, value, or path canaries.
		 */
		async function checkRouting(fixtures: readonly Fixture[], expected: readonly Blocker[] = []): Promise<void> {
			const directory = await mkdtemp(join(tmpdir(), `${pathCanary}-`));
			try {
				for (const [filename, contents] of fixtures) {
					if (contents === null) await mkdir(join(directory, filename));
					else await writeFile(join(directory, filename), contents);
				}
				const snapshot = async () => {
					const entries: [string, string][] = [];
					const visit = async (relative: string): Promise<void> => {
						for (const entry of await readdir(join(directory, relative), { withFileTypes: true })) {
							const name = join(relative, entry.name);
							entries.push([name, entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other"]);
							if (entry.isFile()) entries.push([name, (await readFile(join(directory, name))).toString("base64")]);
							if (entry.isDirectory()) await visit(name);
						}
					};
					await visit("");
					return entries.sort(([a], [b]) => a.localeCompare(b));
				};
				const before = await snapshot();
				let blockers: string[];
				try {
					blockers = await routingBlockers(directory, ["anthropic", "openai"]);
				} finally {
					expect(await snapshot()).toEqual(before);
				}
				for (const blocker of blockers) {
					for (const secret of [sourceCanary, valueCanary, pathCanary, directory]) expect(blocker).not.toContain(secret);
				}
				if (expected.length === 0) expect(blockers).toEqual([]);
				else {
					expect(blockers.length).toBeGreaterThanOrEqual(expected.length);
					for (const [filename, provider] of expected) {
						const named = new RegExp(`(^|[^\\w.])${filename.replace(/\./g, "\\.")}(?!\\w)`);
						expect(blockers.some((blocker) => named.test(blocker) && (provider === undefined || blocker.includes(provider)))).toBe(true);
					}
				}
			} finally {
				await rm(directory, { recursive: true, force: true });
			}
		}

		const cases: [name: string, fixtures: Fixture[], expected: Blocker[]][] = [
			// Selected provider mappings, one per supported format.
			["YAML models.yml names a selected provider", [["models.yml", yaml(`providers:\n  anthropic:\n    baseUrl: "${valueCanary}"`)]], [["models.yml", "anthropic"]]],
			["YAML models.yaml names a selected provider", [["models.yaml", yaml(`providers:\n  openai:\n    apiKey: "${valueCanary}"`)]], [["models.yaml", "openai"]]],
			["JSON models.json with comments and trailing commas", [["models.json", json(`/* gateway */ "providers": {"anthropic": {"apiKey": "${valueCanary}",},}`)]], [["models.json", "anthropic"]]],
			// A selected key blocks regardless of its value.
			["selected false value still blocks", [["models.yml", yaml(`providers:\n  anthropic: false`)]], [["models.yml", "anthropic"]]],
			["selected null value still blocks", [["models.json", json(`"providers": {"openai": null}`)]], [["models.json", "openai"]]],
			// Escaped keys decode to the selected provider name.
			["YAML escaped selected key", [["models.yml", yaml(`providers:\n  "anthro\\u0070ic":\n    apiKey: "${valueCanary}"`)]], [["models.yml", "anthropic"]]],
			["JSON escaped selected key", [["models.json", json(`"providers": {"opena\\u0069": {"apiKey": "${valueCanary}"}}`)]], [["models.json", "openai"]]],
			// YAML aliases and merges: the selected provider may arrive through resolution.
			["providers aliased to a mapping naming a selected provider", [["models.yml", yaml(`routing: &routing\n  anthropic:\n    apiKey: "${valueCanary}"\nproviders: *routing`)]], [["models.yml", "anthropic"]]],
			["root merge supplying providers", [["models.yaml", yaml(`base: &base\n  providers:\n    openai:\n      apiKey: "${valueCanary}"\n<<: *base`)]], [["models.yaml"]]],
			["providers merge supplying a selected provider", [["models.yml", yaml(`base: &base\n  anthropic:\n    apiKey: "${valueCanary}"\nproviders:\n  <<: *base`)]], [["models.yml"]]],
			// Invalid root and providers shapes, including an empty file.
			["empty models.yml has a null root", [["models.yml", ""]], [["models.yml"]]],
			["models.json with an array root", [["models.json", `["${sourceCanary}","${valueCanary}"]`]], [["models.json"]]],
			["YAML providers null", [["models.yml", yaml("providers: null")]], [["models.yml"]]],
			["JSON providers array", [["models.json", json(`"providers": []`)]], [["models.json"]]],
			// Parse failures, reported by filename without the parser excerpt.
			["malformed YAML", [["models.yaml", yaml(`providers:\n  openai: ["${valueCanary}"`)]], [["models.yaml"]]],
			["JSON with a missing comma", [["models.json", json(`"providers": {"anthropic": {"apiKey": "${valueCanary}" "x": true}}`)]], [["models.json"]]],
			// Multiple YAML documents must not be treated as a clean first document.
			["multi-document YAML with a clean first document", [["models.yml", `${yaml("providers: {}")}---\n${yaml(`providers:\n  openai:\n    apiKey: "${valueCanary}"`)}`]], [["models.yml"]]],
			// Non-ENOENT read failures block; absence does not.
			["models.json as a directory is a read failure", [["models.json", null]], [["models.json"]]],
			["no routing files at all is accepted without creating any", [], []],
			// Unrelated names, comments, values, and nested keys are accepted.
			["YAML comments, substrings, and nested keys are not provider keys", [["models.yml", yaml(`# anthropic: openai:\nproviders:\n  anthropic-shadow: false\n  unrelated:\n    note: "providers: openai"\n    nested: {openai: null}\n    apiKey: "${valueCanary}"`)]], []],
			["JSONC comments and unrelated provider content are accepted", [["models.json", json(`// anthropic:\n"note": "openai", "providers": {/* openai: */"unrelated": {"model": "anthropic",},},`)]], []],
			["missing or empty providers are accepted", [["models.yml", yaml(`note: "anthropic openai"`)], ["models.json", json(`"providers": {}`)]], []],
			// models.jsonc is not a default-discovered file and is not inspected.
			["models.jsonc is not inspected", [["models.jsonc", json(`"providers": {"anthropic": {"apiKey": "${valueCanary}"}}`)]], []],
			// A clean higher-precedence file does not hide a selected lower-precedence sibling.
			["clean models.yml does not hide a selected models.json", [["models.yml", yaml("providers: {}")], ["models.json", json(`"providers": {"openai": {"apiKey": "${valueCanary}"}}`)]], [["models.json", "openai"]]],
		];
		test.each(cases)("%s", async (_name, fixtures, expected) => {
			await checkRouting(fixtures, expected);
		});
	});

	test("D: the isolated workspace is its own discovery boundary; a project SYSTEM.md inside it fails the preflight", async () => {
		const directory = await mkdtemp(join(tmpdir(), "optchat-boundary-"));
		try {
			const dirs = await createIsolatedDirs(join(directory, "run"));
			expect(() => assertWorkspaceBoundary(dirs)).not.toThrow();
			await mkdir(join(dirs.workspace, ".omp"), { recursive: true });
			await writeFile(join(dirs.workspace, ".omp", "SYSTEM.md"), "ambient");
			expect(() => assertWorkspaceBoundary(dirs)).toThrow();
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
