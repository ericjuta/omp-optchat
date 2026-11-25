import { type CostInterval, validateArtifact } from "./artifact.ts";
import { buildCorpus } from "./corpus.ts";

export const RETENTION_SCHEMA = "optchat-evidence-retention/1";

/** One question's grade in one arm, as the runner judged it. */
export interface Grade {
	readonly correct: boolean;
	readonly valueCorrect: boolean;
	readonly grounded: boolean;
	readonly hallucinated: boolean;
}

/**
 * One arm of one `evidence:recall` artifact: its cold-scenario grades, and usage over its build and cold scenario.
 * The `off` arm is plain OMP over the whole seeded history; an `on` arm is OptChat with one compressor and view budget.
 */
export interface Side {
	readonly file: string;
	readonly arm: "on" | "off";
	/** Null on the off arm, which runs no compressor. */
	readonly compressor: string | null;
	/** Null on the off arm, which has no view. */
	readonly viewBytes: number | null;
	readonly providerMode: string;
	readonly host: string;
	/** The plugin commit the run used: `unknown` without a revision, and suffixed `+dirty` when the tree had uncommitted changes. */
	readonly pluginCommit: string;
	readonly main: string;
	readonly turnMode: string;
	readonly seed: number;
	readonly digest: string;
	readonly sources: number;
	readonly minSourceBytes: number;
	/** UTF-8 bytes of every seeded record, from the corpus rebuilt and checked against the artifact digest. */
	readonly historyBytes: number;
	readonly grades: ReadonlyMap<string, Grade>;
	/** Null when any part of the cost is unobserved: unknown, never zero. */
	readonly costUsd: CostInterval | null;
	/** Main-model prompt tokens; null when any call's counters are unobserved. */
	readonly mainPromptTokens: number | null;
	/** Native compactions of the main session. An off arm that compacted did not read the whole history. */
	readonly compactions: number;
	/** View lines after the cold scenario; null on the off arm. */
	readonly viewLines: number | null;
}

export interface Tally {
	readonly judged: number;
	readonly correct: number;
	readonly valueCorrect: number;
	readonly grounded: number;
	readonly hallucinated: number;
}

/** Per-question pairing of two arms on strict correctness. `unpaired` counts questions judged in only one arm. */
export interface PairedCounts {
	readonly both: number;
	readonly firstOnly: number;
	readonly secondOnly: number;
	readonly neither: number;
	readonly unpaired: number;
	/** Exact two-sided sign test over the discordant pairs; null when there are none. */
	readonly signP: number | null;
}

interface Cohort {
	readonly providerMode: string;
	readonly main: string;
	readonly compressor: string;
	readonly turnMode: string;
	readonly sources: number;
	readonly minSourceBytes: number;
	readonly seeds: readonly number[];
	readonly historyBytes: { readonly min: number; readonly max: number };
	readonly hosts: readonly string[];
	readonly pluginCommits: readonly string[];
}

/** View against whole history at one chat length and one view budget, pooled over seeds. */
export interface RetentionRow extends Cohort {
	readonly viewBytes: number;
	/** Corpora with a whole-history baseline: an off arm on the same corpus that never compacted. */
	readonly baselineRuns: number;
	/** On-arm runs left out of the tallies, with the reason. */
	readonly excluded: readonly { readonly file: string; readonly reason: string }[];
	/** Tallies over questions judged in both arms of the baseline runs. */
	readonly on: Tally;
	readonly off: Tally;
	/** On-arm correct answers as a share of the off arm's; null when the off arm has none. */
	readonly retention: number | null;
	/** The same ratio over correct values, whatever their citations. */
	readonly valueRetention: number | null;
	/** First is the on arm, second the off arm. */
	readonly paired: PairedCounts;
	readonly onCostUsd: CostInterval | null;
	readonly offCostUsd: CostInterval | null;
}

export interface ViewSide extends Tally {
	readonly viewBytes: number;
	readonly costUsd: CostInterval | null;
	readonly mainPromptTokens: number | null;
	readonly viewLines: readonly (number | null)[];
}

/** Two view budgets over the same corpora, on arm against on arm, pooled over seeds. */
export interface ViewSizeRow extends Cohort {
	readonly larger: ViewSide;
	readonly smaller: ViewSide;
	/** First is the larger view, second the smaller. */
	readonly paired: PairedCounts;
}

export interface RetentionReport {
	readonly schema: typeof RETENTION_SCHEMA;
	readonly sides: number;
	readonly retention: readonly RetentionRow[];
	readonly viewSize: readonly ViewSizeRow[];
}

interface UsagePart {
	readonly calls: number;
	readonly promptTokens: number | null;
	readonly costUsd: number | null;
}

interface PhaseShape {
	readonly arm: string;
	readonly compressor: string | null;
	readonly usage: { readonly main: UsagePart; readonly compressor: UsagePart | { readonly status: "unavailable" }; readonly auxiliary: UsagePart };
	readonly maintenance: { readonly compactions: number; readonly costUsdLow: number | null; readonly costUsdHigh: number | null };
	readonly questions: readonly {
		readonly id: string;
		readonly status: string;
		readonly correct: boolean | null;
		readonly valueCorrect: boolean | null;
		readonly grounded: boolean | null;
		readonly hallucinated: boolean | null;
	}[];
	readonly tree: { readonly mainParts: number } | null;
}

/** The fields of a validated `optchat-evidence-recall/3` artifact this report reads. */
interface ArtifactShape {
	readonly synthetic: boolean;
	readonly providerMode: string;
	readonly host: { readonly version: string };
	readonly plugin: { readonly revision: { readonly commit: string; readonly dirtyFiles: number } | null };
	readonly corpus: { readonly seed: number; readonly digest: string; readonly sources: number; readonly minSourceBytes: number; readonly questionsTotal: number };
	readonly arms: readonly ("on" | "off")[];
	readonly compressors: readonly string[];
	readonly turnMode: string;
	readonly viewBytes: number;
	readonly models: { readonly main: string };
	readonly builds: readonly PhaseShape[];
	readonly scenarios: readonly { readonly name: string; readonly arm: string; readonly compressor: string | null; readonly status: string; readonly phases: readonly PhaseShape[] }[];
}

/** Questions per project and global questions, as `questionCount` in corpus.ts defines them. */
const QUESTIONS_PER_PROJECT = 6;
const GLOBAL_QUESTIONS = 4;

function addCost(sum: CostInterval | null, lowUsd: number | null, highUsd: number | null): CostInterval | null {
	return sum === null || lowUsd === null || highUsd === null ? null : { lowUsd: sum.lowUsd + lowUsd, highUsd: sum.highUsd + highUsd };
}

function sumCosts(sides: readonly Side[]): CostInterval | null {
	return sides.reduce<CostInterval | null>((sum, side) => addCost(sum, side.costUsd?.lowUsd ?? null, side.costUsd?.highUsd ?? null), { lowUsd: 0, highUsd: 0 });
}

/** A role that made no call cost nothing; a role that called without a reported cost is unknown. */
function roleCost(part: UsagePart): number | null {
	return part.calls === 0 ? 0 : part.costUsd;
}

/** Usage over `phases` (build plus cold scenario) and grades from `answers` (the cold scenario). */
function measure(arm: "on" | "off", phases: readonly PhaseShape[], answers: readonly PhaseShape[]): Pick<Side, "grades" | "costUsd" | "mainPromptTokens" | "compactions" | "viewLines"> {
	let costUsd: CostInterval | null = { lowUsd: 0, highUsd: 0 };
	let mainPromptTokens: number | null = 0;
	let compactions = 0;
	for (const phase of phases) {
		const { main, compressor, auxiliary } = phase.usage;
		// The off arm runs no compressor, so its report is unavailable by design; on the on arm that means unobserved.
		const compressorCost = "status" in compressor ? (arm === "off" ? 0 : null) : roleCost(compressor);
		for (const cost of [roleCost(main), compressorCost, roleCost(auxiliary)]) costUsd = addCost(costUsd, cost, cost);
		if (phase.maintenance.compactions > 0) costUsd = addCost(costUsd, phase.maintenance.costUsdLow, phase.maintenance.costUsdHigh);
		compactions += phase.maintenance.compactions;
		if (main.calls > 0) mainPromptTokens = mainPromptTokens === null || main.promptTokens === null ? null : mainPromptTokens + main.promptTokens;
	}
	const grades = new Map<string, Grade>();
	for (const question of answers.flatMap((phase) => phase.questions)) {
		const { correct, valueCorrect, grounded, hallucinated } = question;
		if (question.status !== "judged" || correct === null || valueCorrect === null || grounded === null || hallucinated === null) continue;
		if (grades.has(question.id)) throw new Error(`question ${question.id} is judged twice in the ${arm} arm`);
		grades.set(question.id, { correct, valueCorrect, grounded, hallucinated });
	}
	return { grades, costUsd, mainPromptTokens, compactions, viewLines: arm === "on" ? (answers.at(-1)?.tree?.mainParts ?? null) : null };
}

/**
 * Reads one validated runner artifact into one side per arm (and per compressor on the on arm). Only the cold scenario
 * is graded, because it is the one scenario both arms run. An arm whose cold scenario did not complete is named in
 * `incomplete` and yields no side. Throws on an invalid artifact and when the corpus cannot be rebuilt to its digest.
 */
export function readArtifact(value: unknown, file: string): { sides: Side[]; incomplete: string[] } {
	const errors = validateArtifact(value);
	if (errors.length > 0) throw new Error(`${file}: not a valid evidence artifact: ${errors.slice(0, 3).join("; ")}`);
	const artifact = value as ArtifactShape;
	if (!artifact.synthetic) throw new Error(`${file}: not a synthetic-corpus artifact`);
	const revision = artifact.plugin.revision;
	const { seed, digest, sources, minSourceBytes, questionsTotal } = artifact.corpus;
	const corpus = buildCorpus({ seed, projects: (questionsTotal - GLOBAL_QUESTIONS) / QUESTIONS_PER_PROJECT, sourceCount: sources, minSourceBytes });
	if (corpus.digest !== digest) throw new Error(`${file}: the corpus rebuilt from its options has a different digest`);
	const shared = {
		file,
		providerMode: artifact.providerMode,
		host: artifact.host.version,
		pluginCommit: revision === null ? "unknown" : revision.dirtyFiles === 0 ? revision.commit : `${revision.commit}+dirty`,
		main: artifact.models.main,
		turnMode: artifact.turnMode,
		seed,
		digest,
		sources,
		minSourceBytes,
		historyBytes: corpus.sources.reduce((sum, record) => sum + Buffer.byteLength(record.text), 0),
	};

	const sides: Side[] = [];
	const incomplete: string[] = [];
	const units = artifact.arms.flatMap((arm): { arm: "on" | "off"; compressor: string | null }[] => (arm === "off" ? [{ arm, compressor: null }] : artifact.compressors.map((compressor) => ({ arm, compressor }))));
	for (const { arm, compressor } of units) {
		const cold = artifact.scenarios.find((scenario) => scenario.name === "cold" && scenario.arm === arm && scenario.compressor === compressor);
		if (cold === undefined || cold.status !== "completed") {
			incomplete.push(`${file}: the ${arm} arm${compressor === null ? "" : ` (${compressor})`} did not complete its cold scenario (${cold?.status ?? "absent"})`);
			continue;
		}
		const build = artifact.builds.filter((phase) => phase.arm === arm && phase.compressor === compressor);
		sides.push({ ...shared, arm, compressor, viewBytes: arm === "on" ? artifact.viewBytes : null, ...measure(arm, [...build, ...cold.phases], cold.phases) });
	}
	return { sides, incomplete };
}

/** Exact two-sided sign test: the chance of a split at least this uneven among `a + b` fair coin flips. */
export function signTestP(a: number, b: number): number | null {
	const n = a + b;
	if (n === 0) return null;
	const k = Math.min(a, b);
	let logTerm = -n * Math.LN2;
	let tail = Math.exp(logTerm);
	for (let i = 1; i <= k; i++) {
		logTerm += Math.log((n - i + 1) / i);
		tail += Math.exp(logTerm);
	}
	return Math.min(1, 2 * tail);
}

const EMPTY_TALLY: Tally = { judged: 0, correct: 0, valueCorrect: 0, grounded: 0, hallucinated: 0 };

function addGrade(tally: Tally, grade: Grade): Tally {
	return {
		judged: tally.judged + 1,
		correct: tally.correct + Number(grade.correct),
		valueCorrect: tally.valueCorrect + Number(grade.valueCorrect),
		grounded: tally.grounded + Number(grade.grounded),
		hallucinated: tally.hallucinated + Number(grade.hallucinated),
	};
}

/** Two arms pooled over runs. Only questions judged in both arms are tallied, so both sides answer the same questions. */
class Pool {
	first = EMPTY_TALLY;
	second = EMPTY_TALLY;
	#both = 0;
	#firstOnly = 0;
	#secondOnly = 0;
	#neither = 0;
	#unpaired = 0;

	add(first: Side, second: Side): void {
		for (const [id, a] of first.grades) {
			const b = second.grades.get(id);
			if (b === undefined) {
				this.#unpaired += 1;
				continue;
			}
			this.first = addGrade(this.first, a);
			this.second = addGrade(this.second, b);
			if (a.correct && b.correct) this.#both += 1;
			else if (a.correct) this.#firstOnly += 1;
			else if (b.correct) this.#secondOnly += 1;
			else this.#neither += 1;
		}
		for (const id of second.grades.keys()) if (!first.grades.has(id)) this.#unpaired += 1;
	}

	counts(): PairedCounts {
		return { both: this.#both, firstOnly: this.#firstOnly, secondOnly: this.#secondOnly, neither: this.#neither, unpaired: this.#unpaired, signP: signTestP(this.#firstOnly, this.#secondOnly) };
	}
}

function cohort(compressor: string, sides: readonly Side[]): Cohort {
	const [first] = sides;
	if (first === undefined) throw new Error("a cohort needs at least one run");
	const bytes = sides.map((side) => side.historyBytes);
	return {
		providerMode: first.providerMode,
		main: first.main,
		compressor,
		turnMode: first.turnMode,
		sources: first.sources,
		minSourceBytes: first.minSourceBytes,
		seeds: [...new Set(sides.map((side) => side.seed))].sort((a, b) => a - b),
		historyBytes: { min: Math.min(...bytes), max: Math.max(...bytes) },
		hosts: [...new Set(sides.map((side) => side.host))].sort(),
		pluginCommits: [...new Set(sides.map((side) => side.pluginCommit))].sort(),
	};
}

function group<T>(items: readonly T[], key: (item: T) => string): T[][] {
	const groups = new Map<string, T[]>();
	for (const item of items) {
		const id = key(item);
		const list = groups.get(id);
		if (list) list.push(item);
		else groups.set(id, [item]);
	}
	return [...groups.values()];
}

/** What two arms must share to be compared question by question: the same corpus, asked the same way of the same main model. */
function corpusKey(side: Side): string {
	return JSON.stringify([side.providerMode, side.main, side.turnMode, side.digest]);
}

/** What on-arm runs must share to pool: everything but the seed and the view budget. */
function shapeKey(side: Side): string {
	return JSON.stringify([side.providerMode, side.main, side.compressor, side.turnMode, side.sources, side.minSourceBytes]);
}

type OnSide = Side & { readonly compressor: string; readonly viewBytes: number };

function retentionRow(ons: readonly OnSide[], offs: ReadonlyMap<string, Side>): RetentionRow | null {
	const pool = new Pool();
	const excluded: { file: string; reason: string }[] = [];
	const paired: { on: OnSide; off: Side }[] = [];
	for (const on of ons) {
		const off = offs.get(corpusKey(on));
		if (off === undefined) excluded.push({ file: on.file, reason: "no whole-history run on the same corpus was given" });
		else if (off.compactions > 0) excluded.push({ file: on.file, reason: `the off arm (${off.file}) compacted ${off.compactions} time(s), so it did not read the whole history` });
		else {
			pool.add(on, off);
			paired.push({ on, off });
		}
	}
	// A cohort that was never run against whole history (view-size runs, say) has no retention to report.
	if (ons.every((on) => !offs.has(corpusKey(on)))) return null;
	const [first] = ons;
	return {
		...cohort(first!.compressor, [...ons, ...paired.map((pair) => pair.off)]),
		viewBytes: first!.viewBytes,
		baselineRuns: paired.length,
		excluded,
		on: pool.first,
		off: pool.second,
		retention: pool.second.correct === 0 ? null : pool.first.correct / pool.second.correct,
		valueRetention: pool.second.valueCorrect === 0 ? null : pool.first.valueCorrect / pool.second.valueCorrect,
		paired: pool.counts(),
		onCostUsd: paired.length === 0 ? null : sumCosts(paired.map((pair) => pair.on)),
		offCostUsd: paired.length === 0 ? null : sumCosts(paired.map((pair) => pair.off)),
	};
}

function viewSide(viewBytes: number, tally: Tally, sides: readonly Side[]): ViewSide {
	return {
		...tally,
		viewBytes,
		costUsd: sumCosts(sides),
		mainPromptTokens: sides.reduce<number | null>((sum, side) => (sum === null || side.mainPromptTokens === null ? null : sum + side.mainPromptTokens), 0),
		viewLines: sides.map((side) => side.viewLines),
	};
}

/** Every pair of view budgets that some corpus was run at, pooled over the corpora that have both. */
function viewSizeRows(ons: readonly OnSide[]): ViewSizeRow[] {
	const rows: ViewSizeRow[] = [];
	const budgets = [...new Set(ons.map((side) => side.viewBytes))].sort((a, b) => b - a);
	for (const [index, largerBytes] of budgets.entries()) {
		for (const smallerBytes of budgets.slice(index + 1)) {
			const pool = new Pool();
			const larger: OnSide[] = [];
			const smaller: OnSide[] = [];
			for (const side of ons.filter((candidate) => candidate.viewBytes === largerBytes)) {
				const other = ons.find((candidate) => candidate.viewBytes === smallerBytes && candidate.digest === side.digest);
				if (other === undefined) continue;
				pool.add(side, other);
				larger.push(side);
				smaller.push(other);
			}
			const [first] = larger;
			if (first === undefined) continue;
			rows.push({
				...cohort(first.compressor, [...larger, ...smaller]),
				larger: viewSide(largerBytes, pool.first, larger),
				smaller: viewSide(smallerBytes, pool.second, smaller),
				paired: pool.counts(),
			});
		}
	}
	return rows;
}

/**
 * Pools sides into retention rows (view against whole history, by chat length) and view-size rows (two view budgets
 * over the same corpora). Arms pair only on the same corpus, main model, turn mode and provider mode, across files too.
 */
export function retentionReport(sides: readonly Side[]): RetentionReport {
	const seen = new Set<string>();
	for (const side of sides) {
		const id = JSON.stringify([corpusKey(side), side.arm, side.compressor, side.viewBytes]);
		if (seen.has(id)) throw new Error(`${side.file}: a second run of the same arm on the same corpus, models and view budget; pass one`);
		seen.add(id);
	}
	const ons = sides.filter((side): side is OnSide => side.arm === "on" && side.compressor !== null && side.viewBytes !== null);
	const offs = new Map(sides.filter((side) => side.arm === "off").map((side) => [corpusKey(side), side]));
	const byLength = (a: Cohort, b: Cohort): number => a.historyBytes.min - b.historyBytes.min;
	return {
		schema: RETENTION_SCHEMA,
		sides: sides.length,
		retention: group(ons, (side) => JSON.stringify([shapeKey(side), side.viewBytes]))
			.map((cohortSides) => retentionRow(cohortSides, offs))
			.filter((row) => row !== null)
			.sort((a, b) => byLength(a, b) || b.viewBytes - a.viewBytes),
		viewSize: group(ons, shapeKey).flatMap(viewSizeRows).sort(byLength),
	};
}

function usd(cost: CostInterval | null): string {
	if (cost === null) return "unknown";
	return cost.lowUsd === cost.highUsd ? `$${cost.lowUsd.toFixed(2)}` : `$${cost.lowUsd.toFixed(2)}–${cost.highUsd.toFixed(2)}`;
}

function percent(share: number | null): string {
	return share === null ? "n/a" : `${(share * 100).toFixed(1)}%`;
}

function sign(paired: PairedCounts): string {
	return paired.signP === null ? "no discordant pairs" : `p=${paired.signP.toFixed(3)}`;
}

function kilobytes(range: { readonly min: number; readonly max: number }): string {
	const kb = (bytes: number): string => `${Math.round(bytes / 1000)} KB`;
	return range.min === range.max ? kb(range.min) : `${kb(range.min)}–${kb(range.max)}`;
}

/** The report as Markdown tables. Costs that were not observed print as `unknown`. */
export function renderReport(report: RetentionReport): string {
	const lines: string[] = [];
	lines.push("## Retention: view against whole history", "");
	if (report.retention.length === 0) lines.push("No on arm had a whole-history run on the same corpus.", "");
	else {
		lines.push("| History | Records | View | Corpora | View correct | Whole-history correct | Retention | Value retention | View only / whole only | Sign test | View cost | Whole-history cost |", "|---|---|---|---|---|---|---|---|---|---|---|---|");
		for (const row of report.retention) {
			lines.push(`| ${kilobytes(row.historyBytes)} | ${row.sources} | ${row.viewBytes} B | ${row.baselineRuns} | ${row.on.correct}/${row.on.judged} | ${row.off.correct}/${row.off.judged} | ${percent(row.retention)} | ${percent(row.valueRetention)} | ${row.paired.firstOnly} / ${row.paired.secondOnly} | ${sign(row.paired)} | ${usd(row.onCostUsd)} | ${usd(row.offCostUsd)} |`);
		}
		lines.push("");
		for (const row of report.retention) for (const { file, reason } of row.excluded) lines.push(`- Left out: ${file}: ${reason}.`);
	}
	lines.push("", "## View size: larger against smaller view", "");
	if (report.viewSize.length === 0) lines.push("No corpus was run at two view budgets.");
	else {
		lines.push("| History | Records | Views | Corpora | Larger correct | Smaller correct | Larger only / smaller only | Sign test | Larger cost | Smaller cost | Main prompt tokens | View lines |", "|---|---|---|---|---|---|---|---|---|---|---|---|");
		for (const row of report.viewSize) {
			const { larger, smaller } = row;
			lines.push(`| ${kilobytes(row.historyBytes)} | ${row.sources} | ${larger.viewBytes} B vs ${smaller.viewBytes} B | ${row.seeds.length} | ${larger.correct}/${larger.judged} | ${smaller.correct}/${smaller.judged} | ${row.paired.firstOnly} / ${row.paired.secondOnly} | ${sign(row.paired)} | ${usd(larger.costUsd)} | ${usd(smaller.costUsd)} | ${larger.mainPromptTokens ?? "unknown"} vs ${smaller.mainPromptTokens ?? "unknown"} | ${larger.viewLines.join(",")} vs ${smaller.viewLines.join(",")} |`);
		}
	}
	const rows = [...report.retention, ...report.viewSize];
	const mixed = rows.filter((row) => row.hosts.length > 1 || row.pluginCommits.length > 1);
	if (mixed.length > 0) lines.push("", `Warning: ${mixed.length} row(s) pool runs from different host versions or plugin commits.`);
	const unpinned = rows.filter((row) => row.pluginCommits.some((commit) => commit === "unknown" || commit.endsWith("+dirty")));
	if (unpinned.length > 0) lines.push("", `Warning: ${unpinned.length} row(s) include a run from an unknown or uncommitted plugin tree.`);
	return `${lines.join("\n")}\n`;
}
