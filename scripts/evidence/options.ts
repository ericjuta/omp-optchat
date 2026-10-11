import { factRecordCount, MAX_PROJECTS, MAX_SOURCE_BYTES, MAX_SOURCES, MIN_PROJECTS, MIN_SOURCE_BYTES, MIN_SOURCES, questionCount } from "./corpus.ts";
import { checkLimits, DEFAULT_MAX_CALLS, MAX_CALLS, MAX_COMPRESSOR_OUTPUT_TOKENS, MAX_DEADLINE_MS, MAX_EXPIRY_WAIT_MS, type Limits, type QuestionEmphasis } from "./plan.ts";

export const SCENARIOS = ["cold", "warm", "restart", "expiry", "concurrent", "model-change"] as const;
export type ScenarioName = (typeof SCENARIOS)[number];

export const ARMS = ["on", "off"] as const;
export type Arm = (typeof ARMS)[number];
export const TURN_MODES = ["batch", "per-question"] as const;
export type TurnMode = (typeof TURN_MODES)[number];
export const EXPERIMENTS = ["child"] as const;
export type Experiment = (typeof EXPERIMENTS)[number];

export const MAX_CONCURRENCY = 4;
/** Host view budget. The product default is 128000; the evidence default stays at the historical 4096. */
export const MIN_VIEW_BYTES = 4_096;
export const MAX_VIEW_BYTES = 128_000;
/** Ceiling for --max-cost-usd: a bound on the worst case a single run may reserve. */
export const MAX_COST_USD = 30;
const FIXTURE_PREFIX = "optchat-smoke/";
/** Defaults are self-consistent: 3 projects need 24 fact records, which fit 24 sources. */
export const DEFAULTS = Object.freeze({ projects: 3, sources: 24, minSourceBytes: 512, questions: 8, concurrency: 2, seed: 1 });

export interface Options {
	readonly confirm: boolean;
	readonly force: boolean;
	readonly omp: string;
	readonly main: string;
	readonly compressor: string;
	readonly modelChange: string | null;
	readonly agentDir: string | null;
	/** Explicit environment variable names copied into the child; no pattern matching. */
	readonly allowEnv: readonly string[];
	readonly scenarios: readonly ScenarioName[];
	readonly seed: number;
	readonly projects: number;
	readonly sourceCount: number;
	readonly minSourceBytes: number;
	readonly questionLimit: number;
	readonly concurrency: number;
	readonly out: string;
	readonly limits: Limits;
	readonly arms: readonly Arm[];
	/** Compressor selectors, one `on` arm each; the first is the default compressor. */
	readonly compressors: readonly string[];
	readonly turnMode: TurnMode;
	readonly viewBytes: number;
	readonly experiments: readonly Experiment[];
	readonly questionEmphasis: QuestionEmphasis;
	/** Worst-case dollar ceiling for live calls; required with --confirm-live-provider-calls, null otherwise. */
	readonly maxCostUsd: number | null;
	readonly fixtureProvider: boolean;
}

export const USAGE = `Usage: bun run scripts/evidence-recall.ts --main <provider/model> --compressor <provider/model> [options]
  --confirm-live-provider-calls   required to make any provider call (default: prerequisites only)
  --scenarios <list>              cold (default), warm, restart, expiry, concurrent, model-change
  --model-change <provider/model> alternate main model (required with the model-change scenario)
  --expiry-wait-ms <ms>           opt-in idle wait for the expiry scenario (<= ${MAX_EXPIRY_WAIT_MS})
  --max-calls <n>                 total provider call ceiling (<= ${MAX_CALLS})
  --max-compressor-output <n>     per compressor call output cap (<= ${MAX_COMPRESSOR_OUTPUT_TOKENS})
  --deadline-ms <ms>              total wall deadline for all work, including shutdown (<= ${MAX_DEADLINE_MS})
  --allow-env <NAME[,NAME...]>    explicit provider credential environment variables to pass to the host
  --seed <n> --projects <${MIN_PROJECTS}-${MAX_PROJECTS}> --sources <${MIN_SOURCES}-${MAX_SOURCES}> --min-source-bytes <${MIN_SOURCE_BYTES}-${MAX_SOURCE_BYTES}> --questions <n> --concurrency <n>
  --arms <on,off>                 OptChat arms to run (default on)
  --compressors <a/b[,c/d...]>    compressor selectors; the first must equal --compressor (default: --compressor)
  --turn-mode <batch|per-question>  final-answer turn shape (default batch)
  --view-bytes <n>                host view budget, ${MIN_VIEW_BYTES} to ${MAX_VIEW_BYTES} (default ${MIN_VIEW_BYTES})
  --experiments <child>           optional experiment arms (default none)
  --question-emphasis <balanced|adversarial>  question selection rotation (default balanced)
  --max-cost-usd <x>              worst-case dollar ceiling, above 0 and at most ${MAX_COST_USD}; required with confirm
  --fixture-provider              loopback optchat-smoke fixture models only; exclusive with confirm
  --omp <path> --agent-dir <path> --out <file> --force`;

const BOOLEAN_FLAGS = new Set(["confirm-live-provider-calls", "force", "fixture-provider"]);
const VALUE_FLAGS = new Set([
	"main", "compressor", "model-change", "agent-dir", "scenarios", "expiry-wait-ms", "max-calls", "max-compressor-output",
	"deadline-ms", "seed", "projects", "sources", "min-source-bytes", "questions", "concurrency", "omp", "out", "allow-env",
	"arms", "compressors", "turn-mode", "view-bytes", "experiments", "question-emphasis", "max-cost-usd",
]);
const SELECTOR = /^[A-Za-z0-9][\w.-]*\/\S+$/;
const DECIMAL = /^(?:\d+(?:\.\d+)?|\.\d+)$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;
/** Names the runner sets itself; an explicit allowance may never override isolation. */
const RESERVED_ENV = /^(?:HOME|PATH|TMPDIR|PI_|XDG_|OPTCHAT_|OMP_)/;

/**
 * Strict parse of the whole command line. Every failure throws before any directory, file, or
 * child process is created: unknown or duplicate flags, malformed values, and inconsistent corpus
 * parameters are all rejected here.
 */
export function parseOptions(argv: readonly string[]): Options {
	const values = new Map<string, string>();
	const flags = new Set<string>();
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index]!;
		if (!arg.startsWith("--")) throw new Error(`unexpected argument: ${arg}`);
		const name = arg.slice(2);
		if (BOOLEAN_FLAGS.has(name)) {
			if (flags.has(name)) throw new Error(`duplicate flag: ${arg}`);
			flags.add(name);
			continue;
		}
		if (!VALUE_FLAGS.has(name)) throw new Error(`unknown flag: ${arg}`);
		if (values.has(name)) throw new Error(`duplicate flag: ${arg}`);
		const value = argv[index + 1];
		if (value === undefined || value.startsWith("--")) throw new Error(`${arg} requires a value`);
		values.set(name, value);
		index++;
	}

	const integer = (name: string, fallback: number | null): number | null => {
		const raw = values.get(name);
		if (raw === undefined) return fallback;
		if (!/^\d+$/.test(raw)) throw new Error(`--${name} must be a non-negative integer`);
		return Number(raw);
	};
	const inRange = (name: string, value: number | null, min: number, max: number): number => {
		if (value === null || value < min || value > max) throw new Error(`--${name} must be an integer from ${min} to ${max}`);
		return value;
	};
	const selector = (name: string): string | null => {
		const raw = values.get(name);
		if (raw === undefined) return null;
		if (!SELECTOR.test(raw)) throw new Error(`--${name} must be provider/model: ${raw.slice(0, 80)}`);
		return raw;
	};
	const list = (name: string): string[] | null => {
		const raw = values.get(name);
		if (raw === undefined) return null;
		const items = raw.split(",").map((item) => item.trim());
		if (items.some((item) => item.length === 0)) throw new Error(`--${name} has an empty entry`);
		if (new Set(items).size !== items.length) throw new Error(`--${name} repeats an entry`);
		return items;
	};
	const choice = <T extends string>(name: string, allowed: readonly T[], fallback: T): T => {
		const raw = values.get(name);
		if (raw === undefined) return fallback;
		if (!(allowed as readonly string[]).includes(raw)) throw new Error(`--${name} must be one of ${allowed.join(", ")}`);
		return raw as T;
	};

	const main = selector("main");
	const compressor = selector("compressor");
	if (!main || !compressor) throw new Error("--main and --compressor are required");
	const modelChange = selector("model-change");
	const confirm = flags.has("confirm-live-provider-calls");
	const fixtureProvider = flags.has("fixture-provider");

	const arms = (list("arms") ?? ["on"]).map((entry): Arm => {
		if (entry !== "on" && entry !== "off") throw new Error(`--arms must name on and/or off: ${entry.slice(0, 40)}`);
		return entry;
	});
	const compressors = list("compressors") ?? [compressor];
	for (const entry of compressors) {
		if (!SELECTOR.test(entry)) throw new Error(`--compressors must be provider/model: ${entry.slice(0, 80)}`);
	}
	if (compressors[0] !== compressor) throw new Error("--compressors must begin with the --compressor selector");
	if (compressors.length > 1 && !arms.includes("on")) throw new Error("--compressors with more than one entry requires the on arm");
	const turnMode = choice("turn-mode", TURN_MODES, "batch");
	const questionEmphasis = choice("question-emphasis", ["balanced", "adversarial"] as const, "balanced");
	const experiments = (list("experiments") ?? []).map((entry): Experiment => {
		if (entry !== "child") throw new Error(`--experiments accepts only child: ${entry.slice(0, 40)}`);
		return entry;
	});

	const costRaw = values.get("max-cost-usd");
	let maxCostUsd: number | null = null;
	if (costRaw !== undefined) {
		if (!DECIMAL.test(costRaw)) throw new Error("--max-cost-usd must be a decimal number");
		maxCostUsd = Number(costRaw);
		if (!(maxCostUsd > 0 && maxCostUsd <= MAX_COST_USD)) throw new Error(`--max-cost-usd must be above 0 and at most ${MAX_COST_USD}`);
	}
	if (confirm && maxCostUsd === null) throw new Error("--max-cost-usd is required with --confirm-live-provider-calls");
	if (fixtureProvider && confirm) throw new Error("--fixture-provider and --confirm-live-provider-calls are mutually exclusive");
	if (fixtureProvider) {
		const selectors = [main, modelChange, ...compressors].filter((entry): entry is string => entry !== null);
		for (const entry of selectors) {
			if (!entry.startsWith(FIXTURE_PREFIX)) throw new Error(`--fixture-provider requires ${FIXTURE_PREFIX}<model> selectors: ${entry.slice(0, 80)}`);
		}
	}

	const scenarios: ScenarioName[] = [];
	for (const entry of (values.get("scenarios") ?? "cold").split(",").map((item) => item.trim())) {
		if (!(SCENARIOS as readonly string[]).includes(entry)) throw new Error(`unknown scenario: ${entry}`);
		if (!scenarios.includes(entry as ScenarioName)) scenarios.push(entry as ScenarioName);
	}

	const expiryRaw = integer("expiry-wait-ms", null);
	const limits: Limits = {
		maxCalls: integer("max-calls", DEFAULT_MAX_CALLS) as number,
		maxCompressorOutputTokens: integer("max-compressor-output", MAX_COMPRESSOR_OUTPUT_TOKENS) as number,
		deadlineMs: integer("deadline-ms", MAX_DEADLINE_MS) as number,
		expiryWaitMs: expiryRaw,
	};
	const limitErrors = checkLimits(limits);
	if (limitErrors.length > 0) throw new Error(limitErrors.join("; "));
	if (scenarios.includes("expiry") !== (expiryRaw !== null)) throw new Error("--expiry-wait-ms is required with the expiry scenario and rejected without it");
	if (scenarios.includes("model-change") !== (modelChange !== null)) throw new Error("--model-change is required with the model-change scenario and rejected without it");

	const seed = integer("seed", DEFAULTS.seed) as number;
	const projects = inRange("projects", integer("projects", DEFAULTS.projects), MIN_PROJECTS, MAX_PROJECTS);
	const sourceCount = inRange("sources", integer("sources", DEFAULTS.sources), MIN_SOURCES, MAX_SOURCES);
	const minSourceBytes = inRange("min-source-bytes", integer("min-source-bytes", DEFAULTS.minSourceBytes), MIN_SOURCE_BYTES, MAX_SOURCE_BYTES);
	const questionLimit = inRange("questions", integer("questions", DEFAULTS.questions), 1, questionCount(projects));
	const viewBytes = inRange("view-bytes", integer("view-bytes", MIN_VIEW_BYTES), MIN_VIEW_BYTES, MAX_VIEW_BYTES);
	const concurrency = inRange("concurrency", integer("concurrency", DEFAULTS.concurrency), 1, MAX_CONCURRENCY);
	if (!Number.isSafeInteger(seed)) throw new Error("--seed must be a safe integer");
	const needed = factRecordCount(projects);
	if (needed > sourceCount) throw new Error(`--projects ${projects} needs ${needed} fact records; --sources must be at least ${needed}`);

	const allowEnv: string[] = [];
	for (const name of (values.get("allow-env") ?? "").split(",").map((item) => item.trim()).filter(Boolean)) {
		if (!ENV_NAME.test(name) || RESERVED_ENV.test(name)) throw new Error(`--allow-env rejects ${name.slice(0, 40)}: not an explicit provider variable`);
		if (!allowEnv.includes(name)) allowEnv.push(name);
	}

	const out = values.get("out") ?? `evidence-recall-seed${seed}.json`;
	if (out.trim().length === 0) throw new Error("--out must name a file");
	return {
		confirm: flags.has("confirm-live-provider-calls"),
		force: flags.has("force"),
		omp: values.get("omp") ?? "omp",
		main,
		compressor,
		modelChange,
		agentDir: values.get("agent-dir") ?? null,
		allowEnv,
		scenarios,
		seed,
		projects,
		sourceCount,
		minSourceBytes,
		questionLimit,
		concurrency,
		out,
		limits,
		arms,
		compressors,
		turnMode,
		viewBytes,
		experiments,
		questionEmphasis,
		maxCostUsd,
		fixtureProvider,
	};
}
