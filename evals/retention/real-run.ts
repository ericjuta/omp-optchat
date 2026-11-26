#!/usr/bin/env bun
/**
 * Real-chat view-size check: the same frozen questions answered by a real OMP host over a copy of a frozen
 * OptChat store, once per view budget, with the prefetch and recall gates on as in production.
 *
 *   bun evals/retention/real-run.ts --manifest <private manifest> --out <private dir> --max-cost-usd <n> --fixture
 *   bun evals/retention/real-run.ts --manifest <private manifest> --out <private dir> --max-cost-usd <n> --confirm-live-provider-calls
 *
 * Options: --views 128000,64000  --reps 2  --main <provider/id>  --compressor <provider/id>  --only <case-id regex>
 *          --sources <id,...>  --limit <n cases>  --omp <path>  --allow-env <NAME,...>
 *          --probe <question> (one question outside the frozen set per source, a mechanics check)
 *
 * Every trial copies its frozen store, so the frozen snapshot is never opened by a host. Each trial is one fresh
 * host and one question. The out dir holds private chat text: keep it out of git. A rerun with the same out dir
 * skips finished trials and still counts their spend.
 *
 * Budget: a trial starts only if its whole reserve fits under the cap. Main-model and compressor spend are the
 * host's reported costs; an unknown cost stops the run. Judge spend cannot be observed, so each host has a judge
 * call allowance and every dispatched judge call is charged a fixed allocation. The cap is local admission, not a
 * provider limit.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCorpus, type RealCase } from "../evidence/real-input.ts";
import { secretFlags } from "../evidence/real-privacy.ts";
import { loadFrozenSnapshot } from "../evidence/real-snapshot.ts";
import { initialAdmission } from "../../scripts/evidence/admission.ts";
import { hostVersion, isAvailable, pluginRevision, providerOf, readCatalogEntry } from "../../scripts/evidence/discovery.ts";
import { initMetricsFile, observeTurn, queryAvailableModels, readAdmissionCounts, readMetricLines, RpcHost } from "../../scripts/evidence/host.ts";
import { assertWorkspaceBoundary, childEnvironment, copySelectedAuth, createIsolatedDirs, writeMainModelOverrides } from "../../scripts/evidence/isolation.ts";
import { initialJudgeCap, parseJudgeCap } from "../../scripts/evidence/judge-cap.ts";
import { startOfflineServer } from "../../scripts/evidence/offline-server.ts";
import { routingBlockers } from "../../scripts/evidence/routing.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const EXTENSION = join(ROOT, "scripts", "evidence-extension.ts");
const FIXTURE_EXTENSION = join(ROOT, "scripts", "evidence-fixture-extension.ts");
const FIXTURE_PROVIDER = join(ROOT, "scripts", "fixture-provider.ts");
const PLUGIN_ENTRY = join(ROOT, "src", "index.ts");

/** Gates left on, as in production: prefetch, recall, decisions and work discovery. These opt-outs are the rest. */
export const REAL_OPT_OUTS = ["--no-optchat-rules", "--no-optchat-value-score", "--no-optchat-extract", "--no-optchat-child-pack"] as const;
const MAIN_OUTPUT_TOKENS = 2048;
const COMPRESSOR_OUTPUT_TOKENS = 512;
const PROMPT_TIMEOUT_MS = 240_000;
const DRAIN_MS = 20_000;
/** Compressor calls one host may send; a single question needs a handful of leaves. */
const COMPRESSOR_CALLS = 40;
/** Worst case charged per compressor admission, and per main-model refusal fallback (amendment 1 of the synthetic run). */
const USD_PER_COMPRESSOR_CALL = 0.09;
const USD_PER_FALLBACK_CALL = 0.26;
/** Host compressor reserve: eight in-flight calls at the fallback worst case, with room. */
const COMPRESSOR_RESERVE_USD = 2.2;
/** Reserve for one trial's main-model calls. A trial that reports more stops the run. */
const MAIN_RESERVE_USD = 0.75;
/** Judge calls one host may send, and the dollars charged against the cap for each one sent. */
const JUDGE_CALLS = 60;
const JUDGE_ALLOCATION_USD = 0.01;
const TRIAL_RESERVE_USD = MAIN_RESERVE_USD + COMPRESSOR_RESERVE_USD + JUDGE_CALLS * JUDGE_ALLOCATION_USD;
const ANSWER_CHARS = 16_384;

const INSTRUCTION = [
	"Answer the question below from this chat's history. Use the memory tools to open original messages when the view is not enough.",
	"Reply in at most three sentences. Then list the message ids you relied on, each with one short exact quote from that message.",
	"If the history does not contain the answer, reply exactly: not stated in this chat.",
].join("\n");

interface Options {
	manifest: string;
	out: string;
	capUsd: number;
	views: number[];
	reps: number;
	main: string;
	compressor: string;
	only: RegExp | null;
	sources: string[] | null;
	limit: number | null;
	omp: string;
	allowEnv: string[];
	fixture: boolean;
	probe: string | null;
}

export interface TrialRow {
	readonly schemaVersion: 1;
	readonly key: string;
	readonly caseId: string;
	readonly sourceId: string;
	readonly split: string;
	readonly category: string;
	readonly repetition: number;
	readonly viewBytes: number;
	readonly status: "ok" | "failed";
	readonly failure: string | null;
	readonly answer: string;
	readonly tools: readonly string[];
	readonly latencyMs: number;
	readonly main: { calls: number; input: number | null; output: number | null; cacheRead: number | null; cacheWrite: number | null; costUsd: number | null };
	readonly compressor: { dispatched: number; completed: number; costUsd: number | null };
	readonly judge: { dispatched: number; refused: number; returned: number; allocatedUsd: number; diagnosticUsd: number | null; models: string[] };
	/** Dollars this trial holds against the cap: reported main and compressor cost, unfinished compressor calls at worst case, and the judge allocation. */
	readonly chargedUsd: number | null;
	readonly view: { parts: number; bytes: number } | null;
}

function parse(argv: readonly string[]): Options {
	const values = new Map<string, string>();
	const flags = new Set<string>();
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (!arg.startsWith("--")) throw new Error(`unexpected argument ${arg}`);
		const name = arg.slice(2);
		if (name === "fixture" || name === "confirm-live-provider-calls") flags.add(name);
		else {
			const value = argv[++i];
			if (value === undefined) throw new Error(`--${name} needs a value`);
			values.set(name, value);
		}
	}
	const known = ["manifest", "out", "max-cost-usd", "views", "reps", "main", "compressor", "only", "sources", "limit", "omp", "allow-env", "probe"];
	for (const name of values.keys()) if (!known.includes(name)) throw new Error(`unknown option --${name}`);
	const need = (name: string): string => {
		const value = values.get(name);
		if (!value) throw new Error(`--${name} is required`);
		return value;
	};
	const fixture = flags.has("fixture");
	if (fixture === flags.has("confirm-live-provider-calls")) throw new Error("pass exactly one of --fixture or --confirm-live-provider-calls");
	const capUsd = Number(need("max-cost-usd"));
	if (!Number.isFinite(capUsd) || capUsd <= 0) throw new Error("--max-cost-usd must be a positive number");
	const views = (values.get("views") ?? "128000,64000").split(",").map(Number);
	if (views.length < 1 || views.some((bytes) => !Number.isSafeInteger(bytes) || bytes < 4096 || bytes > 128_000) || new Set(views).size !== views.length) {
		throw new Error("--views must be distinct integers from 4096 to 128000");
	}
	const reps = Number(values.get("reps") ?? "2");
	if (!Number.isSafeInteger(reps) || reps < 1 || reps > 4) throw new Error("--reps must be from 1 to 4");
	const limit = values.has("limit") ? Number(values.get("limit")) : null;
	if (limit !== null && (!Number.isSafeInteger(limit) || limit < 1)) throw new Error("--limit must be a positive integer");
	return {
		manifest: resolve(need("manifest")),
		out: resolve(need("out")),
		capUsd,
		views,
		reps,
		main: values.get("main") ?? (fixture ? "optchat-smoke/optchat-smoke-chat" : "anthropic/claude-sonnet-5-5"),
		compressor: values.get("compressor") ?? (fixture ? "optchat-smoke/optchat-smoke-compact" : "anthropic/claude-haiku-5-5"),
		only: values.has("only") ? new RegExp(values.get("only")!) : null,
		sources: values.has("sources") ? values.get("sources")!.split(",") : null,
		limit,
		omp: values.get("omp") ?? "omp",
		allowEnv: (values.get("allow-env") ?? "").split(",").map((name) => name.trim()).filter(Boolean),
		fixture,
		probe: values.get("probe") ?? null,
	};
}

/** The operator's judge role, read from their settings: the role picks the model, never an environment variable. */
function judgeRole(agentDir: string): string | null {
	const file = join(agentDir, "config.yml");
	if (!existsSync(file)) return null;
	const parsed = Bun.YAML.parse(readFileSync(file, "utf8")) as { modelRoles?: { judge?: unknown } } | null;
	const role = parsed?.modelRoles?.judge;
	return typeof role === "string" && role.includes("/") ? role : null;
}

function viewOf(memory: string): { parts: number; bytes: number } | null {
	try {
		const saved = JSON.parse(readFileSync(join(memory, "view.json"), "utf8")) as { parts: [number, number][] };
		const sizes = new Map<string, number>();
		for (const file of readdirSync(join(memory, "tree"))) {
			for (const line of readFileSync(join(memory, "tree", file), "utf8").split("\n")) {
				if (!line) continue;
				const node = JSON.parse(line) as { l: number; i: number; text: string };
				sizes.set(`${node.l}:${node.i}`, Buffer.byteLength(node.text));
			}
		}
		return { parts: saved.parts.length, bytes: saved.parts.reduce((sum, [l, i]) => sum + (sizes.get(`${l}:${i}`) ?? 0), 0) };
	} catch {
		return null;
	}
}

function sum(values: readonly (number | null)[]): number | null {
	let total = 0;
	for (const value of values) {
		if (value === null) return null;
		total += value;
	}
	return total;
}

async function main(): Promise<void> {
	const options = parse(process.argv.slice(2));
	const corpus = loadCorpus(options.manifest);
	if (!corpus.labelsReviewed) throw new Error("the frozen cases have no approved source-label review");
	const snapshots = new Map(corpus.snapshots.map((input) => [input.id, loadFrozenSnapshot(input)]));
	corpus.validateCitations(snapshots);
	const flagged = [...snapshots.values()].filter((snapshot) => snapshot.privacyFlags.length > 0).map((snapshot) => snapshot.input.id);
	if (flagged.length > 0 || corpus.cases.some((item) => secretFlags(item.question).length > 0)) {
		throw new Error(`credential-format review flags block the run (sources: ${flagged.join(", ") || "none"}); nothing is redacted`);
	}

	let cases: RealCase[] = corpus.cases.filter((item) => options.only === null || options.only.test(item.id));
	if (options.probe !== null) {
		// One question outside the frozen set per source: a mechanics check that reveals no case to the model.
		cases = corpus.snapshots.map((snapshot) => ({ id: `probe-${snapshot.id}`, snapshotId: snapshot.id, question: options.probe!, category: "probe", split: "calibration" as const }));
	}
	if (options.sources !== null) {
		const unknown = options.sources.filter((id) => !snapshots.has(id));
		if (unknown.length > 0) throw new Error(`--sources names no frozen source: ${unknown.join(", ")}`);
		cases = cases.filter((item) => options.sources!.includes(item.snapshotId));
	}
	if (options.limit !== null) cases = cases.slice(0, options.limit);
	cases.sort((a, b) => a.snapshotId.localeCompare(b.snapshotId) || a.id.localeCompare(b.id));

	mkdirSync(options.out, { recursive: true, mode: 0o700 });
	const resultsFile = join(options.out, "results.jsonl");
	const done = new Map<string, TrialRow>();
	if (existsSync(resultsFile)) {
		for (const line of readFileSync(resultsFile, "utf8").split("\n")) if (line) { const row = JSON.parse(line) as TrialRow; done.set(row.key, row); }
	}
	const runRoot = join(options.out, `run-${Date.now()}`);
	const dirs = await createIsolatedDirs(runRoot);
	assertWorkspaceBoundary(dirs);
	const sourceAgentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".omp", "agent");
	const judge = options.fixture ? null : judgeRole(sourceAgentDir);
	if (!options.fixture && judge === null) throw new Error("the operator's settings name no judge role; the prefetch and recall gates could not run");
	const selectors = [options.main, options.compressor, ...(judge === null ? [] : [judge])];
	const providers = [...new Set(selectors.map(providerOf))];
	const blockers: string[] = options.fixture ? [] : await routingBlockers(sourceAgentDir, providers);
	const copied = options.fixture || blockers.length > 0 ? { copied: [], missing: [] } : await copySelectedAuth(sourceAgentDir, dirs.agentDir, providers);
	const server = options.fixture ? await startOfflineServer({ reply: () => ({ text: "not stated in this chat." }) }) : null;
	const hosts = new Set<RpcHost>();
	let stopReason: string | null = null;
	try {
		const env: Record<string, string> = {
			...childEnvironment(process.env, dirs, options.fixture ? [] : options.allowEnv),
			OPTCHAT_EVIDENCE_PARENT_PATHS: JSON.stringify([homedir(), sourceAgentDir, ROOT]),
		};
		if (server) {
			env.OPTCHAT_SMOKE_BASE_URL = server.baseUrl;
			env.OPTCHAT_SMOKE_MAX_TOKENS = String(MAIN_OUTPUT_TOKENS);
		}
		const extension = options.fixture ? FIXTURE_EXTENSION : EXTENSION;
		const discovery = options.fixture ? [FIXTURE_PROVIDER] : [];
		await writeMainModelOverrides(dirs, [options.main], MAIN_OUTPUT_TOKENS, null);
		if (judge !== null) writeFileSync(join(dirs.agentDir, "config.yml"), `${JSON.stringify({ modelRoles: { judge } })}\n`, { flag: "wx", mode: 0o600 });
		const entry = await readCatalogEntry(options.omp, options.main, env, dirs.workspace, discovery);
		if (!options.fixture) {
			if (entry.price === null) blockers.push(`no catalog price for ${options.main}: main-model spend would be unknown`);
			const available = await queryAvailableModels(options.omp, env, join(dirs.sessions, "discovery"), dirs.workspace, 60_000, discovery).catch((error: unknown) => {
				blockers.push(`model discovery failed: ${error instanceof Error ? error.message.slice(0, 200) : "unknown"}`);
				return [];
			});
			// The host lists chat models only; a judge model is not among them, so the judge is checked by its credential here and by its answers in the first trial.
			for (const selector of [options.main, options.compressor]) if (!isAvailable(available, selector)) blockers.push(`${selector} is not available in the isolated host (stored credential missing for: ${copied.missing.join(", ") || "none"})`);
			if (judge !== null && !copied.copied.includes(providerOf(judge))) blockers.push(`no stored credential for the judge role's provider ${providerOf(judge)}`);
		}
		const provenance = {
			host: await hostVersion(options.omp, env, dirs.workspace),
			plugin: await pluginRevision(ROOT),
			manifestSha256: corpus.manifestSha256,
			main: options.main,
			compressor: options.compressor,
			judge,
			views: options.views,
			reps: options.reps,
			optOuts: REAL_OPT_OUTS,
			instruction: INSTRUCTION,
			limits: { capUsd: options.capUsd, trialReserveUsd: TRIAL_RESERVE_USD, judgeCalls: JUDGE_CALLS, judgeAllocationUsd: JUDGE_ALLOCATION_USD, compressorCalls: COMPRESSOR_CALLS, mainOutputTokens: MAIN_OUTPUT_TOKENS },
			providerMode: options.fixture ? "fixture" : "live",
		};
		writeFileSync(join(runRoot, "provenance.json"), JSON.stringify(provenance, null, 2), { mode: 0o600 });
		if (blockers.length > 0) {
			console.log(JSON.stringify({ status: "blocked", blockers }, null, 2));
			process.exitCode = 1;
			return;
		}

		let charged: number | null = sum([...done.values()].map((row) => row.chargedUsd));
		let seq = 0;
		const trial = async (item: RealCase, repetition: number, viewBytes: number): Promise<TrialRow> => {
			const key = `${item.id}|${repetition}|${viewBytes}`;
			const dir = join(runRoot, `trial-${++seq}`);
			const memory = join(dir, "memory");
			const session = join(dir, "session");
			mkdirSync(session, { recursive: true, mode: 0o700 });
			cpSync(snapshots.get(item.snapshotId)!.input.root, memory, { recursive: true });
			const metrics = join(dir, "metrics.jsonl");
			const admission = join(dir, "admission.json");
			const judgeFile = join(dir, "judge.json");
			await initMetricsFile(metrics);
			writeFileSync(admission, JSON.stringify(initialAdmission()), { flag: "wx", mode: 0o600 });
			writeFileSync(judgeFile, JSON.stringify(initialJudgeCap()), { flag: "wx", mode: 0o600 });
			const host = new RpcHost({
				omp: options.omp, plugin: PLUGIN_ENTRY, memory, sessionDir: session, cwd: dirs.workspace,
				main: options.main, compressor: options.compressor, metricsFile: metrics, admissionFile: admission,
				allowance: COMPRESSOR_CALLS, usdAllowance: COMPRESSOR_RESERVE_USD, usdPerCall: USD_PER_COMPRESSOR_CALL,
				usdPerFallbackCall: USD_PER_FALLBACK_CALL, compressorMaxTokens: COMPRESSOR_OUTPUT_TOKENS, viewBytes,
				env: { ...env, OPTCHAT_EVIDENCE_JUDGE_FILE: judgeFile, OPTCHAT_EVIDENCE_JUDGE_ALLOWANCE: String(JUDGE_CALLS) },
				optchat: true, extraArgs: [], tools: null, optOuts: REAL_OPT_OUTS,
			}, extension);
			hosts.add(host);
			const started = Date.now();
			let failure: string | null = null;
			try {
				await host.prompt(`${INSTRUCTION}\n\nQuestion: ${item.question}`, PROMPT_TIMEOUT_MS);
			} catch (error) {
				// Host errors can quote provider detail; keep only a bounded message.
				failure = (error instanceof Error ? error.message : String(error)).slice(0, 200);
			}
			const latencyMs = Date.now() - started;
			// Compressor calls still in flight would be billed after a stop: let them finish, within a bound.
			const deadline = Date.now() + DRAIN_MS;
			let counts = await readAdmissionCounts(admission);
			let lines = (await readMetricLines(metrics)) ?? [];
			while (lines.length < counts.dispatched && Date.now() < deadline) {
				await Bun.sleep(500);
				counts = await readAdmissionCounts(admission);
				lines = (await readMetricLines(metrics)) ?? [];
			}
			const view = viewOf(memory);
			await host.stop();
			hosts.delete(host);
			const observation = observeTurn(host.events, options.fixture ? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } : entry.price);
			if (failure === null && (observation.stopReason === "error" || observation.stopReason === "aborted")) failure = `turn ended ${observation.stopReason}`;
			if (failure === null && observation.answer.trim() === "") failure = "no answer text";
			const total = (pick: (usage: (typeof observation.usage)[number]) => number | null) => sum(observation.usage.map(pick));
			const mainCost = total((usage) => usage.costUsd);
			const completedCost = sum(lines.map((line) => line.costUsd));
			const unfinished = Math.max(0, counts.dispatched - lines.length);
			const compressorCost = completedCost === null ? null : completedCost + unfinished * USD_PER_FALLBACK_CALL;
			const cap = parseJudgeCap(JSON.parse(readFileSync(judgeFile, "utf8")));
			const allocatedUsd = cap.dispatched * JUDGE_ALLOCATION_USD;
			return {
				schemaVersion: 1, key, caseId: item.id, sourceId: item.snapshotId, split: item.split, category: item.category, repetition, viewBytes,
				status: failure === null ? "ok" : "failed", failure,
				answer: observation.answer.slice(0, ANSWER_CHARS), tools: observation.tools, latencyMs,
				main: { calls: observation.assistantMessages, input: total((usage) => usage.input), output: total((usage) => usage.output), cacheRead: total((usage) => usage.cacheRead), cacheWrite: total((usage) => usage.cacheWrite), costUsd: mainCost },
				compressor: { dispatched: counts.dispatched, completed: lines.length, costUsd: compressorCost },
				judge: { dispatched: cap.dispatched, refused: cap.refused, returned: cap.returned, allocatedUsd, diagnosticUsd: sum(cap.diagnosticUsd), models: [...new Set(cap.models)] },
				chargedUsd: mainCost === null || compressorCost === null ? null : mainCost + compressorCost + allocatedUsd,
				view,
			};
		};

		let failures = 0;
		outer: for (let repetition = 0; repetition < options.reps; repetition++) {
			for (const [index, item] of cases.entries()) {
				// Alternate which budget goes first, so neither always pays the cache write.
				const order = (index + repetition) % 2 === 0 ? options.views : [...options.views].reverse();
				const pending = order.filter((viewBytes) => !done.has(`${item.id}|${repetition}|${viewBytes}`));
				if (pending.length === 0) continue;
				if (charged === null) { stopReason = "unknown spend"; break outer; }
				if (charged + pending.length * TRIAL_RESERVE_USD > options.capUsd) { stopReason = `cap: $${charged.toFixed(4)} charged, the next ${pending.length} trial(s) reserve $${(pending.length * TRIAL_RESERVE_USD).toFixed(2)}`; break outer; }
				const rows = await Promise.all(pending.map((viewBytes) => trial(item, repetition, viewBytes)));
				for (const row of rows) {
					appendFileSync(resultsFile, `${JSON.stringify(row)}\n`, { mode: 0o600 });
					done.set(row.key, row);
					charged = charged === null || row.chargedUsd === null ? null : charged + row.chargedUsd;
					failures = row.status === "failed" ? failures + 1 : 0;
					console.log(`run ${row.key.replace(/^[^|]*/, `case-${index + 1}/${cases.length}`)} ${row.status} main=$${row.main.costUsd?.toFixed(4) ?? "unknown"} judge=${row.judge.dispatched} tools=${row.tools.length} charged=$${charged?.toFixed(4) ?? "unknown"}`);
					if (row.main.costUsd !== null && row.main.costUsd > MAIN_RESERVE_USD) { stopReason = "a trial's main-model cost exceeded its reserve"; break outer; }
					if (!options.fixture && row.status === "ok" && row.judge.returned === 0) { stopReason = "the judge answered no call in a trial: the gates did not run as preregistered"; break outer; }
				}
				if (failures >= 6) { stopReason = "six trials failed in a row"; break outer; }
			}
		}
		corpus.revalidate();
		const rows = [...done.values()];
		console.log(JSON.stringify({
			status: stopReason === null ? "complete" : "stopped", stopReason,
			trials: rows.length, ok: rows.filter((row) => row.status === "ok").length,
			chargedUsd: charged, fixtureViolations: server?.violations ?? [],
		}, null, 2));
		if (stopReason !== null) process.exitCode = 3;
	} finally {
		for (const host of hosts) await host.stop().catch(() => {});
		await server?.close();
	}
}

if (import.meta.main) await main();
