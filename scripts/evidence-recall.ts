#!/usr/bin/env bun
/**
 * Opt-in, authenticated, synthetic-only long-history recall and cache evidence.
 *
 * Makes real provider calls through an isolated OMP host: a temporary HOME, agent directory,
 * workspace, and XDG tree, with only the selected provider credentials copied in and only the
 * explicitly allowed environment variables passed through. Nothing is called unless
 * --confirm-live-provider-calls is passed, and a live run requires --max-cost-usd.
 * --fixture-provider runs the same pipeline against loopback fixture models: no credentials are
 * copied and no provider is reached.
 *
 *   bun run scripts/evidence-recall.ts --confirm-live-provider-calls --max-cost-usd 5 \
 *     --main <provider/model> --compressor <provider/model> --out evidence.json
 *
 * Limits: main calls are admitted per prompt (calls inside a prompt are not capped; overruns are
 * reported as violations). Compressor calls are admitted inside the host through a per-host call
 * allowance and a per-host dollar allowance. Dollars are admitted before each main prompt from a
 * worst-case bound (catalog rates and context window); an unknown rate or an unobservable spend
 * refuses further live work.
 */
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
	ARTIFACT_SCHEMA,
	armCacheReadShare,
	armTotalCost,
	estimateCostUsd,
	mainSteadyStateCacheReadShare,
	maintenanceSummary,
	roleCacheReadShare,
	MIN_TREE_LEVELS,
	pairedComparison,
	summarizeUsage,
	validateArtifact,
	type ArmSide,
	type ChildArmSummary,
	type ChildReport,
	type MaintenanceSummary,
	type PairedComparison,
	type Price,
	type UsageRecord,
	type UsageSummary,
} from "./evidence/artifact.ts";
import { initialAdmission } from "./evidence/admission.ts";
import { buildCorpus, type Corpus, type Question, type QuestionKind } from "./evidence/corpus.ts";
import { compressorCallBoundUsd, type CompactorLayout, DollarReservations, mainPromptBoundUsd, type MainPromptBytes, type ModelRates, offCompactionBoundUsd, SYSTEM_BLOCK_BYTES, TOOL_SCHEMA_BYTES } from "./evidence/cost.ts";
import {
	type ArmBase,
	type ChildArmResult,
	childSpendUsd,
	type ChildTaskOutcome,
	type ChildUsage,
	DEFAULT_CHILD_TASKS,
	deriveChildTasks,
	runChildArm,
} from "./evidence/child.ts";
import { hostVersion, isAvailable, pluginRevision, providerOf, readCatalogEntry, type CatalogEntry } from "./evidence/discovery.ts";
import {
	hostStopReason,
	initMetricsFile,
	observeTurn,
	readEffectivePrompt,
	queryAvailableModels,
	readAdmissionDispatched,
	readAdmissionCounts,
	readDurableRecords,
	readMetricLines,
	compressorFailures,
	readTreeStructure,
	RpcHost,
	type MetricLine,
	type TurnObservation,
} from "./evidence/host.ts";
import { assertWorkspaceBoundary, childEnvironment, copySelectedAuth, createIsolatedDirs, writeMainModelOverrides, type CopiedAuth, type IsolatedDirs } from "./evidence/isolation.ts";
import {
	accountingViolations,
	admitPrompt,
	batchPrompt,
	chargedAttempts,
	DEFAULT_PROMPT_CALLS,
	initialAccounting,
	type AccountingState,
	recordCalls,
	phaseCompressorAllowance,
	remainingCalls,
	selectQuestions,
	type Limits,
	type Refusal,
} from "./evidence/plan.ts";
import { findPrivateContextMarkers, mainContextWindowBlocker } from "./evidence/preflight.ts";
import { routingBlockers } from "./evidence/routing.ts";
import { parseOptions, SCENARIOS, USAGE, type Arm, type Options, type ScenarioName } from "./evidence/options.ts";
import { answerInstruction, armTotals, type Judgement, scoreAnswers, type ArmTotals } from "./evidence/scoring.ts";
import { estimateMaintenanceUsage, type MaintenanceEstimate, readAuxiliaryUsage, readCompactionEvidence, type SeedRecord, writeSeededSession } from "./evidence/seed.ts";
import { type FixtureRequest, type OfflineServer, startOfflineServer } from "./evidence/offline-server.ts";
import { BATCH_MARKER, type FixtureState, fixtureReply } from "./evidence/fixture-replies.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXTENSION = join(ROOT, "scripts", "evidence-extension.ts");
/** Fixture-mode host entry: the evidence extension plus the loopback fixture provider (one `-e` slot per host). */
const FIXTURE_EXTENSION = join(ROOT, "scripts", "evidence-fixture-extension.ts");
/** Catalog and availability discovery loads only the fixture provider, which needs no evidence environment. */
const FIXTURE_PROVIDER = join(ROOT, "scripts", "fixture-provider.ts");
const PLUGIN_ENTRY = join(ROOT, "src", "index.ts");
const PROMPT_TIMEOUT_MS = 180_000;
const PREFLIGHT_TIMEOUT_MS = 60_000;
const SHUTDOWN_GRACE_MS = 5_000;
const TREE_POLL_MS = 500;
const MIN_PARENT_PATH_LENGTH = 8;
/** Bounded wait for the host's memory to be quiet before a prompt; the run deadline still applies. */
const SETTLE_WAIT_MS = 120_000;
const ANSWER_PREVIEW_CHARS = 240;
/** Stand-in ceiling for a host whose dollar cap is not enforced (no --max-cost-usd): effectively unbounded. */
const UNBOUNDED_USD = 1e12;

/** Compactor layout at product defaults: nodeBytes (src/config.ts) and compactionViewBytes (src/memory.ts). */
const COMPACTOR_LAYOUT: CompactorLayout = { nodeBytes: 512, pageBytes: 16_384, compactionViewBytes: 32_000 };

/** UTF-8 bytes of one retrieved zoom page, matching src/archive.ts DEFAULT_PAGE_BYTES. */
const PAGE_BYTES = 16_384;
/**
 * A child task reserves this multiple of one main prompt's worst case: the parent turn plus the child
 * run, with the child's own calls not separately bounded. The factor is generous on purpose; the
 * reserve is released only by observed spend at the end of the arm.
 */
const CHILD_RESERVE_FACTOR = 2;
/** Scenarios the off arm can run: it has no memory state to restart, expire, share, or swap. */
const OFF_SCENARIOS: readonly ScenarioName[] = ["cold", "warm"];
/** Maintenance with no compaction: zero tokens and zero cost. Any compaction replaces this with a captured estimate. */
const NO_MAINTENANCE: MaintenanceEstimate = { compactions: 0, estimated: false, costUsdLow: 0, costUsdHigh: 0 };
const OFF_ARM_COMPRESSOR_REASON = "the off arm runs no compressor";

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

/** One per-question turn: its own latency and usage; `refusal` stops the remaining turns. */
interface TurnReport {
	readonly questionId: string;
	readonly latencyMs: number | null;
	readonly refusal: RunRefusal | null;
	readonly error: string | null;
	readonly usage: UsageSummary;
}

interface PhaseReport {
	readonly name: string;
	readonly arm: Arm;
	readonly compressor: string | null;
	readonly model: string;
	readonly latencyMs: number | null;
	readonly error: string | null;
	readonly refusal: RunRefusal | null;
	readonly usage: { readonly main: UsageSummary; readonly compressor: CompressorReport | UnavailableReport; readonly auxiliary: UsageSummary };
	readonly maintenance: MaintenanceSummary;
	readonly turns: TurnReport[];
	readonly questions: QuestionReport[];
	readonly tree: TreeReport | null;
	readonly timestamps: { readonly records: number; readonly matched: number } | null;
}

type ScenarioStatus = "completed" | "not-run" | "budget-stopped" | "failed";

interface ScenarioReport {
	readonly name: ScenarioName;
	readonly arm: Arm;
	readonly compressor: string | null;
	readonly status: ScenarioStatus;
	readonly reason: string | null;
	readonly phases: PhaseReport[];
}

/** Why a run stopped before a dispatch: a call or deadline limit, or a dollar bound that cannot be proven. */
type RunRefusal = Refusal | "cost-cap" | "unknown-cost";

/** Thrown before a host opens or a prompt is sent when the dollar cap cannot be proven to hold. */
class BudgetStop extends Error {
	readonly reason: RunRefusal;

	constructor(reason: RunRefusal, detail: string) {
		super(detail);
		this.reason = reason;
	}
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
	readonly arm: Arm;
	readonly compressor: string | null;
	readonly model: string;
	readonly memory: string;
	readonly metrics: string;
	readonly admission: string;
	readonly sessionDir: string;
	/** Off arm: the seeded history's UTF-8 bytes at open; zero on the on arm. */
	readonly historyBytes: number;
	/** UTF-8 bytes of earlier turns (question, answer, retrieved text) that stay in this host's prompt. */
	priorBytes: number;
	/** Observed compressor USD of this host; null once any record is unobserved. */
	compressorUsd: number | null;
	/** Ledger id of this host's compressor allowance; null when the cap is unbounded or the arm is off. */
	reservationId: string | null;
	readonly segments: Segment[];
	readonly phases: PhaseDraft[];
	metricCursor: number;
	chargedCursor: number;
	/** Auxiliary records already charged, and compaction entries already counted, for this host's session. */
	auxCursor: number;
	compactionCursor: number;
}

interface HostSpec {
	readonly label: string;
	readonly kind: "seed" | "restart" | "phase";
	readonly arm: Arm;
	readonly compressor: string | null;
	readonly memory: string;
	readonly model: string;
	/** Main prompts this host will send: its reserve of worst-case dollars, per model bound. */
	readonly prompts: number;
	readonly share: number;
}

interface TurnDraft {
	readonly questionId: string;
	latencyMs: number | null;
	refusal: RunRefusal | null;
	error: string | null;
	readonly records: UsageRecord[];
}

/** Mutable phase record: finalized into PhaseReport after every host has closed. */
interface PhaseDraft {
	readonly name: string;
	readonly slot: HostSlot;
	readonly segmentStart: number;
	segmentEnd: number;
	latencyMs: number | null;
	/** Wall-clock latency of every prompt in this phase, for the per-turn mean. */
	readonly latencies: number[];
	error: string | null;
	refusal: RunRefusal | null;
	readonly records: UsageRecord[];
	readonly questions: QuestionReport[];
	readonly judgements: Judgement[];
	readonly turns: TurnDraft[];
	tree: TreeReport | null;
	timestamps: { records: number; matched: number } | null;
	/** Auxiliary (session model_usage) records observed while this phase's hosts ran. */
	readonly auxiliary: UsageRecord[];
	/** Maintenance estimate merged across this phase's prompts and its host's shutdown. */
	maintenance: MaintenanceEstimate;
}

interface ScenarioDraft {
	readonly name: ScenarioName;
	readonly arm: Arm;
	readonly compressor: string | null;
	status: ScenarioStatus;
	reason: string | null;
	readonly phases: PhaseDraft[];
}

/** One arm × compressor unit: the on arm owns a memory built by its compressor; the off arm owns none. */
interface Unit {
	readonly arm: Arm;
	readonly compressor: string | null;
	readonly memory: string;
	build: PhaseDraft | null;
	buildError: string | null;
	readonly scenarios: ScenarioDraft[];
}

interface ChildExperiment {
	readonly status: "completed" | "unavailable" | "failed";
	readonly reason: string | null;
	readonly arms: Record<"view" | "blind", ChildArmResult | null>;
}

interface Context {
	readonly options: Options;
	readonly dirs: IsolatedDirs;
	readonly root: string;
	readonly fixture: FixtureState;
	readonly env: Readonly<Record<string, string>>;
	readonly hostExtension: string;
	readonly corpus: Corpus;
	readonly questions: readonly Question[];
	readonly knownIds: ReadonlySet<string>;
	readonly seedRecords: readonly SeedRecord[];
	readonly seededRecords: ReadonlyMap<string, string>;
	readonly dates: ReadonlyMap<number, string>;
	readonly prices: ReadonlyMap<string, Price | null>;
	readonly rates: ReadonlyMap<string, ModelRates | null>;
	readonly limits: Limits;
	readonly capUsd: number | null;
	/** Measured effective prompt bytes, or null when the preflight did not measure them. */
	readonly systemBytes: number | null;
	readonly deadlineAt: number;
	readonly aborted: AbortController;
	readonly hosts: Set<RpcHost>;
	readonly violations: string[];
	readonly units: Unit[];
	state: AccountingState;
	readonly reservations: DollarReservations;
	hostSeq: number;
	reservationSeq: number;
	child: ChildExperiment | null;
}

/** Side-session usage collected after one prompt, or at host shutdown. */
interface SideUsage {
	readonly auxiliary: UsageRecord[];
	readonly maintenance: MaintenanceEstimate;
}

type PromptOutcome =
	| { readonly kind: "refused"; readonly reason: RunRefusal }
	| { readonly kind: "done"; readonly observation: TurnObservation; readonly failure: string | null; readonly side: SideUsage };

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
	"dollar admission bounds each main prompt by the catalog rates and context window times the prompt's worst-case call count; the off arm adds a native-compaction bound over the whole seeded history and the prompt (an unknown output ceiling refuses), and each compressor call is bounded by its context window and output cap; an unknown rate, context window, or unobservable spend refuses further live work",
	"main latency is runner wall-clock per prompt; compressor latency is host-measured per call",
	"enforcement of main calls is prompt admission: calls inside a prompt are not capped, and overruns are reported as violations",
	"compressor calls are admitted inside the host through a per-host call and dollar allowance; attempts include failed and shutdown work, and observed counts come from the metric sink",
	"an absent metric sink is reported unavailable, never zero; an empty sink is zero completed calls",
	"authentication is isolated: only the selected providers' stored credentials are copied into a temporary auth store, and provider environment variables pass only when named with --allow-env",
	"source models.yml, models.yaml, and models.json are inspected read-only with the SDK's Bun YAML/JSON parsers; model configuration is not copied or migrated into the isolated agent directory",
	"the effective-prompt preflight is a marker check for private context, not a proof of the base prompt's content",
	"the batch prompt answers all selected questions together; per-question zoom attribution is aggregate; per-question turns attribute latency and usage to each question",
	"the structured answer set is scored strictly; a schema failure is an incorrect outcome for every selected question",
	"the off arm is a seeded session resumed with OptChat disabled: no memory tools are offered and its prompt does not mention them; native compaction may run inside the session",
	"maintenance is an interval estimated from captured compaction frames and catalog prices, never an exact cost; an unpriced frame leaves its interval null",
	"the paired delta is computed only when both arms completed every requested scenario; no savings are claimed",
	"source timestamps compare durable record dates with the imported dates; the corpus has no date-answering question",
	"the runner reads only the durable record count and tree coverage; intermediate summaries are never retained as evidence",
	"the evidence hosts run with a runner-only view budget (--view-bytes, default 4096) so the tree coarsens within the call budget; the product default is 128000 and is not changed",
	"compressor calls run with reasoning off when a compressor output cap is set, so the cap binds; provider usage.output counts reasoning tokens whenever reasoning is on",
	"a compressor attempt refused by admission is never sent and writes no metric line; completed calls without an admission are charged against the ceiling and reported as violations",
	"routing admission conservatively checks every default sibling, including shadowed files; selected provider keys (even false/null), unreadable non-absent files, parse failures, malformed root/providers shapes, or unresolved routing merge keys block before credential copying",
];

function safeMessage(error: unknown): string {
	return error instanceof Error ? error.message.slice(0, 300) : "unknown error";
}

function isDeadline(error: unknown): boolean {
	return error instanceof Error && error.message === "run deadline reached";
}

function newPhase(name: string, slot: HostSlot): PhaseDraft {
	const draft: PhaseDraft = {
		name,
		slot,
		segmentStart: slot.segments.length,
		segmentEnd: slot.segments.length,
		latencyMs: null,
		latencies: [],
		error: null,
		refusal: null,
		records: [],
		questions: [],
		judgements: [],
		turns: [],
		tree: null,
		timestamps: null,
		auxiliary: [],
		maintenance: NO_MAINTENANCE,
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

/** Compressor admissions for one host: the phase rule is in plan.ts; each main prompt keeps its own reserve. */
function callAllowanceFor(context: Context, kind: HostSpec["kind"], share: number): number {
	return phaseCompressorAllowance(kind, remainingCalls(context.state, context.limits) - DEFAULT_PROMPT_CALLS, share);
}

/** The saved view text: a citation found only here is real memory text, though not a retrieved original. */
async function readViewText(memory: string): Promise<string> {
	try {
		return await readFile(join(memory, "view.json"), "utf8");
	} catch {
		return "";
	}
}

function ratesOf(entry: CatalogEntry | undefined): ModelRates | null {
	if (entry === undefined || !entry.found || entry.price === null || entry.contextWindow === null) return null;
	return {
		inputRate: entry.price.input,
		outputRate: entry.price.output,
		cacheReadRate: entry.price.cacheRead,
		cacheWriteRate: entry.price.cacheWrite,
		contextWindow: entry.contextWindow,
		maxOutput: entry.maxOutput,
	};
}

/**
 * Effective system bytes of a host's prompt: the measured preflight bytes plus the OptChat system block. The block is
 * added even when the measurement already contains it, which only over-bounds.
 */
function effectiveSystemBytes(measured: number | null): number | null {
	return measured === null ? null : measured + SYSTEM_BLOCK_BYTES;
}

/**
 * Worst case for one main prompt. Tokens are bounded by the prompt's UTF-8 bytes, clamped to the window; the output
 * is the pinned cap. History is the view on the on arm and the seeded history on the off arm, plus prior turns on both.
 * The per-call bound is multiplied by the prompt's call bound only, never by the number of prompts. Null when unknown.
 */
function mainBoundUsd(rates: ModelRates | null, systemBytes: number | null, options: Options, arm: Arm, historyBytes: number, priorBytes: number, questionBytes: number): number | null {
	const system = effectiveSystemBytes(systemBytes);
	if (system === null) return null;
	const history = (arm === "on" ? options.viewBytes : historyBytes) + priorBytes;
	const bytes: MainPromptBytes = { system, tools: TOOL_SCHEMA_BYTES, history, question: questionBytes, retrieval: DEFAULT_PROMPT_CALLS * PAGE_BYTES };
	return mainPromptBoundUsd(rates, bytes, options.maxMainOutputTokens, DEFAULT_PROMPT_CALLS);
}

/**
 * Worst case for one admitted prompt. The on arm admits by its main bound alone. The off arm also adds the native
 * compaction bound over the seeded history, the prior turns, and this question, priced at the pinned output cap.
 */
function admissionBoundUsd(context: Context, slot: HostSlot, message: string): number | null {
	const rates = context.rates.get(slot.model) ?? null;
	const questionBytes = Buffer.byteLength(message, "utf8");
	const main = mainBoundUsd(rates, context.systemBytes, context.options, slot.arm, slot.historyBytes, slot.priorBytes, questionBytes);
	if (main === null || slot.arm === "on") return main;
	const compaction = offCompactionBoundUsd(rates, slot.historyBytes + slot.priorBytes, questionBytes, context.options.maxMainOutputTokens);
	return compaction === null ? null : main + compaction;
}

/** Catalog list prices by selector, for the maintenance estimator. Models with no known price are absent. */
function priceRecord(context: Context): Record<string, Price> {
	const prices: Record<string, Price> = {};
	for (const [selector, price] of context.prices) if (price !== null) prices[selector] = price;
	return prices;
}

/** Compaction entries across every session file this host has written so far. */
async function compactionEntriesIn(sessionDir: string): Promise<number> {
	let total = 0;
	for (const name of (await readdir(sessionDir)).filter((entry) => entry.endsWith(".jsonl"))) {
		total += (await readCompactionEvidence(join(sessionDir, name))).compactionEntries;
	}
	return total;
}

/**
 * Side-session usage since this host's last collection. Auxiliary records are exact or unobserved; maintenance is
 * estimated from the compaction frames in `events` and the compaction entries not yet counted. Both are charged once
 * here: auxiliary's exact cost and maintenance's high bound. A null charge leaves the spend ledger unobserved.
 */
async function collectSideUsage(context: Context, slot: HostSlot, events: readonly Record<string, unknown>[]): Promise<SideUsage> {
	const records = await readAuxiliaryUsage(slot.sessionDir);
	const auxiliary = records.slice(slot.auxCursor);
	slot.auxCursor = records.length;
	const entries = await compactionEntriesIn(slot.sessionDir);
	const maintenance = estimateMaintenanceUsage({ compactionEntries: entries - slot.compactionCursor, events, mainModel: slot.model, prices: priceRecord(context) });
	slot.compactionCursor = entries;
	context.reservations.recordSpend(spendOf(auxiliary));
	context.reservations.recordSpend(maintenance.costUsdHigh);
	return { auxiliary, maintenance };
}

/** Sums two maintenance estimates. Zero compactions stay exact zero; an interval is null when either side is unpriced. */
function mergeMaintenance(a: MaintenanceEstimate, b: MaintenanceEstimate): MaintenanceEstimate {
	const compactions = a.compactions + b.compactions;
	if (compactions === 0) return NO_MAINTENANCE;
	const low = a.costUsdLow === null || b.costUsdLow === null ? null : a.costUsdLow + b.costUsdLow;
	const high = a.costUsdHigh === null || b.costUsdHigh === null ? null : a.costUsdHigh + b.costUsdHigh;
	const valid = (a.compactions === 0 || a.estimated) && (b.compactions === 0 || b.estimated);
	if (valid && low !== null && high !== null) return { compactions, estimated: true, costUsdLow: low, costUsdHigh: high };
	return { compactions, estimated: false, costUsdLow: null, costUsdHigh: null, reason: a.reason ?? b.reason ?? "maintenance cost is unobserved" };
}

/** The estimator's result as the artifact's maintenance summary: an interval only when both bounds were priced. */
function maintenanceReport(estimate: MaintenanceEstimate): MaintenanceSummary {
	const interval = estimate.costUsdLow === null || estimate.costUsdHigh === null ? null : { lowUsd: estimate.costUsdLow, highUsd: estimate.costUsdHigh };
	return maintenanceSummary({ compactions: estimate.compactions, interval, reason: estimate.reason ?? "compaction cost unobserved" });
}

/** Why an arm's total is unobserved, mirroring armTotalCost's null conditions; null when the total is present. */
function unobservedTotalReason(roles: readonly UsageSummary[], maintenance: MaintenanceSummary): string | null {
	if (roles.some((usage) => usage.calls > 0 && usage.costUsd === null)) return "a call's cost is unobserved";
	if (maintenance.compactions > 0 && (!maintenance.estimated || maintenance.costUsdLow === null || maintenance.costUsdHigh === null)) {
		return maintenance.reason ?? "maintenance cost is unobserved";
	}
	return null;
}

/**
 * Reserves one on-arm host's compressor allowance: the share of the uncommitted cap. Refuses, and releases the
 * reservation, when that allowance cannot cover a single compressor call.
 */
function reserveHostAllowance(context: Context, hostId: string, usdPerCall: number): number {
	const allowance = context.reservations.reserveHost(hostId, context.options.compressorShare);
	if (allowance === null) throw new BudgetStop("unknown-cost", "observed spend is unknown; no further live work");
	if (allowance < usdPerCall) {
		context.reservations.releaseHost(hostId, 0);
		throw new BudgetStop("cost-cap", "the remaining cap cannot cover one compressor call on this host");
	}
	return allowance;
}

/**
 * Worst case for one compaction call sent by `model`, from the measured prompt bytes and the compactor layout. The
 * extension charges each admitted attempt at its sending model's bound: the compressor, or the main model when OptChat
 * retries a refused compaction there with the same prompt and output cap.
 */
function hostUsdPerCall(context: Context, model: string): number {
	if (context.capUsd === null) return 0;
	const system = effectiveSystemBytes(context.systemBytes);
	if (system === null) throw new BudgetStop("unknown-cost", "effective prompt bytes are not measured");
	const bound = compressorCallBoundUsd(context.rates.get(model) ?? null, system, COMPACTOR_LAYOUT, context.limits.maxCompressorOutputTokens);
	if (bound === null) throw new BudgetStop("unknown-cost", `rate or context window for ${model} is unknown`);
	return bound;
}

/** Adds an observed USD amount to a running total; null on either side keeps the total unobserved. */
function addUsd(total: number | null, usd: number | null): number | null {
	return total === null || usd === null ? null : total + usd;
}

/**
 * Releases one reservation with its observed spend. An overspend is recorded as a violation and the release is retried
 * as unobserved, which makes the ledger unknown so every later admission refuses. It never throws mid-run.
 */
function releaseSafely(context: Context, id: string, observedUsd: number | null, release: (usd: number | null) => void): void {
	try {
		release(observedUsd);
	} catch (error) {
		context.violations.push(`${id}: ${safeMessage(error)}`);
		release(null);
	}
}

/** Settles one host's compressor allowance with its observed compressor spend; a null spend makes the ledger unknown. */
function releaseHostAllowance(context: Context, slot: HostSlot, observedUsd: number | null): void {
	const id = slot.reservationId;
	if (id === null) return;
	releaseSafely(context, id, observedUsd, (usd) => context.reservations.releaseHost(id, usd));
}

/**
 * Settles a child arm's prompt reservations in admission order: observed spend fills each reservation up to its bound.
 * Spend beyond every reservation is still observed and is recorded, with a violation, so the total stays exact.
 */
function releaseChildReservations(context: Context, reservations: readonly { readonly id: string; readonly bound: number }[], observedUsd: number | null): void {
	let remaining: number | null = observedUsd;
	for (const { id, bound } of reservations) {
		const share: number | null = remaining === null ? null : Math.min(remaining, bound);
		releaseSafely(context, id, share, (usd) => context.reservations.releasePrompt(id, usd));
		remaining = remaining === null || share === null ? null : remaining - share;
	}
	if (remaining === null) {
		context.reservations.recordSpend(null);
	} else if (remaining > 0) {
		if (reservations.length > 0) context.violations.push("child arm spend exceeds its reservations");
		context.reservations.recordSpend(remaining);
	}
}

/** Observed USD of a child arm: each task's parent spend plus its child spend; null when any part is unobserved. */
function childArmSpendUsd(outcomes: readonly ChildTaskOutcome[]): number | null {
	let total: number | null = 0;
	for (const outcome of outcomes) total = addUsd(total, addUsd(spendOf(outcome.parentUsage), childSpendUsd(outcome)));
	return total;
}

/** Observed USD of a set of records; null when any record's cost is unobserved. */
function spendOf(records: readonly UsageRecord[]): number | null {
	let total = 0;
	for (const record of records) {
		if (record.costUsd === null) return null;
		total += record.costUsd;
	}
	return total;
}

/** Starts one isolated host with a fresh metric sink and admission counter. An off-arm host resumes a fresh seeded session. */
async function openHost(context: Context, spec: HostSpec): Promise<HostSlot> {
	assertLive(context);
	const label = `${spec.label}-${++context.hostSeq}`;
	const dir = join(context.dirs.root, `host-${label}`);
	const session = join(dir, "session");
	await mkdir(session, { recursive: true, mode: 0o700 });
	await mkdir(spec.memory, { recursive: true, mode: 0o700 });
	const metrics = join(dir, "metrics.jsonl");
	const admission = join(dir, "admission.json");
	await initMetricsFile(metrics);
	await writeFile(admission, JSON.stringify(initialAdmission()), { flag: "wx", mode: 0o600 });
	const on = spec.arm === "on";
	const compressor = spec.compressor ?? context.options.compressor;
	const callAllowance = on ? callAllowanceFor(context, spec.kind, spec.share) : 0;
	const usdPerCall = on ? hostUsdPerCall(context, compressor) : 0;
	const usdPerFallbackCall = on ? hostUsdPerCall(context, spec.model) : 0;
	const extraArgs: string[] = [];
	let historyBytes = 0;
	if (!on) {
		const file = await writeSeededSession({ cwd: context.dirs.workspace, sessionDir: session, records: context.seedRecords });
		// The whole seeded history in UTF-8 bytes: the off arm's compaction admission prices all of it as input.
		historyBytes = (await stat(file)).size;
		extraArgs.push(`--resume=${file}`);
	}
	let usdAllowance = 0;
	let reservationId: string | null = null;
	if (on) {
		usdAllowance = UNBOUNDED_USD;
		if (context.capUsd !== null) {
			reservationId = `host-${label}`;
			usdAllowance = reserveHostAllowance(context, reservationId, usdPerCall);
		}
	}
	const host = new RpcHost(
		{
			omp: context.options.omp,
			plugin: PLUGIN_ENTRY,
			memory: spec.memory,
			sessionDir: session,
			cwd: context.dirs.workspace,
			main: spec.model,
			compressor,
			metricsFile: metrics,
			admissionFile: admission,
			allowance: callAllowance,
			usdAllowance,
			usdPerCall,
			usdPerFallbackCall,
			compressorMaxTokens: context.limits.maxCompressorOutputTokens,
			viewBytes: context.options.viewBytes,
			env: context.env,
			optchat: on,
			extraArgs,
			tools: null,
		},
		context.hostExtension,
	);
	context.hosts.add(host);
	return {
		host,
		arm: spec.arm,
		compressor: on ? compressor : null,
		model: spec.model,
		memory: spec.memory,
		metrics,
		admission,
		sessionDir: session,
		historyBytes,
		priorBytes: 0,
		compressorUsd: 0,
		reservationId,
		segments: [],
		phases: [],
		metricCursor: 0,
		chargedCursor: 0,
		auxCursor: 0,
		compactionCursor: 0,
	};
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
	const price = slot.compressor === null ? null : (context.prices.get(slot.compressor) ?? null);
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
	slot.compressorUsd = addUsd(slot.compressorUsd, spendOf(records));
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
	const start = slot.host.events.length;
	try {
		await slot.host.stop(SHUTDOWN_GRACE_MS);
	} finally {
		context.hosts.delete(slot.host);
	}
	try {
		await collectCompressor(context, slot);
	} catch (error) {
		releaseHostAllowance(context, slot, null);
		throw error;
	}
	releaseHostAllowance(context, slot, slot.compressorUsd);
	const last = slot.phases.at(-1);
	if (last) last.segmentEnd = slot.segments.length;
	// Shutdown events belong to no prompt, so they are charged once here. With no phase there is nothing to report them against.
	const side = await collectSideUsage(context, slot, slot.host.events.slice(start));
	if (last) {
		last.auxiliary.push(...side.auxiliary);
		last.maintenance = mergeMaintenance(last.maintenance, side.maintenance);
	} else if (side.auxiliary.length > 0 || side.maintenance.compactions > 0) {
		context.violations.push("side-session usage was observed outside any phase");
	}
}

async function withHost(context: Context, spec: HostSpec, body: (slot: HostSlot) => Promise<void>): Promise<void> {
	const slot = await openHost(context, spec);
	try {
		await body(slot);
	} finally {
		await closeHost(context, slot);
	}
}

/**
 * Admits one main prompt, runs it, records observed calls and spend, and keeps the observation even when the prompt
 * fails. Dollars are checked first from the model's worst-case bound; the call ledger is checked second.
 */
async function runPrompt(context: Context, slot: HostSlot, message: string): Promise<PromptOutcome> {
	if (context.aborted.signal.aborted) return { kind: "refused", reason: "deadline" };
	const bound = context.capUsd === null ? null : admissionBoundUsd(context, slot, message);
	if (context.capUsd !== null) {
		if (bound === null) return { kind: "refused", reason: "unknown-cost" };
		const decision = context.reservations.admitPrompt(bound);
		if (!decision.admitted) return { kind: "refused", reason: decision.reason };
	}
	const admission = admitPrompt(context.state, context.limits, Date.now(), DEFAULT_PROMPT_CALLS);
	context.state = admission.state;
	if (!admission.admitted) return { kind: "refused", reason: admission.reason };
	let promptId: string | null = null;
	if (bound !== null) {
		promptId = `prompt-${++context.reservationSeq}`;
		// The same synchronous ledger state just admitted this bound, so the reservation cannot be refused.
		if (!context.reservations.reservePrompt(promptId, bound).admitted) throw new Error("prompt reservation diverged from its admission");
	}
	const start = slot.host.events.length;
	const remaining = Math.max(1, context.deadlineAt - Date.now());
	let failure: string | null = null;
	try {
		await slot.host.prompt(message, Math.min(PROMPT_TIMEOUT_MS, remaining));
	} catch (error) {
		failure = safeMessage(error);
	}
	const events = slot.host.events.slice(start);
	const observation = observeTurn(events, context.prices.get(slot.model) ?? null);
	context.state = recordCalls(context.state, "main", observation.assistantMessages);
	const observedMain = spendOf(observation.usage);
	if (promptId === null) {
		context.reservations.recordSpend(observedMain);
	} else {
		const id = promptId;
		releaseSafely(context, id, observedMain, (usd) => context.reservations.releasePrompt(id, usd));
	}
	slot.priorBytes += Buffer.byteLength(message, "utf8") + Buffer.byteLength(observation.answer, "utf8") + observation.pages.reduce((sum, page) => sum + Buffer.byteLength(page.text, "utf8"), 0);
	const side = await collectSideUsage(context, slot, events);
	return { kind: "done", observation, failure, side };
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

/**
 * Scores the questions of one prompt from the strict answer set; a schema failure is an incorrect outcome, never
 * unavailable. The off arm grounds citations in the seeded history, the on arm in retrieved originals and the view.
 */
function judge(
	context: Context,
	arm: Arm,
	questions: readonly Question[],
	observation: TurnObservation,
	latencyMs: number,
	viewText: string,
): { reports: QuestionReport[]; judgements: Judgement[] } {
	const score = scoreAnswers({
		questions,
		raw: observation.answer,
		pages: observation.pages,
		knownIds: context.knownIds,
		viewText,
		arm,
		...(arm === "off" ? { seededRecords: context.seededRecords } : {}),
	});
	const zoomN = observation.zoomCalls.map((call) => call.n).filter((value): value is number => value !== null && value >= 1);
	const maxZoomN = zoomN.length > 0 ? Math.max(...zoomN) : null;
	const trimmed = observation.answer.trim();
	// Diagnostic only: the final text as the host returned it, bounded. Never scored from this preview.
	const preview = trimmed === "" ? null : trimmed.slice(0, ANSWER_PREVIEW_CHARS);
	const reports = questions.map((question) => {
		const judgement = score.judgements.find((entry) => entry.questionId === question.id);
		if (!judgement) return unavailableQuestion(question, "no judgement produced");
		const sourceIds = new Set(question.sources.map((source) => source.recordId));
		return {
			id: question.id,
			kind: question.kind,
			status: "judged" as const,
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
	return { reports, judgements: score.judgements.filter((judgement) => questions.some((question) => question.id === judgement.questionId)) };
}

/**
 * Waits until the host's memory is quiet: no compressor call in flight (admitted attempts equal the completed metric
 * lines) and the saved tree covers every durable record. OptChat refuses a prompt sent before its summaries settle,
 * so a prompt is only sent after this. Returns null once settled; on the bounded wait, returns the last observed state.
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
		const failures = compressorFailures(lines);
		const { refused } = await readAdmissionCounts(slot.admission);
		const observed = `durable=${durable} treeMain=${tree?.mainLength ?? "none"} treeCompactor=${tree?.compactorLength ?? "none"} metricLines=${lines?.length ?? "none"} dispatched=${dispatched}${refused > 0 ? ` admissionsRefused=${refused}` : ""}${failures ? ` compressorFailures=${failures}` : ""}`;
		if (Date.now() >= deadline) return observed;
		await pause(context, TREE_POLL_MS);
	}
}

/** Final-answer prompt for an arm. The on arm keeps the memory wording; the off arm never mentions memory tools. */
function promptFor(arm: Arm, questions: readonly Question[]): string {
	if (arm === "on") return batchPrompt(questions);
	const lines = questions.map((question, index) => `${index + 1}. [${question.id}] ${question.prompt}`);
	return [
		`${BATCH_MARKER} from the conversation history in this session. Quote the exact original text of the record that states each answer.`,
		...lines,
		answerInstruction(questions.map((question) => question.id)),
	].join("\n");
}

/** Records one prompt's outcome into the phase: usage, judgements or unavailable questions, and the phase error. */
function recordPrompt(context: Context, draft: PhaseDraft, arm: Arm, group: readonly Question[], outcome: PromptOutcome, latency: number, viewText: string): { refusal: RunRefusal | null; error: string | null } {
	if (outcome.kind === "refused") {
		const reason = `prompt refused by admission: ${outcome.reason}`;
		draft.questions.push(...group.map((question) => unavailableQuestion(question, reason)));
		return { refusal: outcome.reason, error: null };
	}
	draft.records.push(...outcome.observation.usage);
	draft.auxiliary.push(...outcome.side.auxiliary);
	draft.maintenance = mergeMaintenance(draft.maintenance, outcome.side.maintenance);
	const stopped = hostStopReason(outcome.observation);
	const error = outcome.failure !== null ? `prompt failed: ${outcome.failure}` : stopped !== null ? `prompt not completed: ${stopped}` : null;
	if (error !== null) {
		draft.questions.push(...group.map((question) => unavailableQuestion(question, error)));
		return { refusal: null, error: outcome.failure ?? stopped };
	}
	const judged = judge(context, arm, group, outcome.observation, latency, viewText);
	draft.questions.push(...judged.reports);
	draft.judgements.push(...judged.judgements);
	return { refusal: null, error: null };
}

/**
 * One answer group on a host: a batch prompt answers every selected question together; per-question mode sends one
 * prompt per question on the same host, each with its own latency and usage. The on arm waits for memory to settle first.
 */
async function answerGroup(context: Context, slot: HostSlot, name: string, questions: readonly Question[]): Promise<PhaseDraft> {
	const draft = newPhase(name, slot);
	if (slot.arm === "on") {
		const unsettled = await awaitSettled(context, slot, slot.memory);
		if (unsettled !== null) {
			const message = `memory did not settle within ${SETTLE_WAIT_MS} ms (${unsettled}); no prompt was sent`;
			draft.error = message;
			draft.questions.push(...questions.map((question) => unavailableQuestion(question, message)));
			await collectCompressor(context, slot);
			draft.segmentEnd = slot.segments.length;
			draft.tree = await treeReport(slot.memory);
			return draft;
		}
	}
	const perQuestion = context.options.turnMode === "per-question";
	const groups: Question[][] = perQuestion ? questions.map((question) => [question]) : [[...questions]];
	const pending = [...groups];
	let stopped = false;
	for (const group of pending) {
		if (stopped) {
			draft.questions.push(...group.map((question) => unavailableQuestion(question, `prompt refused by admission: ${draft.refusal ?? "earlier turn"}`)));
			continue;
		}
		const started = Date.now();
		const viewText = slot.arm === "on" ? await readViewText(slot.memory) : "";
		const outcome = await runPrompt(context, slot, promptFor(slot.arm, group));
		const latency = Date.now() - started;
		draft.latencies.push(latency);
		draft.latencyMs = perQuestion ? (draft.latencyMs ?? 0) + latency : latency;
		const before = draft.records.length;
		const recorded = recordPrompt(context, draft, slot.arm, group, outcome, latency, viewText);
		// OptChat refuses a turn by aborting it; failed compressor calls are the usual cause and are otherwise invisible here.
		let cause = "";
		if (recorded.error !== null && slot.arm === "on") {
			const failures = compressorFailures(await readMetricLines(slot.metrics));
			const { refused } = await readAdmissionCounts(slot.admission);
			cause = [refused > 0 ? `admissionsRefused=${refused}` : "", failures ? `compressorFailures=${failures}` : ""].filter(Boolean).join(" ");
		}
		const turnError = cause ? { ...recorded, error: `${recorded.error}; ${cause}` } : recorded;
		if (turnError.error !== null && draft.error === null) draft.error = turnError.error;
		if (turnError.refusal !== null) {
			draft.refusal = turnError.refusal;
			stopped = true;
		}
		if (perQuestion) {
			draft.turns.push({
				questionId: group[0]!.id,
				latencyMs: latency,
				refusal: turnError.refusal,
				error: turnError.error,
				records: draft.records.slice(before),
			});
		}
	}
	if (slot.arm === "on") {
		await collectCompressor(context, slot);
		draft.segmentEnd = slot.segments.length;
		draft.tree = await treeReport(slot.memory);
	} else {
		draft.segmentEnd = slot.segments.length;
	}
	return draft;
}

function turnPrompts(context: Context): number {
	return context.options.turnMode === "per-question" ? context.questions.length : 1;
}

/** Seeds memory through the supported /optchat import command, then waits for the tree to cover every record. */
async function seed(context: Context, unit: Unit): Promise<void> {
	const importFile = join(context.dirs.root, `import-${basename(unit.memory)}.jsonl`);
	const count = context.corpus.sources.length;
	const sources = [...context.corpus.sources].sort((a, b) => a.recordId - b.recordId);
	const lines = sources.map((source) => JSON.stringify({
		kind: source.kind === "work" ? "work" : "talk",
		text: source.text,
		date: context.dates.get(source.recordId),
		i: source.recordId,
		...(source.provenance.work ? { metadata: { work: source.provenance.work } } : {}),
	}));
	await writeFile(importFile, `${lines.join("\n")}\n`, { mode: 0o600 });
	await withHost(context, { label: "build", kind: "seed", arm: "on", compressor: unit.compressor, memory: unit.memory, model: context.options.main, prompts: 1, share: 1 }, async (slot) => {
		const draft = newPhase("build", slot);
		unit.build = draft;
		const outcome = await runPrompt(context, slot, `/optchat import ${importFile}`);
		if (outcome.kind === "refused") throw new Error(`seeding prompt refused by admission: ${outcome.reason}`);
		draft.records.push(...outcome.observation.usage);
		if (outcome.failure !== null) {
			draft.error = outcome.failure;
			throw new Error(`seeding prompt failed: ${outcome.failure}`);
		}
		const durable = await readDurableRecords(unit.memory);
		if (durable.length !== count) throw new Error(`seeding stored ${durable.length} of ${count} records; /optchat import over RPC is unverified`);
		draft.timestamps = { records: durable.length, matched: durable.filter((record) => context.dates.get(record.i) === record.date).length };
		const unsettled = await awaitSettled(context, slot, unit.memory);
		if (unsettled !== null) throw new Error(`seeding did not settle within ${SETTLE_WAIT_MS} ms (${unsettled})`);
		await collectCompressor(context, slot);
		draft.segmentEnd = slot.segments.length;
		draft.tree = await treeReport(unit.memory);
	});
}

/** Records one scenario's status from its phases: a failure outranks a refusal; otherwise it completed. */
function finishScenario(draft: ScenarioDraft): void {
	const failed = draft.phases.find((phase) => phase.error !== null);
	if (failed) {
		draft.status = "failed";
		draft.reason = failed.error;
	} else if (draft.phases.some((phase) => phase.refusal !== null)) {
		draft.status = "budget-stopped";
		draft.reason = "a prompt was refused by admission";
	} else {
		draft.status = "completed";
		draft.reason = null;
	}
}

async function runOnScenario(context: Context, unit: Unit, draft: ScenarioDraft): Promise<void> {
	const { options } = context;
	const compressor = unit.compressor;
	const questions = context.questions;
	const perHost = turnPrompts(context);
	const answers = (slot: HostSlot, name: string): Promise<PhaseDraft> => answerGroup(context, slot, name, questions).then((phase) => {
		draft.phases.push(phase);
		return phase;
	});
	const onHost = (label: string, prompts: number, model: string, share: number, body: (slot: HostSlot) => Promise<void>) =>
		withHost(context, { label, kind: "phase", arm: "on", compressor, memory: unit.memory, model, prompts, share }, body);
	switch (draft.name) {
		case "cold":
			await onHost("cold", perHost, options.main, 1, async (slot) => {
				await answers(slot, "cold-answers");
			});
			break;
		case "warm":
			await onHost("warm", 2 * perHost, options.main, 1, async (slot) => {
				await answers(slot, "warm-first");
				await answers(slot, "warm-second");
			});
			break;
		case "restart":
			await withHost(context, { label: "restart", kind: "restart", arm: "on", compressor, memory: unit.memory, model: options.main, prompts: perHost, share: 1 }, async (slot) => {
				await answers(slot, "restart-answers");
			});
			break;
		case "expiry": {
			const wait = options.limits.expiryWaitMs;
			if (wait === null) throw new Error("expiry scenario requires --expiry-wait-ms");
			await pause(context, wait);
			assertLive(context);
			await onHost("expiry", perHost, options.main, 1, async (slot) => {
				await answers(slot, "expired-answers");
			});
			break;
		}
		case "model-change": {
			const changed = options.modelChange;
			if (changed === null) throw new Error("model-change scenario requires --model-change");
			await onHost("model-change", perHost, changed, 1, async (slot) => {
				await answers(slot, "changed-model-answers");
			});
			break;
		}
		case "concurrent": {
			const copies = Array.from({ length: options.concurrency }, (_, index) => join(context.root, `memory-concurrent-${basename(unit.memory)}-${index}`));
			for (const copy of copies) await cp(unit.memory, copy, { recursive: true });
			const slots: HostSlot[] = [];
			try {
				for (const [index, copy] of copies.entries()) {
					slots.push(await openHost(context, { label: `concurrent-${index}`, kind: "phase", arm: "on", compressor, memory: copy, model: options.main, prompts: perHost, share: copies.length }));
				}
				await Promise.all(slots.map((slot, index) => answers(slot, `concurrent-answers-${index}`)));
			} finally {
				for (const slot of slots) await closeHost(context, slot);
			}
			break;
		}
		default:
			throw new Error(`scenario ${draft.name} is not an on-arm scenario`);
	}
	finishScenario(draft);
}

async function runOffScenario(context: Context, draft: ScenarioDraft, unit: Unit): Promise<void> {
	const groups = draft.name === "warm" ? 2 : 1;
	await withHost(context, { label: `off-${draft.name}`, kind: "phase", arm: "off", compressor: null, memory: unit.memory, model: context.options.main, prompts: groups * turnPrompts(context), share: 1 }, async (slot) => {
		for (let group = 0; group < groups; group++) {
			const name = draft.name === "warm" ? (group === 0 ? "warm-first" : "warm-second") : "cold-answers";
			draft.phases.push(await answerGroup(context, slot, name, context.questions));
		}
	});
	finishScenario(draft);
}

/** Runs one unit's requested scenarios. A build that cannot finish leaves its scenarios failed, never silently skipped. */
async function runUnit(context: Context, unit: Unit): Promise<void> {
	if (unit.arm === "on") {
		try {
			await seed(context, unit);
		} catch (error) {
			if (isDeadline(error)) throw error;
			unit.buildError = safeMessage(error);
			for (const draft of unit.scenarios) {
				if (draft.status === "not-run") continue;
				draft.status = error instanceof BudgetStop ? "budget-stopped" : "failed";
				draft.reason = error instanceof BudgetStop ? `build refused: ${error.message}` : `build did not complete: ${unit.buildError}`;
			}
			return;
		}
	}
	for (const draft of unit.scenarios) {
		if (draft.status === "not-run") continue;
		try {
			if (unit.arm === "on") await runOnScenario(context, unit, draft);
			else await runOffScenario(context, draft, unit);
		} catch (error) {
			if (isDeadline(error)) throw error;
			draft.status = error instanceof BudgetStop ? "budget-stopped" : "failed";
			draft.reason = safeMessage(error);
		}
	}
}

function scenarioDrafts(arm: Arm, compressor: string | null, requested: ReadonlySet<ScenarioName>): ScenarioDraft[] {
	return SCENARIOS.map((name): ScenarioDraft => {
		if (!requested.has(name)) return { name, arm, compressor, status: "not-run", reason: "not requested", phases: [] };
		if (arm === "off" && !OFF_SCENARIOS.includes(name)) {
			return { name, arm, compressor, status: "not-run", reason: "not applicable to the off arm: it has no memory state to restart, expire, share, or swap", phases: [] };
		}
		return { name, arm, compressor, status: "failed", reason: "not reached: build did not complete", phases: [] };
	});
}

/**
 * Child experiment: each arm runs the derived tasks on one parent host over a fresh copy of the settled default-compressor
 * memory. Each task reserves `CHILD_RESERVE_FACTOR` times one main prompt's worst case before it starts; the reserve is
 * replaced by observed spend when the arm ends, and the arm's pending reserves are counted against the cap meanwhile.
 * The child hosts' compressor allowance is zero: their memory is already settled.
 */
async function runChildExperiment(context: Context): Promise<ChildExperiment | null> {
	if (!context.options.experiments.includes("child")) return null;
	const compressor = context.options.compressors[0]!;
	const base = context.units.find((unit) => unit.arm === "on" && unit.compressor === compressor);
	if (base === undefined || base.build === null || base.buildError !== null) {
		return { status: "unavailable", reason: "no completed on-arm build for the default compressor", arms: { view: null, blind: null } };
	}
	const main = context.options.main;
	const questionBytes = Math.max(0, ...context.questions.map((question) => Buffer.byteLength(question.prompt, "utf8")));
	const bound = mainBoundUsd(context.rates.get(main) ?? null, context.systemBytes, context.options, "on", 0, 0, questionBytes);
	if (bound === null && context.capUsd !== null) {
		return { status: "unavailable", reason: "main model rate or context window is unknown; the child experiment cannot be admitted", arms: { view: null, blind: null } };
	}
	const reserve = bound === null ? 0 : CHILD_RESERVE_FACTOR * bound;
	const tasks = deriveChildTasks(context.corpus, DEFAULT_CHILD_TASKS);
	const arms: Record<"view" | "blind", ChildArmResult | null> = { view: null, blind: null };
	for (const arm of ["view", "blind"] as const) {
		context.fixture.childArm = arm;
		context.fixture.childTasks = tasks;
		const launch: ArmBase = {
			omp: context.options.omp,
			plugin: PLUGIN_ENTRY,
			cwd: context.dirs.workspace,
			main,
			compressor,
			allowance: 0,
			usdAllowance: 0,
			usdPerCall: 0,
			usdPerFallbackCall: 0,
			compressorMaxTokens: context.limits.maxCompressorOutputTokens,
			viewBytes: context.options.viewBytes,
			env: context.env,
		};
		const pending = { calls: 0 };
		const reservations: { readonly id: string; readonly bound: number }[] = [];
		const admit = (reserveUsd: number): string | null => {
			const admission = admitPrompt(recordCalls(context.state, "main", pending.calls), context.limits, Date.now(), DEFAULT_PROMPT_CALLS);
			if (!admission.admitted) return admission.reason;
			if (context.capUsd !== null) {
				const id = `child-${arm}-${++context.reservationSeq}`;
				const reserved = context.reservations.reservePrompt(id, reserveUsd);
				if (!reserved.admitted) return reserved.reason;
				reservations.push({ id, bound: reserveUsd });
			}
			pending.calls += DEFAULT_PROMPT_CALLS;
			return null;
		};
		const result = await runChildArm({
			arm,
			launch,
			extension: context.hostExtension,
			tasks,
			knownIds: context.knownIds,
			snapshot: base.memory,
			workRoot: join(context.root, `child-${arm}`),
			taskReserveUsd: reserve,
			admit,
			promptTimeoutMs: PROMPT_TIMEOUT_MS,
			price: context.prices.get(main) ?? null,
		});
		arms[arm] = result;
		releaseChildReservations(context, reservations, childArmSpendUsd(result.outcomes));
		for (const outcome of result.outcomes) settleChildOutcome(context, outcome);
	}
	return { status: "completed", reason: null, arms };
}

/** Observed child calls, added once an arm has ended. Spend settles separately against the arm's reservations. */
function settleChildOutcome(context: Context, outcome: ChildTaskOutcome): void {
	const childCalls = outcome.childUsage?.calls ?? null;
	if (outcome.childTaskIssued && childCalls === null) context.violations.push(`child task ${outcome.taskId} reported no observed child calls`);
	// Parent usage excludes the child's nested messages and the task result's usage, so no child cost is counted twice.
	context.state = recordCalls(context.state, "main", outcome.parentUsage.length + (childCalls ?? 0));
}

async function execute(context: Context): Promise<void> {
	for (const unit of context.units) await runUnit(context, unit);
	context.child = await runChildExperiment(context);
}

/** The arm's side of the pair: every phase of its unit, including the build, with summed counters and accuracy. */
function armSide(context: Context, unit: Unit): ArmSide {
	const phases = [...(unit.build ? [unit.build] : []), ...unit.scenarios.flatMap((scenario) => scenario.phases)];
	const main = summarizeUsage(phases.flatMap((phase) => phase.records));
	const compressor = unit.arm === "on" ? summarizeUsage(phases.flatMap((phase) => phase.slot.segments.slice(phase.segmentStart, phase.segmentEnd).flatMap((segment) => segment.records))) : null;
	const judgements = phases.flatMap((phase) => phase.judgements);
	const requested = unit.scenarios.filter((scenario) => scenario.status !== "not-run" || scenario.reason !== "not requested");
	const incomplete = context.options.scenarios.filter((name) => unit.scenarios.find((scenario) => scenario.name === name)?.status !== "completed");
	const complete = unit.buildError === null && incomplete.length === 0 && requested.length > 0;
	const reason = complete ? null : unit.buildError !== null ? `build did not complete: ${unit.buildError}` : `requested scenarios not completed: ${incomplete.join(", ")}`;
	const auxiliary = summarizeUsage(phases.flatMap((phase) => phase.auxiliary));
	const maintenance = maintenanceReport(phases.reduce<MaintenanceEstimate>((sum, phase) => mergeMaintenance(sum, phase.maintenance), NO_MAINTENANCE));
	// An absent compressor (the off arm) contributes an observed zero to totals and shares; it is not an unobserved role.
	const compressorOrZero = compressor ?? summarizeUsage([]);
	const totalCost = armTotalCost({ main, compressor: compressorOrZero, auxiliary, maintenance });
	const totalCostReason = totalCost === null ? unobservedTotalReason([main, compressorOrZero, auxiliary], maintenance) : null;
	const parts = [main, ...(compressor ? [compressor] : []), auxiliary];
	const totalPromptTokens = parts.reduce<number | null>((sum, part) => {
		if (sum === null || part.calls === 0) return sum === null ? null : sum;
		return part.promptTokens === null ? null : sum + part.promptTokens;
	}, 0);
	const latencies = phases.flatMap((phase) => phase.latencies);
	return {
		status: complete ? "completed" : "unavailable",
		reason,
		main,
		compressor,
		auxiliary,
		maintenance,
		totalCost,
		totalCostReason,
		totalPromptTokens,
		cacheReadShare: armCacheReadShare([main, compressorOrZero, auxiliary, maintenance]),
		cacheReadShareByRole: { main: roleCacheReadShare(main), compressor: roleCacheReadShare(compressor), auxiliary: roleCacheReadShare(auxiliary) },
		mainSteadyStateCacheReadShare: mainSteadyStateCacheReadShare(phases.flatMap((phase) => phase.turns.map((turn) => summarizeUsage(turn.records)))),
		latencyMsPerTurn: latencies,
		accuracy: judgements.length === 0 ? null : armTotals(judgements),
	};
}

function accuracyKey(unit: Unit): string {
	return unit.compressor === null ? unit.arm : `${unit.arm}:${unit.compressor}`;
}

function unitPhases(unit: Unit): PhaseDraft[] {
	return [...(unit.build ? [unit.build] : []), ...unit.scenarios.flatMap((scenario) => scenario.phases)];
}

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
	const arm = draft.slot.arm;
	const segments = draft.slot.segments.slice(draft.segmentStart, draft.segmentEnd);
	return {
		name: draft.name,
		arm,
		compressor: draft.slot.compressor,
		model: draft.slot.model,
		latencyMs: draft.latencyMs,
		error: draft.error,
		refusal: draft.refusal,
		usage: { main: summarizeUsage(draft.records), compressor: arm === "on" ? compressorReport(segments) : { status: "unavailable", reason: OFF_ARM_COMPRESSOR_REASON }, auxiliary: summarizeUsage(draft.auxiliary) },
		maintenance: maintenanceReport(draft.maintenance),
		turns: draft.turns.map((turn) => ({
			questionId: turn.questionId,
			latencyMs: turn.latencyMs,
			refusal: turn.refusal,
			error: turn.error,
			usage: summarizeUsage(turn.records),
		})),
		questions: draft.questions,
		tree: draft.tree,
		timestamps: draft.timestamps,
	};
}

function toScenario(draft: ScenarioDraft): ScenarioReport {
	return { name: draft.name, arm: draft.arm, compressor: draft.compressor, status: draft.status, reason: draft.reason, phases: draft.phases.map(toPhase) };
}

function accuracy(units: readonly Unit[]): Record<string, ArmTotals | null> {
	const out: Record<string, ArmTotals | null> = {};
	for (const unit of units) {
		const judgements = unitPhases(unit).flatMap((phase) => phase.judgements);
		out[accuracyKey(unit)] = judgements.length === 0 ? null : armTotals(judgements);
	}
	return out;
}

/** Effective-prompt preflight, run before any real host exists. A zero-allowance host reports its system prompt through `get_state`. */
async function effectivePromptPreflight(options: Options, dirs: IsolatedDirs, env: Readonly<Record<string, string>>, parentPaths: readonly string[], hostExtension: string): Promise<{ blockers: string[]; report: PromptPreflight | null }> {
	const dir = join(dirs.root, "preflight");
	const memory = join(dir, "memory");
	const session = join(dir, "session");
	await mkdir(memory, { recursive: true, mode: 0o700 });
	await mkdir(session, { recursive: true, mode: 0o700 });
	const metrics = join(dir, "metrics.jsonl");
	const admission = join(dir, "admission.json");
	await initMetricsFile(metrics);
	await writeFile(admission, JSON.stringify(initialAdmission()), { flag: "wx", mode: 0o600 });
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
			usdAllowance: 0,
			usdPerCall: 0,
			usdPerFallbackCall: 0,
			compressorMaxTokens: options.limits.maxCompressorOutputTokens,
			viewBytes: options.viewBytes,
			env,
			optchat: true,
			extraArgs: [],
			tools: null,
		}, hostExtension, PREFLIGHT_TIMEOUT_MS);
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
 * Auth, catalog, and effective-prompt prerequisites through public host surfaces only. Creates no provider request.
 * `discovery` names the extensions catalog and availability discovery may load (fixture mode only).
 */
async function prerequisites(options: Options, selectors: readonly string[], dirs: IsolatedDirs, env: Readonly<Record<string, string>>, copied: CopiedAuth, parentPaths: readonly string[], discovery: readonly string[], hostExtension: string, overrideBlockers: readonly string[]): Promise<Prerequisites> {
	const blockers = [...overrideBlockers];
	const catalog: Record<string, CatalogEntry> = {};
	for (const selector of selectors) catalog[selector] = await readCatalogEntry(options.omp, selector, env, dirs.workspace, discovery);
	const models = await queryAvailableModels(options.omp, env, dirs.sessions, dirs.workspace, 60_000, discovery);
	const available: Record<string, boolean> = {};
	for (const selector of selectors) {
		available[selector] = isAvailable(models, selector);
		if (!catalog[selector]!.found) blockers.push(`model is not in the local catalog: ${selector}`);
		if (!available[selector]) blockers.push(`no configured auth for ${selector} in the isolated host`);
	}
	if (options.mainContextWindow !== null && overrideBlockers.length === 0) {
		for (const selector of [options.main, ...(options.modelChange === null ? [] : [options.modelChange])]) {
			if (catalog[selector]?.contextWindow !== options.mainContextWindow) blockers.push(`isolated catalog did not apply --main-context-window ${options.mainContextWindow} for ${selector}`);
		}
	}
	const present = await stat(PLUGIN_ENTRY).then(() => true, () => false);
	if (!present) blockers.push("plugin entry src/index.ts is missing");
	const extensionPresent = await stat(hostExtension).then(() => true, () => false);
	if (!extensionPresent) blockers.push(`host extension ${basename(hostExtension)} is missing`);
	const prompt = blockers.length === 0 ? await effectivePromptPreflight(options, dirs, env, parentPaths, hostExtension) : null;
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

/* --------------------------------------------------------------------------------------------- *
 * Fixture mode: replies live in evidence/fixture-replies.ts; the corpus is the oracle and quotes are exact source text.
 * --------------------------------------------------------------------------------------------- */

function childArmSummary(result: ChildArmResult | null): ChildArmSummary | null {
	if (result === null) return null;
	const parentRecords = result.outcomes.flatMap((outcome) => outcome.parentUsage);
	const usages = result.outcomes.map((outcome) => outcome.childUsage).filter((usage): usage is ChildUsage => usage !== null);
	const callsObserved = parentRecords.length + usages.reduce((sum, usage) => sum + (usage.calls ?? 0), 0);
	return {
		tasks: result.outcomes,
		parentUsage: summarizeUsage(parentRecords),
		childUsage: usages.length === 0 ? null : {
			calls: usages.reduce<number | null>((sum, usage) => (sum === null || usage.calls === null ? null : sum + usage.calls), 0),
			input: usages.reduce<number | null>((sum, usage) => (sum === null || usage.input === null ? null : sum + usage.input), 0),
			output: usages.reduce<number | null>((sum, usage) => (sum === null || usage.output === null ? null : sum + usage.output), 0),
			cacheRead: usages.reduce<number | null>((sum, usage) => (sum === null || usage.cacheRead === null ? null : sum + usage.cacheRead), 0),
			cacheWrite: usages.reduce<number | null>((sum, usage) => (sum === null || usage.cacheWrite === null ? null : sum + usage.cacheWrite), 0),
			totalTokens: usages.reduce<number | null>((sum, usage) => (sum === null || usage.totalTokens === null ? null : sum + usage.totalTokens), 0),
			costUsd: usages.reduce<number | null>((sum, usage) => (sum === null || usage.costUsd === null ? null : sum + usage.costUsd), 0),
			costSource: usages.every((usage) => usage.costSource === "sdk-reported") ? "sdk-reported" : "unavailable",
			latencyMs: usages.reduce<number | null>((sum, usage) => (sum === null || usage.latencyMs === null ? null : sum + usage.latencyMs), 0),
			model: usages.find((usage) => usage.model !== null)?.model ?? null,
			aborted: usages.some((usage) => usage.aborted),
		},
		callsObserved,
	};
}

function childReport(experiment: ChildExperiment | null): ChildReport | null {
	if (experiment === null) return null;
	return {
		arms: { view: childArmSummary(experiment.arms.view), blind: childArmSummary(experiment.arms.blind) },
		reason: experiment.reason,
	};
}

/**
 * Dollar bounds printed before any call. The main bound is per call on the on arm, for the largest selected question and
 * no prior turns. The compressor bound is per call. The host allowance is the most one host can reserve: the share of the
 * whole cap. The off arm's compaction bound needs the seeded history's size, known only when a host opens, so it is added
 * at admission rather than printed.
 */
function budgetPlan(options: Options, questions: readonly Question[], rates: ReadonlyMap<string, ModelRates | null>, measuredSystemBytes: number | null) {
	const questionBytes = Math.max(0, ...questions.map((question) => Buffer.byteLength(question.prompt, "utf8")));
	const mains = [options.main, ...(options.modelChange === null ? [] : [options.modelChange])];
	const system = effectiveSystemBytes(measuredSystemBytes);
	return {
		capUsd: options.maxCostUsd,
		compressorShare: options.compressorShare,
		maxMainOutputTokens: options.maxMainOutputTokens,
		systemBytes: system,
		mainPromptUsd: Object.fromEntries(mains.map((model) => [model, mainBoundUsd(rates.get(model) ?? null, measuredSystemBytes, options, "on", 0, 0, questionBytes)])),
		compressorCallUsd: Object.fromEntries(options.compressors.map((compressor) => [compressor, system === null ? null : compressorCallBoundUsd(rates.get(compressor) ?? null, system, COMPACTOR_LAYOUT, options.limits.maxCompressorOutputTokens)])),
		// A refused compaction is retried once on the main model; that attempt is charged at this bound.
		fallbackCallUsd: system === null ? null : compressorCallBoundUsd(rates.get(options.main) ?? null, system, COMPACTOR_LAYOUT, options.limits.maxCompressorOutputTokens),
		hostAllowanceUsd: options.maxCostUsd === null ? null : options.maxCostUsd * options.compressorShare,
		basis: [
			"main prompt: tokens bounded by UTF-8 bytes (system, tools, view, prior turns, four zoom pages, question), clamped to the context window; output at the pinned cap; times the prompt's call bound",
			"off arm adds the native compaction bound over the seeded history, prior turns, and the question, at the pinned cap",
			"compressor call: system plus compactor view, batch input, and shorten step bytes; output at the compressor cap",
		],
	};
}

/**
 * Fixture-mode check of the pinned output cap: every request to a main model must carry `max_tokens` equal to the pin.
 * The fixture registers its models with the same cap, so a mismatch means the cap did not reach the request.
 */
function checkMainOutputCap(requests: readonly FixtureRequest[], options: Options, violations: string[]): void {
	const mains = new Set([options.main, options.modelChange].filter((selector): selector is string => selector !== null).map((selector) => selector.slice(providerOf(selector).length + 1)));
	for (const request of requests) {
		if (request.model === null || !mains.has(request.model)) continue;
		const sent: unknown = request.body?.max_tokens;
		if (sent !== options.maxMainOutputTokens) violations.push(`main request max_tokens ${JSON.stringify(sent ?? null)} differs from the pinned ${options.maxMainOutputTokens}`);
	}
}

async function run(options: Options, corpus: Corpus, questions: readonly Question[], root: string): Promise<void> {
	const fixture = options.fixtureProvider;
	const dirs = await createIsolatedDirs(root);
	assertWorkspaceBoundary(dirs);
	const selectors = [...new Set([options.main, ...options.compressors, ...(options.modelChange ? [options.modelChange] : [])])];
	const providers = [...new Set(selectors.map(providerOf))];
	const sourceAgentDir = options.agentDir ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".omp", "agent");
	// Before any credential is copied or any authenticated discovery: a re-routed provider is a blocker.
	const routing = await routingBlockers(sourceAgentDir, providers);
	if (routing.length > 0) {
		console.log(JSON.stringify({ status: "blocked", reason: "prerequisites not satisfied", blockers: routing }, null, 2));
		process.exitCode = 1;
		return;
	}
	const fixtureState: FixtureState = { childTasks: [], childArm: "view" };
	const fixtureServer: OfflineServer | null = fixture
		? await startOfflineServer({ reply: (request) => fixtureReply(corpus, fixtureState, request) })
		: null;
	try {
		const copied: CopiedAuth = fixture ? { copied: [], missing: [] } : await copySelectedAuth(sourceAgentDir, dirs.agentDir, providers);
		const parentPaths = [homedir(), sourceAgentDir, ROOT].filter((path) => path.length >= MIN_PARENT_PATH_LENGTH);
		const env: Record<string, string> = {
			...childEnvironment(process.env, dirs, fixture ? [] : options.allowEnv),
			OPTCHAT_EVIDENCE_PARENT_PATHS: JSON.stringify(parentPaths),
		};
		if (fixtureServer) {
			env.OPTCHAT_SMOKE_BASE_URL = fixtureServer.baseUrl;
			env.OPTCHAT_SMOKE_MAX_TOKENS = String(options.maxMainOutputTokens);
		}
		const hostExtension = fixture ? FIXTURE_EXTENSION : EXTENSION;
		const discovery = fixture ? [FIXTURE_PROVIDER] : [];
		const mains = [options.main, ...(options.modelChange === null ? [] : [options.modelChange])];
		const overrideBlockers: string[] = [];
		if (options.mainContextWindow !== null) {
			for (const selector of mains) {
				const original = await readCatalogEntry(options.omp, selector, env, dirs.workspace, discovery);
				const blocker = mainContextWindowBlocker(selector, options.mainContextWindow, original.contextWindow);
				if (blocker !== null) overrideBlockers.push(blocker);
			}
		}
		await writeMainModelOverrides(dirs, mains, options.maxMainOutputTokens, overrideBlockers.length === 0 ? options.mainContextWindow : null);
		const preflight = await prerequisites(options, selectors, dirs, env, copied, parentPaths, discovery, hostExtension, overrideBlockers);
		const prices = new Map<string, Price | null>();
		const rates = new Map<string, ModelRates | null>();
		for (const selector of selectors) {
			prices.set(selector, preflight.catalog[selector]?.price ?? null);
			rates.set(selector, ratesOf(preflight.catalog[selector]));
		}
		const budget = budgetPlan(options, questions, rates, preflight.prompt?.bytes ?? null);
		const plan = {
			schema: ARTIFACT_SCHEMA,
			providerMode: fixture ? "fixture" : "live",
			corpus: { version: corpus.version, seed: corpus.seed, digest: corpus.digest, sources: corpus.sources.length, minSourceBytes: corpus.minSourceBytes, questionsTotal: corpus.questions.length, questionsSelected: questions.length },
			limits: options.limits,
			scenarios: options.scenarios,
			arms: options.arms,
			compressors: options.compressors,
			turnMode: options.turnMode,
			mainContextWindow: options.mainContextWindow,
			prerequisites: preflight,
			budget,
		};
		if (!fixture && (!options.confirm || preflight.blockers.length > 0)) {
			console.log(JSON.stringify({
				status: preflight.blockers.length > 0 ? "blocked" : "not-run",
				reason: options.confirm ? "prerequisites not satisfied" : "pass --confirm-live-provider-calls and --max-cost-usd to make live provider calls",
				invocation: `bun run scripts/evidence-recall.ts --confirm-live-provider-calls --max-cost-usd <x> --main ${options.main} --compressor ${options.compressor}`,
				plan,
			}, null, 2));
			process.exitCode = preflight.blockers.length > 0 ? 1 : 0;
			return;
		}
		if (preflight.blockers.length > 0) {
			console.log(JSON.stringify({ status: "blocked", reason: "prerequisites not satisfied", blockers: preflight.blockers }, null, 2));
			process.exitCode = 1;
			return;
		}

		const sources = [...corpus.sources].sort((a, b) => a.recordId - b.recordId);
		const dates = new Map<number, string>(sources.map((source) => [source.recordId, new Date(Date.UTC(2026, 0, 1, 0, source.recordId)).toISOString()]));
		const seedRecords: SeedRecord[] = sources.map((source) => ({ text: source.text, timestampMs: Date.parse(dates.get(source.recordId)!) }));
		const seededRecords = new Map(sources.map((source) => [String(source.recordId), source.text]));
		const requested = new Set<ScenarioName>(options.scenarios);
		const units: Unit[] = [];
		if (options.arms.includes("on")) {
			for (const compressor of options.compressors) {
				units.push({ arm: "on", compressor, memory: join(root, `memory-on-${options.compressors.indexOf(compressor)}`), build: null, buildError: null, scenarios: scenarioDrafts("on", compressor, requested) });
			}
		}
		if (options.arms.includes("off")) {
			units.push({ arm: "off", compressor: null, memory: join(root, "memory-off"), build: null, buildError: null, scenarios: scenarioDrafts("off", null, requested) });
		}
		const context: Context = {
			options,
			dirs,
			root,
			fixture: fixtureState,
			env,
			hostExtension,
			corpus,
			questions,
			knownIds: new Set(corpus.knownIds),
			seedRecords,
			seededRecords,
			dates,
			prices,
			rates,
			limits: options.limits,
			capUsd: options.maxCostUsd,
			deadlineAt: Date.now() + options.limits.deadlineMs,
			aborted: new AbortController(),
			hosts: new Set(),
			violations: [],
			units,
			state: initialAccounting(Date.now()),
			reservations: new DollarReservations(options.maxCostUsd ?? UNBOUNDED_USD),
			systemBytes: preflight.prompt?.bytes ?? null,
			reservationSeq: 0,
			hostSeq: 0,
			child: null,
		};
		let error: string | null = null;
		let deadlineHit = false;
		const pipeline = execute(context);
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

		const scenarios = units.flatMap((unit) => unit.scenarios.map(toScenario));
		const builds = units.flatMap((unit) => (unit.build ? [toPhase(unit.build)] : []));
		const failedScenario = scenarios.some((entry) => entry.status === "failed");
		const refused = scenarios.some((entry) => entry.status === "budget-stopped" || entry.phases.some((phase) => phase.refusal !== null));
		let status: "completed" | "failed" | "budget-stopped" = "completed";
		if (deadlineHit || refused) status = "budget-stopped";
		if (failedScenario || (error !== null && !deadlineHit) || units.some((unit) => unit.buildError !== null && unit.buildError.startsWith("seeding"))) status = "failed";
		const onSides = new Map(units.filter((unit) => unit.arm === "on").map((unit) => [unit.compressor!, armSide(context, unit)]));
		const offUnit = units.find((unit) => unit.arm === "off");
		const offSide = offUnit ? armSide(context, offUnit) : null;
		const paired: PairedComparison[] = offSide === null
			? []
			: options.compressors.flatMap((compressor) => {
				const on = onSides.get(compressor);
				return on === undefined ? [] : [pairedComparison({ compressor, on, off: offSide })];
			});
		if (fixtureServer) checkMainOutputCap(fixtureServer.requests, options, context.violations);
		const violations = [
			...accountingViolations(context.state, options.limits),
			...context.violations,
			...(fixtureServer ? fixtureServer.violations.map((entry) => `fixture server refused: ${entry}`) : []),
			...(deadlineHit ? ["run deadline reached; work stopped and owned hosts ended"] : []),
		];
		const artifact = {
			schema: ARTIFACT_SCHEMA,
			generatedAt: new Date().toISOString(),
			status,
			error,
			synthetic: true,
			providerMode: plan.providerMode,
			host: preflight.host,
			plugin: preflight.plugin,
			corpus: { version: corpus.version, seed: corpus.seed, digest: corpus.digest, sources: corpus.sources.length, minSourceBytes: corpus.minSourceBytes, questionsTotal: corpus.questions.length, questionsSelected: questions.length },
			arms: options.arms,
			compressors: options.compressors,
			turnMode: options.turnMode,
			viewBytes: options.viewBytes,
			questionEmphasis: options.questionEmphasis,
			requestedExperiments: options.experiments,
			builds,
			models: { main: options.main, mainContextWindow: options.mainContextWindow, compressor: options.compressor, compressors: options.compressors, modelChange: options.modelChange, catalog: preflight.catalog },
			auth: { checkedBy: "host get_available_models", available: preflight.available, copiedProviders: preflight.copied.copied, missingProviders: preflight.copied.missing },
			limits: {
				...options.limits,
				enforcement: "prompt-admission",
				costEnforcement: options.maxCostUsd === null ? "none" : "dollar-admission",
				maxCostUsd: options.maxCostUsd,
				spentUsd: context.reservations.observedUsd,
				callsUsed: context.state.mainCalls + context.state.compressorCalls,
				violations,
			},
			scenarios,
			paired,
			experiments: { child: childReport(context.child) },
			accuracy: accuracy(units),
			limitations: LIMITATIONS,
		};
		const errors = validateArtifact(artifact);
		if (errors.length > 0) throw new Error(`artifact failed validation: ${errors.join("; ")}`);
		await writeFile(resolve(options.out), `${JSON.stringify(artifact, null, 2)}\n`, { mode: 0o600 });
		console.log(JSON.stringify({ status, out: options.out, callsUsed: artifact.limits.callsUsed, spentUsd: artifact.limits.spentUsd, accuracy: artifact.accuracy }, null, 2));
		if (status !== "completed") process.exitCode = 1;
	} finally {
		if (fixtureServer) await fixtureServer.close();
	}
}

async function main(): Promise<void> {
	const options = parseOptions(Bun.argv.slice(2));
	if (!options.force && (await stat(resolve(options.out)).then(() => true, () => false))) {
		throw new Error(`refusing to overwrite ${options.out}; pass --force`);
	}
	const corpus = buildCorpus({ seed: options.seed, projects: options.projects, sourceCount: options.sourceCount, minSourceBytes: options.minSourceBytes });
	const questions = selectQuestions(corpus.questions, options.questionLimit, options.questionEmphasis);
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
