#!/usr/bin/env bun
/**
 * Opt-in, authenticated, synthetic-only long-history recall and cache evidence.
 *
 * Makes real provider calls through an isolated OMP host: a temporary HOME, agent directory,
 * workspace, and XDG tree, with only the selected provider credentials copied in and only the
 * explicitly allowed environment variables passed through. Nothing is called unless
 * --confirm-live-provider-calls is passed.
 *
 *   bun run scripts/evidence-recall.ts --confirm-live-provider-calls \
 *     --main <provider/model> --compressor <provider/model> --out evidence.json
 *
 * Limits: main calls are admitted per prompt (the host has no per-provider-call gate, so calls
 * inside a prompt are not capped and overruns are reported as violations). Compressor calls are
 * admitted inside the host through the evidence extension's per-host allowance and output cap.
 */
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
	ARTIFACT_SCHEMA,
	estimateCostUsd,
	MIN_TREE_LEVELS,
	summarizeUsage,
	validateArtifact,
	type Price,
	type UsageRecord,
	type UsageSummary,
} from "./evidence/artifact.ts";
import { buildCorpus, type Corpus, type Question, type QuestionKind } from "./evidence/corpus.ts";
import { hostVersion, isAvailable, pluginRevision, providerOf, readCatalogEntry, type CatalogEntry } from "./evidence/discovery.ts";
import {
	hostStopReason,
	initMetricsFile,
	observeTurn,
	readEffectivePrompt,
	queryAvailableModels,
	readAdmissionDispatched,
	readDurableRecords,
	readMetricLines,
	readTreeStructure,
	RpcHost,
	type MetricLine,
	type TurnObservation,
} from "./evidence/host.ts";
import { assertWorkspaceBoundary, childEnvironment, copySelectedAuth, createIsolatedDirs, type CopiedAuth, type IsolatedDirs } from "./evidence/isolation.ts";
import {
	accountingViolations,
	admitPrompt,
	batchPrompt,
	chargedAttempts,
	DEFAULT_PROMPT_CALLS,
	initialAccounting,
	recordCalls,
	phaseCompressorAllowance,
	remainingCalls,
	selectQuestions,
	type AccountingState,
	type Limits,
	type Refusal,
} from "./evidence/plan.ts";
import { findPrivateContextMarkers } from "./evidence/preflight.ts";
import { routingBlockers } from "./evidence/routing.ts";
import { parseOptions, SCENARIOS, USAGE, type Options, type ScenarioName } from "./evidence/options.ts";
import { scoreAnswers, type Judgement } from "./evidence/scoring.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXTENSION = join(ROOT, "scripts", "evidence-extension.ts");
const PLUGIN_ENTRY = join(ROOT, "src", "index.ts");
const PROMPT_TIMEOUT_MS = 180_000;
const PREFLIGHT_TIMEOUT_MS = 60_000;
const SHUTDOWN_GRACE_MS = 5_000;
const TREE_POLL_MS = 500;
const MIN_PARENT_PATH_LENGTH = 8;
/** Bounded wait for the host's memory to be quiet before a prompt; the run deadline still applies. */
const SETTLE_WAIT_MS = 120_000;
/**
 * Host view budget for the evidence hosts. The product default (128000 bytes) never coarsens a
 * corpus this size, so the saved tree would hold leaves only and no depth could be tested. This
 * runner-only value makes the view coarsen so distinct tree levels exist within the call budget.
 */
const EVIDENCE_VIEW_BYTES = 4_096;
const ANSWER_PREVIEW_CHARS = 240;

/** Compressor usage: admission ledger (attempts) next to observed completed calls. */
interface CompressorReport extends UsageSummary {
	readonly purposes: Record<string, number>;
	readonly maxAttempt: number | null;
	readonly attempted: number;
	readonly observed: number;
	readonly unobserved: number;
}

interface UnavailableReport {
	readonly status: "unavailable";
	readonly reason: string;
}

interface QuestionReport {
	readonly id: string;
	readonly kind: QuestionKind;
	readonly status: "judged" | "unavailable";
	readonly reason: string | null;
	readonly failure: Judgement["failure"];
	readonly outcome: Judgement["outcome"] | null;
	readonly correct: boolean | null;
	readonly valueCorrect: boolean | null;
	readonly grounded: boolean | null;
	readonly hallucinated: boolean | null;
	readonly abstained: boolean | null;
	readonly zoomCalls: number | null;
	readonly maxZoomN: number | null;
	readonly zoomDepth: number | null;
	readonly zoomedSourceRecord: boolean | null;
	readonly latencyMs: number | null;
	readonly answerPreview: string | null;
}

interface TreeReport {
	readonly levels: number[];
	readonly mainParts: number;
	readonly compactorParts: number;
	readonly depthRequirementMet: boolean;
}

interface PhaseReport {
	readonly name: string;
	readonly model: string;
	readonly latencyMs: number | null;
	readonly error: string | null;
	readonly refusal: Refusal | null;
	readonly usage: { readonly main: UsageSummary; readonly compressor: CompressorReport | UnavailableReport };
	readonly questions: QuestionReport[];
	readonly tree: TreeReport | null;
	readonly timestamps: { readonly records: number; readonly matched: number } | null;
}

type ScenarioStatus = "completed" | "not-run" | "budget-stopped" | "failed";

interface ScenarioReport {
	readonly name: ScenarioName;
	readonly status: ScenarioStatus;
	readonly reason: string | null;
	readonly phases: PhaseReport[];
}

/** One compressor collection window: attempts from the admission counter, outputs from the metric sink. */
interface Segment {
	readonly attempted: number;
	readonly observed: number;
	readonly records: UsageRecord[];
	readonly attempts: number[];
	readonly sinkAbsent: boolean;
}

interface HostSlot {
	readonly host: RpcHost;
	readonly memory: string;
	readonly metrics: string;
	readonly admission: string;
	readonly model: string;
	readonly segments: Segment[];
	readonly phases: PhaseDraft[];
	metricCursor: number;
	chargedCursor: number;
}

/** Mutable phase record: finalized into PhaseReport after every host has closed. */
interface PhaseDraft {
	readonly name: string;
	readonly slot: HostSlot;
	readonly segmentStart: number;
	segmentEnd: number;
	latencyMs: number | null;
	error: string | null;
	refusal: Refusal | null;
	main: UsageSummary;
	questions: QuestionReport[];
	tree: TreeReport | null;
	timestamps: { records: number; matched: number } | null;
}

interface ScenarioDraft {
	readonly name: ScenarioName;
	status: ScenarioStatus;
	reason: string | null;
	readonly phases: PhaseDraft[];
}

interface Context {
	readonly options: Options;
	readonly dirs: IsolatedDirs;
	readonly env: Readonly<Record<string, string>>;
	readonly corpus: Corpus;
	readonly questions: readonly Question[];
	readonly knownIds: ReadonlySet<string>;
	readonly prices: ReadonlyMap<string, Price | null>;
	readonly limits: Limits;
	readonly deadlineAt: number;
	readonly aborted: AbortController;
	readonly hosts: Set<RpcHost>;
	readonly scenarios: ScenarioDraft[];
	readonly violations: string[];
	build: PhaseDraft | null;
	state: AccountingState;
}

type PromptOutcome = { readonly kind: "refused"; readonly reason: Refusal } | { readonly kind: "done"; readonly observation: TurnObservation; readonly failure: string | null };

/** Effective-prompt preflight result. Labels and digests only; the prompt text is never reported. */
interface PromptPreflight {
	readonly method: "get_state";
	readonly promptsSent: 0;
	readonly compressorAdmissions: number | null;
	readonly accepted: boolean;
	readonly bytes: number | null;
	readonly sha256: string | null;
	readonly markers: readonly string[];
}

interface Prerequisites {
	readonly blockers: string[];
	readonly host: { executable: string; version: string };
	readonly plugin: { entry: string; present: boolean; revision: { commit: string; dirtyFiles: number } | null };
	readonly catalog: Record<string, CatalogEntry>;
	readonly available: Record<string, boolean>;
	readonly copied: CopiedAuth;
	readonly prompt: PromptPreflight | null;
}

const LIMITATIONS = [
	"cache counters are provider-reported observations; no savings are inferred or claimed",
	"Usage.input is non-cached; promptTokens = input + cacheRead + cacheWrite",
	"cost is the SDK-reported figure or a catalog-rate estimate; neither is a provider invoice",
	"main latency is runner wall-clock per prompt; compressor latency is host-measured per call",
	"enforcement of main calls is prompt admission: calls inside a prompt are not capped, and overruns are reported as violations",
	"compressor calls are admitted inside the host through a per-host allowance; attempts include failed and shutdown work, and observed counts come from the metric sink",
	"an absent metric sink is reported unavailable, never zero; an empty sink is zero completed calls",
	"authentication is isolated: only the selected providers' stored credentials are copied into a temporary auth store, and provider environment variables pass only when named with --allow-env",
	"source models.yml, models.yaml, and models.json are inspected read-only with the SDK's Bun YAML/JSON parsers; model configuration is not copied or migrated into the isolated agent directory",
	"the effective-prompt preflight is a marker check for private context, not a proof of the base prompt's content",
	"the batch prompt answers all selected questions together; per-question zoom attribution is aggregate",
	"the structured answer set is scored strictly; a schema failure is an incorrect outcome for every selected question",
	"source timestamps compare durable record dates with the imported dates; the corpus has no date-answering question",
	"the runner reads only the durable record count and tree coverage; intermediate summaries are never retained as evidence",
	"the evidence hosts run with a runner-only view budget (--optchat-view-bytes 4096) so the tree coarsens within the call budget; the product default is 128000 and is not changed",
	"compressor calls run with reasoning off when a compressor output cap is set, so the cap binds; provider usage.output counts reasoning tokens whenever reasoning is on",
	"a compressor attempt refused by admission is never sent and writes no metric line; completed calls without an admission are charged against the ceiling and reported as violations",
	"routing admission conservatively checks every default sibling, including shadowed files; selected provider keys (even false/null), unreadable non-absent files, parse failures, malformed root/providers shapes, or unresolved routing merge keys block before credential copying",
];

function safeMessage(error: unknown): string {
	return error instanceof Error ? error.message.slice(0, 300) : "unknown error";
}

function newPhase(name: string, slot: HostSlot): PhaseDraft {
	const draft: PhaseDraft = {
		name,
		slot,
		segmentStart: slot.segments.length,
		segmentEnd: slot.segments.length,
		latencyMs: null,
		error: null,
		refusal: null,
		main: summarizeUsage([]),
		questions: [],
		tree: null,
		timestamps: null,
	};
	slot.phases.push(draft);
	return draft;
}

/** Waits for a timer or the run abort, whichever comes first. */
async function pause(context: Context, ms: number): Promise<void> {
	const waiting = Promise.withResolvers<void>();
	const timer = setTimeout(waiting.resolve, ms);
	context.aborted.signal.addEventListener(
		"abort",
		() => {
			clearTimeout(timer);
			waiting.resolve();
		},
		{ once: true },
	);
	await waiting.promise;
}

function assertLive(context: Context): void {
	if (context.aborted.signal.aborted || Date.now() >= context.deadlineAt) throw new Error("run deadline reached");
}

/** Compressor admissions for this host: each main prompt keeps its own reserve, and the phase rule is in plan.ts. */
function phaseAllowance(context: Context, label: string, share: number): number {
	return phaseCompressorAllowance(label, remainingCalls(context.state, context.limits) - DEFAULT_PROMPT_CALLS, share);
}

/** The saved view text: a citation found only here is real memory text, though not a retrieved original. */
async function readViewText(memory: string): Promise<string> {
	try {
		return await readFile(join(memory, "view.json"), "utf8");
	} catch {
		return "";
	}
}

/** Starts one isolated host with a fresh metric sink and admission counter. */
async function openHost(context: Context, label: string, memory: string, model: string, share: number): Promise<HostSlot> {
	assertLive(context);
	const dir = join(context.dirs.root, `host-${label}`);
	const session = join(dir, "session");
	await mkdir(session, { recursive: true, mode: 0o700 });
	await mkdir(memory, { recursive: true, mode: 0o700 });
	const metrics = join(dir, "metrics.jsonl");
	const admission = join(dir, "admission.json");
	await initMetricsFile(metrics);
	await writeFile(admission, JSON.stringify({ dispatched: 0 }), { flag: "wx", mode: 0o600 });
	const allowance = phaseAllowance(context, label, share);
	const host = new RpcHost(
		{
			omp: context.options.omp,
			plugin: PLUGIN_ENTRY,
			memory,
			sessionDir: session,
			cwd: context.dirs.workspace,
			main: model,
			compressor: context.options.compressor,
			metricsFile: metrics,
			admissionFile: admission,
			allowance,
			compressorMaxTokens: context.limits.maxCompressorOutputTokens,
			viewBytes: EVIDENCE_VIEW_BYTES,
			env: context.env,
		},
		EXTENSION,
	);
	context.hosts.add(host);
	return { host, memory, metrics, admission, model, segments: [], phases: [], metricCursor: 0, chargedCursor: 0 };
}

/** One compressor window: every attempt the admission counter recorded, and every completed metric line. */
async function collectCompressor(context: Context, slot: HostSlot): Promise<void> {
	const lines = await readMetricLines(slot.metrics);
	const dispatched = await readAdmissionDispatched(slot.admission);
	const fresh: MetricLine[] = lines === null ? [] : lines.slice(slot.metricCursor);
	if (lines !== null) slot.metricCursor = lines.length;
	const { charged: attempted, total, violation } = chargedAttempts(dispatched, slot.metricCursor, slot.chargedCursor);
	if (violation !== null && !context.violations.includes(violation)) context.violations.push(violation);
	slot.chargedCursor = total;
	context.state = recordCalls(context.state, "compressor", attempted);
	const price = context.prices.get(context.options.compressor) ?? null;
	const records: UsageRecord[] = fresh.map((line) => {
		if (line.output !== null && line.output > context.limits.maxCompressorOutputTokens) {
			context.violations.push(`compressor output ${line.output} exceeds ${context.limits.maxCompressorOutputTokens}`);
		}
		const base = {
			role: "compressor" as const,
			purpose: line.purpose ?? "unknown",
			input: line.input,
			output: line.output,
			cacheRead: line.cacheRead,
			cacheWrite: line.cacheWrite,
			latencyMs: line.latencyMs,
		};
		if (line.costUsd !== null) return { ...base, costUsd: line.costUsd, costSource: "sdk-reported" as const };
		const estimate = price === null ? null : estimateCostUsd(base, price);
		if (estimate !== null) return { ...base, costUsd: estimate, costSource: "catalog-estimate" as const };
		return { ...base, costUsd: null, costSource: "unavailable" as const };
	});
	slot.segments.push({
		attempted,
		observed: fresh.length,
		records,
		attempts: fresh.map((line) => line.attempt).filter((value): value is number => value !== null),
		sinkAbsent: lines === null,
	});
}

/** Stops one host and then accounts its shutdown work into its last phase. Ownership ends here. */
async function closeHost(context: Context, slot: HostSlot): Promise<void> {
	try {
		await slot.host.stop(SHUTDOWN_GRACE_MS);
	} finally {
		context.hosts.delete(slot.host);
	}
	await collectCompressor(context, slot);
	const last = slot.phases.at(-1);
	if (last) last.segmentEnd = slot.segments.length;
}

async function withHost(context: Context, label: string, memory: string, model: string, share: number, body: (slot: HostSlot) => Promise<void>): Promise<void> {
	const slot = await openHost(context, label, memory, model, share);
	try {
		await body(slot);
	} finally {
		await closeHost(context, slot);
	}
}

/** Admits one main prompt, runs it, records observed calls, and keeps the observation even when the prompt fails. */
async function runPrompt(context: Context, slot: HostSlot, message: string): Promise<PromptOutcome> {
	if (context.aborted.signal.aborted) return { kind: "refused", reason: "deadline" };
	const admission = admitPrompt(context.state, context.limits, Date.now(), DEFAULT_PROMPT_CALLS);
	context.state = admission.state;
	if (!admission.admitted) return { kind: "refused", reason: admission.reason };
	const start = slot.host.events.length;
	const remaining = Math.max(1, context.deadlineAt - Date.now());
	let failure: string | null = null;
	try {
		await slot.host.prompt(message, Math.min(PROMPT_TIMEOUT_MS, remaining));
	} catch (error) {
		failure = safeMessage(error);
	}
	const observation = observeTurn(slot.host.events.slice(start), context.prices.get(slot.model) ?? null);
	context.state = recordCalls(context.state, "main", observation.assistantMessages);
	return { kind: "done", observation, failure };
}

async function treeReport(memory: string): Promise<TreeReport | null> {
	const structure = await readTreeStructure(memory);
	if (structure === null) return null;
	return {
		levels: structure.levels,
		mainParts: structure.mainParts,
		compactorParts: structure.compactorParts,
		depthRequirementMet: structure.levels.length >= MIN_TREE_LEVELS,
	};
}

function unavailableQuestion(question: Question, reason: string): QuestionReport {
	return {
		id: question.id,
		kind: question.kind,
		status: "unavailable",
		reason,
		failure: null,
		outcome: null,
		correct: null,
		valueCorrect: null,
		grounded: null,
		hallucinated: null,
		abstained: null,
		zoomCalls: null,
		maxZoomN: null,
		zoomDepth: null,
		zoomedSourceRecord: null,
		latencyMs: null,
		answerPreview: null,
	};
}

/** Scores every selected question from the strict answer set; a schema failure is an incorrect outcome, never unavailable. */
function judge(context: Context, observation: TurnObservation, latencyMs: number, viewText: string): QuestionReport[] {
	const score = scoreAnswers({ questions: context.questions, raw: observation.answer, pages: observation.pages, knownIds: context.knownIds, viewText });
	const zoomN = observation.zoomCalls.map((call) => call.n).filter((value): value is number => value !== null && value >= 1);
	const maxZoomN = zoomN.length > 0 ? Math.max(...zoomN) : null;
	const trimmed = observation.answer.trim();
	// Diagnostic only: the final text as the host returned it, bounded. Never scored from this preview.
	const preview = trimmed === "" ? null : trimmed.slice(0, ANSWER_PREVIEW_CHARS);
	return context.questions.map((question) => {
		const judgement = score.judgements.find((entry) => entry.questionId === question.id);
		if (!judgement) return unavailableQuestion(question, "no judgement produced");
		const sourceIds = new Set(question.sources.map((source) => source.recordId));
		return {
			id: question.id,
			kind: question.kind,
			status: "judged",
			reason: null,
			failure: judgement.failure,
			outcome: judgement.outcome,
			correct: judgement.outcome === "correct",
			valueCorrect: judgement.valueCorrect,
			grounded: judgement.grounded,
			hallucinated: judgement.outcome === "hallucinated",
			abstained: judgement.outcome === "abstained",
			zoomCalls: observation.zoomCalls.length,
			maxZoomN,
			zoomDepth: maxZoomN === null ? null : Math.log2(maxZoomN) + 1,
			zoomedSourceRecord: observation.pages.some((page) => sourceIds.has(page.recordId)),
			latencyMs,
			answerPreview: preview,
		};
	});
}

/**
 * Waits until the host's memory is quiet: no compressor call in flight (admitted attempts equal the
 * completed metric lines) and the saved tree covers every durable record. OptChat refuses a prompt
 * sent before its summaries settle, so a prompt is only sent after this. Returns null once settled;
 * on the bounded wait, returns the last observed state so the timeout says which condition held.
 */
async function awaitSettled(context: Context, slot: HostSlot, memory: string): Promise<string | null> {
	const deadline = Date.now() + SETTLE_WAIT_MS;
	for (;;) {
		assertLive(context);
		const durable = (await readDurableRecords(memory)).length;
		const tree = await readTreeStructure(memory);
		const lines = await readMetricLines(slot.metrics);
		const dispatched = await readAdmissionDispatched(slot.admission);
		const quiet = (lines?.length ?? 0) === dispatched;
		const covered = durable === 0 || (tree !== null && tree.mainLength === durable && tree.compactorLength === durable);
		if (quiet && covered) return null;
		const observed = `durable=${durable} treeMain=${tree?.mainLength ?? "none"} treeCompactor=${tree?.compactorLength ?? "none"} metricLines=${lines?.length ?? "none"} dispatched=${dispatched}`;
		if (Date.now() >= deadline) return observed;
		await pause(context, TREE_POLL_MS);
	}
}

/** One batch prompt answering every selected question on the given host. */
async function answer(context: Context, slot: HostSlot, name: string): Promise<PhaseDraft> {
	const draft = newPhase(name, slot);
	const memory = slot.memory;
	const unsettled = await awaitSettled(context, slot, memory);
	if (unsettled !== null) {
		const message = `memory did not settle within ${SETTLE_WAIT_MS} ms (${unsettled}); no prompt was sent`;
		draft.error = message;
		draft.questions = context.questions.map((question) => unavailableQuestion(question, message));
		await collectCompressor(context, slot);
		draft.segmentEnd = slot.segments.length;
		draft.tree = await treeReport(memory);
		return draft;
	}
	const started = Date.now();
	const outcome = await runPrompt(context, slot, batchPrompt(context.questions));
	if (outcome.kind === "refused") {
		draft.refusal = outcome.reason;
		draft.questions = context.questions.map((question) => unavailableQuestion(question, `prompt refused by admission: ${outcome.reason}`));
	} else {
		const latency = Date.now() - started;
		draft.latencyMs = latency;
		draft.main = summarizeUsage(outcome.observation.usage);
		const stopped = hostStopReason(outcome.observation);
		if (outcome.failure !== null) {
			draft.error = outcome.failure;
			draft.questions = context.questions.map((question) => unavailableQuestion(question, `prompt failed: ${outcome.failure}`));
		} else if (stopped !== null) {
			draft.error = stopped;
			draft.questions = context.questions.map((question) => unavailableQuestion(question, `prompt not completed: ${stopped}`));
		} else {
			draft.questions = judge(context, outcome.observation, latency, await readViewText(memory));
		}
	}
	await collectCompressor(context, slot);
	draft.segmentEnd = slot.segments.length;
	draft.tree = await treeReport(slot.memory);
	return draft;
}

/** Seeds memory through the supported /optchat import command, then waits for the tree to cover every record. */
async function seed(context: Context, memory: string, dates: ReadonlyMap<number, string>): Promise<void> {
	const importFile = join(context.dirs.root, "import.jsonl");
	const count = context.corpus.sources.length;
	const lines = context.corpus.sources.map((source) => JSON.stringify({
		kind: source.kind === "work" ? "work" : "talk",
		text: source.text,
		date: dates.get(source.recordId),
		i: source.recordId,
		...(source.provenance.work ? { metadata: { work: source.provenance.work } } : {}),
	}));
	await writeFile(importFile, `${lines.join("\n")}\n`, { mode: 0o600 });
	await withHost(context, "seed", memory, context.options.main, 1, async (slot) => {
		const draft = newPhase("build", slot);
		context.build = draft;
		const outcome = await runPrompt(context, slot, `/optchat import ${importFile}`);
		if (outcome.kind === "refused") throw new Error(`seeding prompt refused by admission: ${outcome.reason}`);
		draft.main = summarizeUsage(outcome.observation.usage);
		if (outcome.failure !== null) {
			draft.error = outcome.failure;
			throw new Error(`seeding prompt failed: ${outcome.failure}`);
		}
		const durable = await readDurableRecords(memory);
		if (durable.length !== count) throw new Error(`seeding stored ${durable.length} of ${count} records; /optchat import over RPC is unverified`);
		draft.timestamps = { records: durable.length, matched: durable.filter((record) => dates.get(record.i) === record.date).length };
		for (;;) {
			const tree = await readTreeStructure(memory);
			if (tree && tree.mainLength === count && tree.compactorLength === count) break;
			assertLive(context);
			await pause(context, TREE_POLL_MS);
		}
		await collectCompressor(context, slot);
		draft.segmentEnd = slot.segments.length;
		draft.tree = await treeReport(memory);
	});
}

async function runScenario(context: Context, memory: string, draft: ScenarioDraft): Promise<void> {
	const { options } = context;
	const phases = draft.phases;
	const answers = (slot: HostSlot, name: string): Promise<PhaseDraft> => answer(context, slot, name).then((phase) => {
		phases.push(phase);
		return phase;
	});
	switch (draft.name) {
		case "cold":
			await withHost(context, "cold", memory, options.main, 1, async (slot) => {
				await answers(slot, "cold-answers");
			});
			break;
		case "warm":
			await withHost(context, "warm", memory, options.main, 1, async (slot) => {
				await answers(slot, "warm-first");
				await answers(slot, "warm-second");
			});
			break;
		case "restart":
			await withHost(context, "restart", memory, options.main, 1, async (slot) => {
				await answers(slot, "restart-answers");
			});
			break;
		case "expiry": {
			const wait = options.limits.expiryWaitMs;
			if (wait === null) throw new Error("expiry scenario requires --expiry-wait-ms");
			await pause(context, wait);
			assertLive(context);
			await withHost(context, "expiry", memory, options.main, 1, async (slot) => {
				await answers(slot, "expired-answers");
			});
			break;
		}
		case "model-change": {
			const changed = options.modelChange;
			if (changed === null) throw new Error("model-change scenario requires --model-change");
			await withHost(context, "model-change", memory, changed, 1, async (slot) => {
				await answers(slot, "changed-model-answers");
			});
			break;
		}
		case "concurrent": {
			const copies = Array.from({ length: options.concurrency }, (_, index) => join(context.dirs.root, `memory-concurrent-${index}`));
			for (const copy of copies) await cp(memory, copy, { recursive: true });
			const slots: HostSlot[] = [];
			try {
				for (const [index, copy] of copies.entries()) slots.push(await openHost(context, `concurrent-${index}`, copy, options.main, copies.length));
				await Promise.all(slots.map((slot, index) => answers(slot, `concurrent-answers-${index}`)));
			} finally {
				for (const slot of slots) await closeHost(context, slot);
			}
			break;
		}
	}
	const refused = phases.some((phase) => phase.refusal !== null);
	const failed = phases.find((phase) => phase.error !== null);
	if (failed) {
		draft.status = "failed";
		draft.reason = failed.error;
	} else if (refused) {
		draft.status = "budget-stopped";
		draft.reason = "a prompt was refused by admission";
	} else {
		draft.status = "completed";
		draft.reason = null;
	}
}

/** Build, then every requested scenario in SCENARIOS order. Phases recorded before a failure stay in the artifact. */
async function execute(context: Context, memory: string, dates: ReadonlyMap<number, string>): Promise<void> {
	await seed(context, memory, dates);
	for (const draft of context.scenarios) {
		if (draft.status === "not-run") continue;
		try {
			await runScenario(context, memory, draft);
		} catch (error) {
			draft.status = "failed";
			draft.reason = safeMessage(error);
			if (error instanceof Error && error.message === "run deadline reached") throw error;
		}
	}
}

function accuracy(scenarios: readonly ScenarioReport[]): Record<string, number> {
	const judged = scenarios.flatMap((entry) => entry.phases.flatMap((phase) => phase.questions)).filter((entry) => entry.status === "judged");
	return {
		judged: judged.length,
		correct: judged.filter((entry) => entry.correct === true).length,
		valueCorrect: judged.filter((entry) => entry.valueCorrect === true).length,
		grounded: judged.filter((entry) => entry.grounded === true).length,
		abstained: judged.filter((entry) => entry.abstained === true).length,
		hallucinated: judged.filter((entry) => entry.hallucinated === true).length,
		incorrectSchema: judged.filter((entry) => entry.failure === "schema").length,
	};
}

/** Compressor report for one phase: the admission ledger plus observed completed calls. */
function compressorReport(segments: readonly Segment[]): CompressorReport | UnavailableReport {
	if (segments.some((segment) => segment.sinkAbsent)) return { status: "unavailable", reason: "host wrote no metric sink; absent sink is not zero calls" };
	const records = segments.flatMap((segment) => segment.records);
	const attempts = segments.flatMap((segment) => segment.attempts);
	const attempted = segments.reduce((sum, segment) => sum + segment.attempted, 0);
	const observed = segments.reduce((sum, segment) => sum + segment.observed, 0);
	const purposes: Record<string, number> = {};
	for (const record of records) purposes[record.purpose] = (purposes[record.purpose] ?? 0) + 1;
	return {
		...summarizeUsage(records),
		purposes,
		maxAttempt: attempts.length > 0 ? Math.max(...attempts) : null,
		attempted,
		observed,
		unobserved: attempted - observed,
	};
}

function toPhase(draft: PhaseDraft): PhaseReport {
	return {
		name: draft.name,
		model: draft.slot.model,
		latencyMs: draft.latencyMs,
		error: draft.error,
		refusal: draft.refusal,
		usage: { main: draft.main, compressor: compressorReport(draft.slot.segments.slice(draft.segmentStart, draft.segmentEnd)) },
		questions: draft.questions,
		tree: draft.tree,
		timestamps: draft.timestamps,
	};
}

/**
 * Effective-prompt preflight, run before any real host exists. A zero-allowance host reports its
 * system prompt through `get_state`; the prompt is checked for private context and runner host
 * paths; an accepted prompt is written to a private file under the run's temp root (removed with
 * it). The host never receives a prompt, and the admission counter must still read zero afterward.
 */
async function effectivePromptPreflight(options: Options, dirs: IsolatedDirs, env: Readonly<Record<string, string>>, parentPaths: readonly string[]): Promise<{ blockers: string[]; report: PromptPreflight | null }> {
	const dir = join(dirs.root, "preflight");
	const memory = join(dir, "memory");
	const session = join(dir, "session");
	await mkdir(memory, { recursive: true, mode: 0o700 });
	await mkdir(session, { recursive: true, mode: 0o700 });
	const metrics = join(dir, "metrics.jsonl");
	const admission = join(dir, "admission.json");
	await initMetricsFile(metrics);
	await writeFile(admission, JSON.stringify({ dispatched: 0 }), { flag: "wx", mode: 0o600 });
	let prompt: string;
	try {
		prompt = await readEffectivePrompt({
			omp: options.omp,
			plugin: PLUGIN_ENTRY,
			memory,
			sessionDir: session,
			cwd: dirs.workspace,
			main: options.main,
			compressor: options.compressor,
			metricsFile: metrics,
			admissionFile: admission,
			allowance: 0,
			compressorMaxTokens: options.limits.maxCompressorOutputTokens,
			viewBytes: EVIDENCE_VIEW_BYTES,
			env,
		}, EXTENSION, PREFLIGHT_TIMEOUT_MS);
	} catch (error) {
		return { blockers: [`effective prompt preflight failed: ${safeMessage(error)}`], report: null };
	}
	const compressorAdmissions = await readAdmissionDispatched(admission);
	const markers = findPrivateContextMarkers([prompt], parentPaths);
	const blockers: string[] = [];
	if (compressorAdmissions !== 0) blockers.push("effective prompt preflight dispatched a compressor call");
	if (markers.length > 0) blockers.push(`effective system prompt carries private context: ${markers.join(", ")}`);
	const accepted = blockers.length === 0;
	if (accepted) await writeFile(join(dir, "effective-system-prompt.txt"), prompt, { flag: "wx", mode: 0o600 });
	return {
		blockers,
		report: {
			method: "get_state",
			promptsSent: 0,
			compressorAdmissions,
			accepted,
			bytes: Buffer.byteLength(prompt),
			sha256: accepted ? createHash("sha256").update(prompt).digest("hex") : null,
			markers,
		},
	};
}

/**
 * Auth, catalog, and effective-prompt prerequisites through public host surfaces only. Creates no
 * provider request. The prompt preflight runs only after model auth and catalog pass, and before
 * any real host is opened.
 */
async function prerequisites(options: Options, selectors: readonly string[], dirs: IsolatedDirs, env: Readonly<Record<string, string>>, copied: CopiedAuth, parentPaths: readonly string[]): Promise<Prerequisites> {
	const blockers: string[] = [];
	const catalog: Record<string, CatalogEntry> = {};
	for (const selector of selectors) catalog[selector] = await readCatalogEntry(options.omp, selector, env, dirs.workspace);
	const models = await queryAvailableModels(options.omp, env, dirs.sessions, dirs.workspace);
	const available: Record<string, boolean> = {};
	for (const selector of selectors) {
		available[selector] = isAvailable(models, selector);
		if (!catalog[selector]!.found) blockers.push(`model is not in the local catalog: ${selector}`);
		if (!available[selector]) blockers.push(`no configured auth for ${selector} in the isolated host`);
	}
	const present = await stat(PLUGIN_ENTRY).then(() => true, () => false);
	if (!present) blockers.push("plugin entry src/index.ts is missing");
	const extensionPresent = await stat(EXTENSION).then(() => true, () => false);
	if (!extensionPresent) blockers.push("evidence extension scripts/evidence-extension.ts is missing");
	const prompt = blockers.length === 0 ? await effectivePromptPreflight(options, dirs, env, parentPaths) : null;
	if (prompt) blockers.push(...prompt.blockers);
	return {
		blockers,
		host: { executable: basename(options.omp), version: await hostVersion(options.omp, env, dirs.workspace) },
		plugin: { entry: "src/index.ts", present, revision: await pluginRevision(ROOT) },
		catalog,
		available,
		copied,
		prompt: prompt?.report ?? null,
	};
}

function scenarioDrafts(requested: ReadonlySet<ScenarioName>): ScenarioDraft[] {
	return SCENARIOS.map((name) => (requested.has(name)
		? { name, status: "failed", reason: "not reached: build did not complete", phases: [] }
		: { name, status: "not-run", reason: "not requested", phases: [] }));
}

async function run(options: Options, corpus: Corpus, questions: readonly Question[], root: string): Promise<void> {
	const dirs = await createIsolatedDirs(root);
	assertWorkspaceBoundary(dirs);
	const selectors = [options.main, options.compressor, ...(options.modelChange ? [options.modelChange] : [])];
	const providers = [...new Set(selectors.map(providerOf))];
	const sourceAgentDir = options.agentDir ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".omp", "agent");
	// Before any credential is copied or any authenticated discovery: a re-routed provider is a blocker.
	const routing = await routingBlockers(sourceAgentDir, providers);
	if (routing.length > 0) {
		console.log(JSON.stringify({ status: "blocked", reason: "prerequisites not satisfied", blockers: routing }, null, 2));
		process.exitCode = 1;
		return;
	}
	const copied = await copySelectedAuth(sourceAgentDir, dirs.agentDir, providers);
	const parentPaths = [homedir(), sourceAgentDir, ROOT].filter((path) => path.length >= MIN_PARENT_PATH_LENGTH);
	const env: Record<string, string> = {
		...childEnvironment(process.env, dirs, options.allowEnv),
		OPTCHAT_EVIDENCE_PARENT_PATHS: JSON.stringify(parentPaths),
	};
	const preflight = await prerequisites(options, selectors, dirs, env, copied, parentPaths);
	const plan = {
		schema: ARTIFACT_SCHEMA,
		corpus: { version: corpus.version, seed: corpus.seed, digest: corpus.digest, sources: corpus.sources.length, minSourceBytes: corpus.minSourceBytes, questionsTotal: corpus.questions.length, questionsSelected: questions.length },
		limits: options.limits,
		scenarios: options.scenarios,
		prerequisites: preflight,
	};
	if (!options.confirm || preflight.blockers.length > 0) {
		console.log(JSON.stringify({
			status: preflight.blockers.length > 0 ? "blocked" : "not-run",
			reason: options.confirm ? "prerequisites not satisfied" : "pass --confirm-live-provider-calls to make live provider calls",
			invocation: `bun run scripts/evidence-recall.ts --confirm-live-provider-calls --main ${options.main} --compressor ${options.compressor}`,
			plan,
		}, null, 2));
		process.exitCode = preflight.blockers.length > 0 ? 1 : 0;
		return;
	}

	const prices = new Map<string, Price | null>();
	for (const selector of selectors) prices.set(selector, preflight.catalog[selector]?.price ?? null);
	const dates = new Map<number, string>();
	for (const source of corpus.sources) dates.set(source.recordId, new Date(Date.UTC(2026, 0, 1, 0, source.recordId)).toISOString());
	const requested = new Set<ScenarioName>(options.scenarios);
	const context: Context = {
		options,
		dirs,
		env,
		corpus,
		questions,
		knownIds: new Set(corpus.knownIds),
		prices,
		limits: options.limits,
		deadlineAt: Date.now() + options.limits.deadlineMs,
		aborted: new AbortController(),
		hosts: new Set(),
		scenarios: scenarioDrafts(requested),
		violations: [],
		build: null,
		state: initialAccounting(Date.now()),
	};

	const memory = join(root, "memory-shared");
	let error: string | null = null;
	let deadlineHit = false;
	const pipeline = execute(context, memory, dates);
	const expiry = Promise.withResolvers<never>();
	const timer = setTimeout(() => {
		deadlineHit = true;
		context.aborted.abort();
		expiry.reject(new Error("run deadline reached"));
	}, options.limits.deadlineMs);
	try {
		await Promise.race([pipeline, expiry.promise]);
	} catch (caught) {
		error = safeMessage(caught);
	} finally {
		clearTimeout(timer);
		context.aborted.abort();
		// Give in-flight work a bounded moment to unwind, then end every owned host regardless.
		const grace = Promise.withResolvers<void>();
		const graceTimer = setTimeout(grace.resolve, SHUTDOWN_GRACE_MS);
		await Promise.race([pipeline.catch(() => undefined), grace.promise]);
		clearTimeout(graceTimer);
		await Promise.all([...context.hosts].map((host) => host.stop(SHUTDOWN_GRACE_MS)));
	}

	const scenarios: ScenarioReport[] = context.scenarios.map((draft) => ({
		name: draft.name,
		status: draft.status,
		reason: draft.reason,
		phases: draft.phases.map(toPhase),
	}));
	const failedScenario = scenarios.some((entry) => entry.status === "failed");
	const refused = scenarios.some((entry) => entry.phases.some((phase) => phase.refusal !== null));
	let status: "completed" | "failed" | "budget-stopped" = "completed";
	if (deadlineHit || refused) status = "budget-stopped";
	if (failedScenario || (error !== null && !deadlineHit) || context.build?.error) status = "failed";
	const violations = [
		...accountingViolations(context.state, options.limits),
		...context.violations,
		...(deadlineHit ? ["run deadline reached; work stopped and owned hosts ended"] : []),
	];
	const artifact = {
		schema: ARTIFACT_SCHEMA,
		generatedAt: new Date().toISOString(),
		status,
		error,
		synthetic: true,
		host: preflight.host,
		plugin: preflight.plugin,
		corpus: plan.corpus,
		build: context.build ? toPhase(context.build) : null,
		models: { main: options.main, compressor: options.compressor, modelChange: options.modelChange, catalog: preflight.catalog },
		auth: { checkedBy: "host get_available_models", available: preflight.available, copiedProviders: preflight.copied.copied, missingProviders: preflight.copied.missing },
		limits: {
			...options.limits,
			enforcement: "prompt-admission",
			callsUsed: context.state.mainCalls + context.state.compressorCalls,
			violations,
		},
		scenarios,
		accuracy: accuracy(scenarios),
		limitations: LIMITATIONS,
	};
	const errors = validateArtifact(artifact);
	if (errors.length > 0) throw new Error(`artifact failed validation: ${errors.join("; ")}`);
	await writeFile(resolve(options.out), `${JSON.stringify(artifact, null, 2)}\n`, { mode: 0o600 });
	console.log(JSON.stringify({ status, out: options.out, callsUsed: artifact.limits.callsUsed, accuracy: artifact.accuracy }, null, 2));
	if (status !== "completed") process.exitCode = 1;
}

async function main(): Promise<void> {
	const options = parseOptions(Bun.argv.slice(2));
	if (!options.force && (await stat(resolve(options.out)).then(() => true, () => false))) {
		throw new Error(`refusing to overwrite ${options.out}; pass --force`);
	}
	const corpus = buildCorpus({ seed: options.seed, projects: options.projects, sourceCount: options.sourceCount, minSourceBytes: options.minSourceBytes });
	const questions = selectQuestions(corpus.questions, options.questionLimit);
	const root = await mkdtemp(join(tmpdir(), "omp-optchat-evidence-"));
	try {
		await run(options, corpus, questions, root);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

try {
	await main();
	process.exit(process.exitCode ?? 0);
} catch (caught) {
	console.error(caught instanceof Error ? caught.message : String(caught));
	console.error(USAGE);
	process.exit(1);
}
