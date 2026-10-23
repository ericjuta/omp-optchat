/** Pure, private-text-free scoring. The caller owns persistence and provenance attestation. */
export interface Hard {
	byte: boolean;
	refusal: boolean;
	head: boolean;
	falseSpeaker: boolean;
	marker: boolean;
}

export interface Result {
	task: string;
	repetition: number;
	arm: "baseline" | "candidate";
	attempts: unknown[];
	final?: string;
	/** True means a final violation, not that the guard passed. */
	hard: Hard;
	/** Total compressor cost, including ALL retries and fallbacks; excludes judge cost. */
	costUsd: number | null;
}

export interface Judgment {
	task: string;
	repetition: number;
	swap: number;
	baseline: number | null;
	candidate: number | null;
	valid: boolean;
}

export interface Input {
	tasks: string[];
	results: Result[];
	judgments: Judgment[];
	/** Opaque caller-owned billing evidence. Never copied into the public report. */
	accounting: unknown;
	/** Attests resolved billing/provenance and no source, manifest or code drift. */
	integrity: boolean;
	stopped: boolean;
}

export const SCORER = Object.freeze({
	version: "merge-cluster-percentile-v1",
	seed: 20261023,
	resamples: 10000,
	tasks: 12,
	repetitions: 2,
	swaps: 2,
	percentileMethod: "Hyndman-Fan type 7: sort ascending; h=(n-1)*p; linearly interpolate floor(h),ceil(h), p=0.025,0.975. Equal endpoints remain equal, including Infinity.",
	randomMethod: "Mulberry32, unsigned 32-bit seed; floor(U*12) selects each cluster. Consume 12 draws per resample, jointly for cost and quality; task order is frozen input.tasks order.",
	clusterMethod: "Average each task's two repetitions; quality also averages both swaps per repetition. Resample 12 tasks with replacement, preserving both arms and repetitions. Cost ratio is candidate resampled sum / baseline resampled sum; quality difference is candidate minus baseline resampled mean.",
	zeroBaselineMethod: "A zero resampled baseline cost gives an unbounded ratio (+Infinity), including 0/0. Nonfinite public CI endpoints are null, never a favorable substitute.",
	refusalMethod: "Validate every supplied judge score, then enforce score 0 for a refusing arm in both swaps. Non-refusal missing finals are incomplete. Final byte guard is supplied byte violation OR measured final UTF-8 bytes >512.",
	acceptance: "Adopt iff all 12 unique tasks, 24 pairs, 48 unique results and 48 valid judgments complete with repetitions 0/1, arms baseline/candidate and swaps 0/1; all scores are exactly 0, 0.5 or 1; integrity is true, stopped is false and every compressor cost is known, finite and nonnegative; candidate total compressor cost including every retry/fallback is strictly lower; upper 95% paired task-cluster percentile bootstrap cost-ratio bound <1; lower 95% quality-difference bound >=-0.05; candidate has no additional final byte, refusal, head, falseSpeaker or marker violations in any paired repetition or aggregate; swapped score-order disagreement <=10% of 24 sets. Failed adoption gates reject; invalid/missing/duplicate observations, unknown costs, stopped or failed integrity are incomplete, never adopted.",
	limitations: "No provider calls or I/O. Cost totals are caller-supplied configured-tariff costs, not invoices. Integrity is the caller's attestation including opaque accounting. Attempts have no schema, so only their counts (not first-attempt bytes) are reported. Final text is used only for UTF-8 length. Hard guards other than byte length are caller-computed with frozen production semantics. No task ids, raw outputs, attempt content or accounting are returned.",
});

const ARMS = ["baseline", "candidate"] as const;
const GUARDS = ["byte", "refusal", "head", "falseSpeaker", "marker"] as const;
type Arm = (typeof ARMS)[number];
type Guard = (typeof GUARDS)[number];
const zeroGuards = (): Record<Guard, number> => ({ byte: 0, refusal: 0, head: 0, falseSpeaker: 0, marker: 0 });
const isScore = (value: unknown): value is number => value === 0 || value === 0.5 || value === 1;
const isCost = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

function random(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Type-7 interpolation on a sorted, nonempty sample, including unbounded ratios. */
function percentile(sorted: number[], p: number): number {
	const h = (sorted.length - 1) * p;
	const lo = sorted[Math.floor(h)]!;
	const hi = sorted[Math.ceil(h)]!;
	return lo === hi || h === Math.floor(h) ? lo : lo + (hi - lo) * (h - Math.floor(h));
}

export interface ArmSummary {
	results: number;
	attempts: number;
	retries: number;
	knownCostUsd: number;
	unknownCosts: number;
	totalCostUsd: number | null;
	meanQuality: number | null;
	finalBytes: { observations: number; total: number; min: number | null; max: number | null; mean: number | null };
	hard: Record<Guard, number>;
}

function emptyArm(): ArmSummary {
	return {
		results: 0,
		attempts: 0,
		retries: 0,
		knownCostUsd: 0,
		unknownCosts: 0,
		totalCostUsd: null,
		meanQuality: null,
		finalBytes: { observations: 0, total: 0, min: null, max: null, mean: null },
		hard: zeroGuards(),
	};
}

export function scoreReport(input: Input) {
	const arms: Record<Arm, ArmSummary> = { baseline: emptyArm(), candidate: emptyArm() };
	const taskIndex = new Map<string, number>();
	let invalidTaskIds = 0;
	for (const task of input.tasks) {
		if (typeof task !== "string" || taskIndex.has(task)) invalidTaskIds++;
		else taskIndex.set(task, taskIndex.size);
	}
	const taskCountValid = input.tasks.length === 12 && taskIndex.size === 12 && invalidTaskIds === 0;
	const results: (Result | undefined)[] = new Array(48);
	const hard: (Hard | undefined)[] = new Array(48);
	const judgments: (Judgment | undefined)[] = new Array(48);
	let invalidResults = 0;
	let duplicateResults = 0;
	let invalidJudgments = 0;
	let duplicateJudgments = 0;
	const encoder = new TextEncoder();

	for (const row of input.results) {
		if (!row || (row.arm !== "baseline" && row.arm !== "candidate")) {
			invalidResults++;
			continue;
		}
		// Preserve every supplied cost, even for malformed/duplicate rows in an incomplete run.
		const arm = arms[row.arm];
		arm.results++;
		if (isCost(row.costUsd)) arm.knownCostUsd += row.costUsd;
		else arm.unknownCosts++;
		if (Array.isArray(row.attempts)) {
			arm.attempts += row.attempts.length;
			arm.retries += Math.max(0, row.attempts.length - 1);
		}
		const bytes = typeof row.final === "string" ? encoder.encode(row.final).byteLength : null;
		if (bytes !== null) {
			const lengths = arm.finalBytes;
			lengths.observations++;
			lengths.total += bytes;
			lengths.min = lengths.min === null ? bytes : Math.min(lengths.min, bytes);
			lengths.max = lengths.max === null ? bytes : Math.max(lengths.max, bytes);
		}
		const validHard = row.hard && GUARDS.every((guard) => typeof row.hard[guard] === "boolean");
		const task = taskIndex.get(row.task);
		if (!validHard || !Array.isArray(row.attempts) || task === undefined || task >= 12 ||
			(row.repetition !== 0 && row.repetition !== 1) ||
			(row.final !== undefined && typeof row.final !== "string") ||
			(row.final === undefined && !row.hard.refusal)) {
			invalidResults++;
			continue;
		}
		const violations: Hard = { ...row.hard, byte: row.hard.byte || (bytes !== null && bytes > 512) };
		for (const guard of GUARDS) if (violations[guard]) arm.hard[guard]++;
		const index = task * 4 + row.repetition * 2 + (row.arm === "candidate" ? 1 : 0);
		if (results[index] !== undefined) duplicateResults++;
		else {
			results[index] = row;
			hard[index] = violations;
		}
	}
	for (const row of input.judgments) {
		if (!row) {
			invalidJudgments++;
			continue;
		}
		const task = taskIndex.get(row.task);
		if (task === undefined || task >= 12 || (row.repetition !== 0 && row.repetition !== 1) ||
			(row.swap !== 0 && row.swap !== 1) || row.valid !== true ||
			!isScore(row.baseline) || !isScore(row.candidate)) {
			invalidJudgments++;
			continue;
		}
		const index = task * 4 + row.repetition * 2 + row.swap;
		if (judgments[index] !== undefined) duplicateJudgments++;
		else judgments[index] = row;
	}
	let missingResults = 0;
	let missingJudgments = 0;
	for (let i = 0; i < 48; i++) {
		if (results[i] === undefined) missingResults++;
		if (judgments[i] === undefined) missingJudgments++;
	}
	for (const arm of ARMS) {
		const summary = arms[arm];
		if (summary.results === 24 && summary.unknownCosts === 0 && Number.isFinite(summary.knownCostUsd)) summary.totalCostUsd = summary.knownCostUsd;
		if (summary.finalBytes.observations > 0) summary.finalBytes.mean = summary.finalBytes.total / summary.finalBytes.observations;
	}
	const resultsValid = input.results.length === 48 && invalidResults === 0 && duplicateResults === 0 && missingResults === 0;
	const judgmentsValid = input.judgments.length === 48 && invalidJudgments === 0 && duplicateJudgments === 0 && missingJudgments === 0;
	const observationsValid = taskCountValid && resultsValid && judgmentsValid;
	const costsKnown = resultsValid && arms.baseline.totalCostUsd !== null && arms.candidate.totalCostUsd !== null;
	const complete = observationsValid && costsKnown && input.integrity === true && input.stopped === false;
	const hardGuards = Object.fromEntries(GUARDS.map((guard) => [guard, {
		additionalPairs: 0,
		paired: false,
		aggregate: false,
		pass: false,
	}])) as Record<Guard, { additionalPairs: number; paired: boolean; aggregate: boolean; pass: boolean }>;
	if (taskCountValid && resultsValid) {
		for (const guard of GUARDS) {
			const check = hardGuards[guard];
			for (let pair = 0; pair < 24; pair++) {
				if (hard[pair * 2 + 1]![guard] && !hard[pair * 2]![guard]) check.additionalPairs++;
			}
			check.paired = check.additionalPairs === 0;
			check.aggregate = arms.candidate.hard[guard] <= arms.baseline.hard[guard];
			check.pass = check.paired && check.aggregate;
		}
	}
	let disagreements: number | null = null;
	let qualityDifference: number | null = null;
	let qualityLower: number | null = null;
	let qualityUpper: number | null = null;
	let ratioLower: number | null = null;
	let ratioUpper: number | null = null;
	let unboundedCostResamples = 0;
	let bootstrapComputed = false;
	if (observationsValid) {
		const quality = { baseline: new Array<number>(12).fill(0), candidate: new Array<number>(12).fill(0) };
		disagreements = 0;
		for (let task = 0; task < 12; task++) {
			for (let rep = 0; rep < 2; rep++) {
				const index = task * 4 + rep * 2;
				const signs: number[] = [];
				for (let swap = 0; swap < 2; swap++) {
					const judgment = judgments[index + swap]!;
					const baseline = hard[index]!.refusal ? 0 : judgment.baseline!;
					const candidate = hard[index + 1]!.refusal ? 0 : judgment.candidate!;
					quality.baseline[task]! += baseline / 4;
					quality.candidate[task]! += candidate / 4;
					signs.push(Math.sign(candidate - baseline));
				}
				if (signs[0] !== signs[1]) disagreements++;
			}
		}
		arms.baseline.meanQuality = quality.baseline.reduce((a, b) => a + b, 0) / 12;
		arms.candidate.meanQuality = quality.candidate.reduce((a, b) => a + b, 0) / 12;
		qualityDifference = arms.candidate.meanQuality - arms.baseline.meanQuality;
		if (costsKnown) {
			const cost = { baseline: new Array<number>(12), candidate: new Array<number>(12) };
			for (let task = 0; task < 12; task++) {
				for (let arm = 0; arm < 2; arm++) {
					cost[ARMS[arm]!][task] = results[task * 4 + arm]!.costUsd! / 2 + results[task * 4 + 2 + arm]!.costUsd! / 2;
				}
			}
			const rng = random(SCORER.seed);
			const ratios = new Array<number>(SCORER.resamples);
			const differences = new Array<number>(SCORER.resamples);
			for (let sample = 0; sample < SCORER.resamples; sample++) {
				let baseline = 0;
				let candidate = 0;
				let difference = 0;
				for (let draw = 0; draw < 12; draw++) {
					const task = Math.floor(rng() * 12);
					baseline += cost.baseline[task]!;
					candidate += cost.candidate[task]!;
					difference += quality.candidate[task]! - quality.baseline[task]!;
				}
				const ratio = baseline === 0 ? Infinity : candidate / baseline;
				ratios[sample] = ratio;
				if (!Number.isFinite(ratio)) unboundedCostResamples++;
				differences[sample] = difference / 12;
			}
			ratios.sort((a, b) => a - b);
			differences.sort((a, b) => a - b);
			const lower = percentile(ratios, 0.025);
			const upper = percentile(ratios, 0.975);
			ratioLower = Number.isFinite(lower) ? lower : null;
			ratioUpper = Number.isFinite(upper) ? upper : null;
			qualityLower = percentile(differences, 0.025);
			qualityUpper = percentile(differences, 0.975);
			bootstrapComputed = true;
		}
	}
	const conditions = {
		taskCountValid,
		resultsValid,
		judgmentsValid,
		costsKnown,
		integrity: input.integrity === true,
		notStopped: input.stopped === false,
		complete,
		candidateCostStrictlyLower: costsKnown && arms.candidate.totalCostUsd! < arms.baseline.totalCostUsd!,
		costRatioUpperBelowOne: ratioUpper !== null && ratioUpper < 1,
		qualityLowerAtLeastMinusPointZeroFive: qualityLower !== null && qualityLower >= -0.05,
		noAdditionalHardViolations: GUARDS.every((guard) => hardGuards[guard].pass),
		orderDisagreementAtMostTenPercent: disagreements !== null && disagreements / 24 <= 0.1,
	};
	const adopt = Object.values(conditions).every(Boolean);
	return {
		scorer: SCORER,
		complete,
		adopt,
		decision: !complete ? "incomplete" as const : adopt ? "adopt" as const : "reject" as const,
		conditions,
		failedConditions: Object.entries(conditions).filter(([, pass]) => !pass).map(([name]) => name),
		counts: { tasks: input.tasks.length, results: input.results.length, judgments: input.judgments.length, invalidTaskIds, invalidResults, duplicateResults, missingResults, invalidJudgments, duplicateJudgments, missingJudgments },
		arms,
		hardGuards,
		qualityDifference,
		bootstrap: { computed: bootstrapComputed, resamples: bootstrapComputed ? SCORER.resamples : 0, costRatio95: { lower: ratioLower, upper: ratioUpper }, qualityDifference95: { lower: qualityLower, upper: qualityUpper }, unboundedCostResamples },
		orderDisagreement: { sets: observationsValid ? 24 : 0, count: disagreements, rate: disagreements === null ? null : disagreements / 24 },
	};
}
