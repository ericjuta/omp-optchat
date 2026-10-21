/**
 * Runs the compressor system-prompt A/B (plans/optchat-jev.md, Decision 2026-10-21, item 3b) over the tasks built by
 * build.ts. Each task is compressed once per arm with the production compressor model and the real `Memory` retry
 * path, then judged blind by one pairwise call.
 *
 *   H  the host system prompt as prefix plus SYSTEM_BLOCK, with the host's encoded tool list: what the plugin sends now.
 *   C  SYSTEM_BLOCK alone, no host prompt and no tools. Frozen text; its sha256 is in frozen.json.
 *
 * Everything the run writes is under evals/compressor/runs/<run>/ (gitignored: it holds real chat text).
 *
 * Usage: bun evals/compressor/run.ts [--run ab-20261021] [--rev HEAD] [--limit N] [--check]
 * The seed and scoring basis are the run's own, frozen by build.ts in sample.json.
 *   --check  builds each arm's wire request for the first task and prints its shape; no provider call is made.
 * The run is resumable: finished arms and judgments are skipped. It stops, without exceeding the cap, when the next
 * task could not be paid for (cap $5 over every compress and judge call), and says so.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { completeSimple, type Context, type Message as LlmMessage, type Model } from "@oh-my-pi/pi-ai";
import {
	assistantTurn,
	call,
	costOf,
	Ledger,
	type Models,
	openModels,
	selectorOf,
	textOf,
} from "./host.ts";
import { judgePair, type Judgment, rubricHash } from "./judge.ts";
import {
	BUDGET_USD,
	compactNode,
	DEFAULT_RUN,
	type Design,
	designOf,
	flag,
	keyedPrng,
	loadSnapshot,
	loadStore,
	NODE_BYTES,
	nodesBefore,
	runDir,
	sha256,
	type Snapshot,
	storeDirectories,
	type Task,
	utf8Bytes,
} from "./lib.ts";

/** The head and false-tag detectors the hard rules use: the plugin's own `replyHead`, and the tag test of 0.13.0's guard. */
const USER_TAG = /(?:^|;\s+)user:/i;
const MARKER = "[unsummarized";

export interface Attempt {
	readonly attempt: number;
	readonly bytes: number;
	readonly over: boolean;
	readonly head: boolean;
	readonly falseUser: boolean;
	readonly marker: boolean;
	readonly promptCostUsd: number | null;
	readonly costUsd: number | null;
	readonly input: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly output: number;
	/** The raw reply, trimmed as `Memory` trims it. Real chat text: gitignored. */
	readonly reply: string;
}

export interface ArmResult {
	readonly task: string;
	readonly arm: "H" | "C";
	readonly attempts: Attempt[];
	/** The line the plugin would store; absent when the compressor refused or the call failed. */
	readonly final?: string;
	readonly refused?: boolean;
	readonly error?: string;
}

interface HostPrefix {
	readonly model: string;
	readonly systemPrompt: string[];
	readonly system: Array<{ text?: string }>;
	readonly tools: unknown[];
}

class BudgetStop extends Error {
	override name = "BudgetStop";
}

const jsonl = <T>(file: string): T[] =>
	existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as T) : [];

/** The plugin's own test for a tool a compressor may share (`passiveTool`, Anthropic Messages). */
const passive = (tool: unknown): boolean => {
	if (typeof tool !== "object" || tool === null || Array.isArray(tool)) return false;
	const t = tool as Record<string, unknown>;
	return (t.type === undefined || t.type === "custom") && typeof t.name === "string" &&
		typeof t.input_schema === "object" && t.input_schema !== null && !Array.isArray(t.input_schema);
};

interface Arms {
	readonly H: { systemPrompt: string[]; tools: unknown[] | undefined };
	readonly C: { systemPrompt: string[]; tools: undefined };
}

function buildArms(snapshot: Snapshot, host: HostPrefix, models: Models): { arms: Arms; toolsShared: boolean } {
	const block = snapshot.SYSTEM_BLOCK;
	// Same as `beforeAgentStart`: appended once, never twice.
	const systemPrompt = host.systemPrompt.includes(block) ? host.systemPrompt : [...host.systemPrompt, block];
	// `alignPrefix` shares the host's encoded tools only when every one is passive and the compressor's encoder would
	// emit the same declarations; otherwise the compressor request carries none.
	const toolsShared = host.tools.length > 0 && host.tools.every(passive) && snapshot.sharedToolsAllowed(models.main, models.compressor);
	return {
		arms: { H: { systemPrompt, tools: toolsShared ? host.tools : undefined }, C: { systemPrompt: [block], tools: undefined } },
		toolsShared,
	};
}

/** What is frozen before any provider call. */
function frozenRecord(snapshot: Snapshot, host: HostPrefix, arms: Arms, toolsShared: boolean, models: Models, run: string, rev: string, design: Design) {
	const stored = design.basis === "stored";
	return {
		seed: design.seed,
		sourceRev: snapshot.sha,
		requestedRev: rev,
		models: { compressor: selectorOf(models.compressor), main: selectorOf(models.main), judge: selectorOf(models.judge) },
		tasksSha256: sha256(readFileSync(join(runDir(run), "tasks.jsonl"), "utf8")),
		armC: { systemPromptSha256: sha256(JSON.stringify(arms.C.systemPrompt)), bytes: utf8Bytes(arms.C.systemPrompt.join("")), tools: 0 },
		armH: {
			systemPromptSha256: sha256(JSON.stringify(arms.H.systemPrompt)),
			bytes: utf8Bytes(arms.H.systemPrompt.join("")),
			blocks: arms.H.systemPrompt.length,
			toolsShared,
			toolsSha256: sha256(JSON.stringify(arms.H.tools ?? null)),
			tools: arms.H.tools?.length ?? 0,
			capturedFrom: host.model,
		},
		rubricSha256: rubricHash(snapshot.COMPACT),
		definitions: {
			hardRules: "over the 512-byte node limit; a forbidden head (replyHead, with the task's own ids); a `user:` tag when the covered range has no user record",
			hardRuleBasis: stored
				? "stored lines: the line OptChat's retry and cut path keeps, plus refused tasks; first-attempt counts are reported beside them"
				: "first-attempt replies: the compressor's own output before OptChat's retry and cut; stored-line counts are reported beside them",
			promptCost: "provider-reported cost.input + cost.cacheRead + cost.cacheWrite, per provider call (retries included)",
			...(stored ? { taskCost: "provider-reported total cost of every compressor attempt for one task" } : {}),
			adopt: stored
				? "C adopted iff #C-worse <= #C-better (ties and invalid excluded) AND C stored-line hard violations + refused tasks <= H AND C mean total compressor cost per task < H"
				: "C adopted iff #C-worse <= #C-better (ties and invalid excluded) AND C hard violations <= H AND C mean prompt cost per call < H",
			judgeInput: "task statement, limit and input exactly as the compressor saw them; not the chat context",
		},
	};
}

function ensureFrozen(dir: string, record: unknown): void {
	const file = join(dir, "frozen.json");
	const text = JSON.stringify(record, null, 2);
	if (!existsSync(file)) {
		writeFileSync(file, text, { mode: 0o600 });
		return;
	}
	if (readFileSync(file, "utf8") !== text) {
		throw new Error(`frozen.json differs from this run's prompts, tasks or models; use a new --run (the prompts were frozen before the first call)`);
	}
}

function wireSummary(payload: unknown): Record<string, unknown> {
	const p = payload as Record<string, unknown>;
	const system = Array.isArray(p.system) ? (p.system as Array<Record<string, unknown>>) : [];
	const messages = Array.isArray(p.messages) ? (p.messages as Array<Record<string, unknown>>) : [];
	const marks = (blocks: unknown): unknown[] => Array.isArray(blocks)
		? (blocks as Array<Record<string, unknown>>).flatMap((block, index) => (block.cache_control ? [{ index, cache_control: block.cache_control }] : []))
		: [];
	return {
		systemBlocks: system.map((block) => (typeof block.text === "string" ? utf8Bytes(block.text) : null)),
		systemMarks: marks(system),
		tools: Array.isArray(p.tools) ? p.tools.length : 0,
		toolMarks: marks(p.tools),
		messageBlocks: messages.map((m) => (Array.isArray(m.content) ? m.content.length : 1)),
		messageMarks: messages.map((m) => marks(m.content)),
		thinking: p.thinking ?? null,
	};
}

async function main(args: string[]): Promise<void> {
	const run = flag(args, "--run", DEFAULT_RUN);
	const rev = flag(args, "--rev", "HEAD");
	const limit = Number(flag(args, "--limit", "1000"));
	const check = args.includes("--check");
	const dir = runDir(run);
	const design = designOf(dir);
	const snapshot = await loadSnapshot(run, rev);
	const tasks = jsonl<Task>(join(dir, "tasks.jsonl")).slice(0, limit);
	if (tasks.length === 0) throw new Error("no tasks: run build.ts first");
	const host: HostPrefix = JSON.parse(readFileSync(join(dir, "host-prefix.json"), "utf8"));
	const models = await openModels({ judge: flag(args, "--judge-model", "anthropic/claude-opus-5-5"), main: flag(args, "--main-model", host.model) });
	try {
		const { arms, toolsShared } = buildArms(snapshot, host, models);
		const ledger = new Ledger(dir);
		const model = models.compressor;

		/** The request `compressorReply` builds, as an arm's context and wire hook. */
		const context = (arm: "H" | "C", request: { context: string; instruction: string; feedback: ReadonlyArray<{ reply: string; instruction: string }> }): Context => {
			const messages: LlmMessage[] = [{
				role: "user",
				content: [...snapshot.viewBlocks(request.context, model), { type: "text", text: request.instruction }],
				timestamp: Date.now(),
			}];
			for (const turn of request.feedback) {
				messages.push(assistantTurn(model, turn.reply), { role: "user", content: [{ type: "text", text: turn.instruction }], timestamp: Date.now() });
			}
			return { systemPrompt: arms[arm].systemPrompt, messages };
		};
		const onPayload = (arm: "H" | "C") => (payload: unknown, payloadModel: Model | undefined): unknown => {
			const actual = payloadModel ?? model;
			const tools = arms[arm].tools;
			const encoded = tools && typeof payload === "object" && payload !== null
				? { ...(payload as Record<string, unknown>), tools: structuredClone(tools) }
				: payload;
			return snapshot.applyOptChatCache(encoded, actual);
		};

		if (check) {
			const task = tasks[0]!;
			for (const arm of ["H", "C"] as const) {
				let seen: unknown;
				const request = { context: task.context, instruction: task.instruction, feedback: [] };
				// Stopping inside onPayload ends the call before the send, so `--check` makes no model call. The
				// SDK may report that stop as an error reply or a throw; either way only the captured payload matters.
				await completeSimple(model, context(arm, request), {
					apiKey: models.registry.resolver(model, models.sessionId),
					statefulResponses: false,
					reasoning: snapshot.compressorReasoning(model, undefined),
					onPayload: (payload, payloadModel) => {
						seen = onPayload(arm)(payload, payloadModel);
						throw new Error("check-only");
					},
				}).catch(() => undefined);
				if (seen === undefined) throw new Error(`no payload captured for arm ${arm}`);
				const wire = wireSummary(seen);
				const system = ((seen as { system?: Array<{ text?: string }> }).system ?? []).map((block) => block.text ?? "");
				const captured = host.system.map((block) => block.text ?? "");
				console.log(JSON.stringify({
					arm,
					wire,
					// Arm H's host blocks must equal what the real host encoded for a main request.
					hostBlocksEqualCaptured: arm === "H" ? captured.map((text, index) => system[index] === text) : undefined,
					systemBlockLast: system.at(-1) === snapshot.SYSTEM_BLOCK,
					toolsEqualCaptured: arm === "H" ? JSON.stringify((seen as { tools?: unknown }).tools) === JSON.stringify(host.tools) : undefined,
				}, null, 2));
			}
			console.log(JSON.stringify({ toolsShared, compressor: selectorOf(model), main: selectorOf(models.main), judge: selectorOf(models.judge) }));
			return;
		}

		ensureFrozen(dir, frozenRecord(snapshot, host, arms, toolsShared, models, run, rev, design));
		const resultsFile = join(dir, "results.jsonl");
		const judgmentsFile = join(dir, "judgments.jsonl");
		const stores = new Map(storeDirectories().map((directory) => [directory.split("/").at(-1)!, loadStore(directory)]));

		/** Largest provider-reported cost so far per phase, to keep every call and task inside the cap. */
		const seenMax = { compress: 0.3, judge: 0.06 };
		const guard = (phase: "compress" | "judge"): void => {
			const { usd, unknown } = ledger.total();
			if (unknown > 0) throw new BudgetStop(`${unknown} call(s) reported no cost: the cap cannot be enforced`);
			const reserve = phase === "compress" ? seenMax.compress + seenMax.judge : seenMax.judge;
			if (usd + reserve > BUDGET_USD) throw new BudgetStop(`next call could pass the $${BUDGET_USD} cap (spent $${usd.toFixed(4)})`);
		};

		const runArm = async (task: Task, arm: "H" | "C"): Promise<ArmResult> => {
			const store = stores.get(task.store);
			if (!store) throw new Error(`store ${task.store} is gone`);
			const nodes = nodesBefore(store, task.row);
			const own = { lo: task.node === "leaf" ? task.i : task.start, hi: task.node === "leaf" ? task.i : task.end - 1 };
			const attempts: Attempt[] = [];
			try {
				const final = await compactNode(snapshot, store, nodes, { l: task.l, i: task.i, start: task.start, end: task.end }, async (request, signal) => {
					guard("compress");
					const reply = await call(
						models,
						ledger,
						{ phase: "compress", task: task.id, arm, attempt: attempts.length + 1 },
						model,
						context(arm, request),
						{
							signal: AbortSignal.any([signal, AbortSignal.timeout(180_000)]),
							maxTokens: undefined,
							reasoning: snapshot.compressorReasoning(model, undefined),
							onPayload: onPayload(arm),
						},
					);
					const text = textOf(reply).trim();
					const cost = costOf(reply);
					const head = snapshot.replyHead(text, own);
					attempts.push({
						attempt: attempts.length + 1,
						bytes: utf8Bytes(text),
						over: utf8Bytes(text) > NODE_BYTES,
						head: head > 0,
						falseUser: !task.user && USER_TAG.test(text.slice(head)),
						marker: text.startsWith(MARKER, head),
						promptCostUsd: cost.promptCostUsd,
						costUsd: cost.costUsd,
						input: reply.usage.input,
						cacheRead: reply.usage.cacheRead,
						cacheWrite: reply.usage.cacheWrite,
						output: reply.usage.output,
						reply: text,
					});
					if (cost.costUsd !== null) seenMax.compress = Math.max(seenMax.compress, cost.costUsd);
					return textOf(reply);
				}, new AbortController().signal);
				return { task: task.id, arm, attempts, ...(final === undefined ? { error: "cancelled" } : { final }) };
			} catch (error) {
				if (error instanceof BudgetStop) throw error;
				const refused = error instanceof snapshot.CompressorRefusedError;
				return { task: task.id, arm, attempts, ...(refused ? { refused: true } : { error: error instanceof Error ? error.message.slice(0, 300) : String(error) }) };
			}
		};

		let stopped: string | undefined;
		let completed = 0;
		for (const task of tasks) {
			const results = jsonl<ArmResult>(resultsFile);
			const doneArm = (arm: "H" | "C") => results.find((r) => r.task === task.id && r.arm === arm && (r.final !== undefined || r.refused));
			const judged = jsonl<Judgment>(judgmentsFile).some((j) => j.task === task.id);
			if (doneArm("H") && doneArm("C") && judged) {
				completed++;
				continue;
			}
			try {
				// Per-task gate: a started task can always finish both arms and its judgment.
				const { usd } = ledger.total();
				const taskReserve = 2 * seenMax.compress * 1.6 + seenMax.judge;
				if (usd + taskReserve > BUDGET_USD) throw new BudgetStop(`next task could pass the $${BUDGET_USD} cap (spent $${usd.toFixed(4)})`);
				// Execution order per task is a seeded coin, so neither arm always runs first (cache warmth, wall clock).
				const order: Array<"H" | "C"> = keyedPrng(design.seed, `exec:${task.id}`)() < 0.5 ? ["H", "C"] : ["C", "H"];
				const got: Partial<Record<"H" | "C", ArmResult>> = {};
				for (const arm of order) {
					got[arm] = doneArm(arm);
					if (!got[arm]) {
						got[arm] = await runArm(task, arm);
						appendFileSync(resultsFile, `${JSON.stringify(got[arm])}\n`, { mode: 0o600 });
					}
					const r = got[arm]!;
					const cost = r.attempts.reduce<number | null>((sum, a) => (sum === null || a.costUsd === null ? null : sum + a.costUsd), 0);
					console.log(`${task.id} ${arm} attempts=${r.attempts.length} bytes=${r.final === undefined ? "-" : utf8Bytes(r.final)} cost=${cost === null ? "unknown" : cost.toFixed(4)}${r.error ? ` error=${r.error}` : ""}${r.refused ? " refused" : ""}`);
				}
				const H = got.H!;
				const C = got.C!;
				if (H.final !== undefined && C.final !== undefined && !judged) {
					guard("judge");
					const before = ledger.total().usd;
					const judgment = await judgePair(models, ledger, snapshot.COMPACT, task, { H: H.final, C: C.final }, design.seed);
					appendFileSync(judgmentsFile, `${JSON.stringify(judgment)}\n`, { mode: 0o600 });
					seenMax.judge = Math.max(seenMax.judge, (ledger.total().usd - before) * 1.5);
					console.log(`${task.id} judged first=${judgment.first} winner=${judgment.winner}`);
				}
				completed++;
			} catch (error) {
				if (!(error instanceof BudgetStop)) throw error;
				stopped = error.message;
				break;
			}
		}
		const { usd, unknown } = ledger.total();
		console.log(JSON.stringify({ tasks: tasks.length, completed, stopped: stopped ?? null, spentUsd: Number(usd.toFixed(4)), unknownCostCalls: unknown }));
	} finally {
		models.close();
	}
}

if (import.meta.main) await main(process.argv.slice(2));
