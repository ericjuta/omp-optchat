import { CODENAMES, factRecordCount, MAX_SOURCE_BYTES, MAX_SOURCES, MIN_SOURCE_BYTES, MIN_SOURCES } from "./corpus.ts";
import { checkLimits, DEFAULT_MAX_CALLS, MAX_CALLS, MAX_COMPRESSOR_OUTPUT_TOKENS, MAX_DEADLINE_MS, MAX_EXPIRY_WAIT_MS, type Limits } from "./plan.ts";

export const SCENARIOS = ["cold", "warm", "restart", "expiry", "concurrent", "model-change"] as const;
export type ScenarioName = (typeof SCENARIOS)[number];

export const MAX_CONCURRENCY = 4;
const MIN_PROJECTS = 2;
/** Defaults are self-consistent: 3 projects need 19 fact records, which fit 24 sources. */
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
  --seed <n> --projects <n> --sources <${MIN_SOURCES}-${MAX_SOURCES}> --min-source-bytes <n> --questions <n> --concurrency <n>
  --omp <path> --agent-dir <path> --out <file> --force`;

const BOOLEAN_FLAGS = new Set(["confirm-live-provider-calls", "force"]);
const VALUE_FLAGS = new Set([
	"main", "compressor", "model-change", "agent-dir", "scenarios", "expiry-wait-ms", "max-calls", "max-compressor-output",
	"deadline-ms", "seed", "projects", "sources", "min-source-bytes", "questions", "concurrency", "omp", "out", "allow-env",
]);
const SELECTOR = /^[A-Za-z0-9][\w.-]*\/\S+$/;
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

	const main = selector("main");
	const compressor = selector("compressor");
	if (!main || !compressor) throw new Error("--main and --compressor are required");
	const modelChange = selector("model-change");

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
	const projects = inRange("projects", integer("projects", DEFAULTS.projects), MIN_PROJECTS, CODENAMES.length);
	const sourceCount = inRange("sources", integer("sources", DEFAULTS.sources), MIN_SOURCES, MAX_SOURCES);
	const minSourceBytes = inRange("min-source-bytes", integer("min-source-bytes", DEFAULTS.minSourceBytes), MIN_SOURCE_BYTES, MAX_SOURCE_BYTES);
	const questionLimit = inRange("questions", integer("questions", DEFAULTS.questions), 1, 64);
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
	};
}
