#!/usr/bin/env bun
/**
 * Length-retry measurement for the compressor: the same real nodes compacted by two source revisions through the
 * real `Memory` retry loop, on the production wire shape (host prefix plus OptChat's system block). It records
 * every attempt's reply size, so it shows how far over the byte limit a miss lands and whether a retry shortens it.
 *
 * Tasks come from build.ts and the host prefix from capture.ts, in the same gitignored run directory. Replies are
 * real chat text and are never stored here: rows keep sizes and counts only.
 *
 * Usage:
 *   bun evals/compressor/length.ts --run <run> --arm <name> --rev <commit> --max-calls <N> [--node merge|leaf] [--limit N] [--jobs 3]
 *   bun evals/compressor/length.ts --run <run> --report <base>,<candidate>
 * The run is resumable per arm. `--max-calls` is the budget: the compressor model may report no cost
 * (subscription billing), so calls are what is capped. A task starts only when a full retry chain still fits.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Context, Message as LlmMessage, Model } from "@oh-my-pi/pi-ai";
import { assistantTurn, call, Ledger, openModels, selectorOf, textOf } from "./host.ts";
import { compactNode, flag, loadSnapshot, loadStore, NODE_BYTES, nodesBefore, runDir, storeDirectories, type Task, utf8Bytes } from "./lib.ts";
import { buildArms, type HostPrefix } from "./run.ts";

const TRIES = 5;

interface Row {
	readonly task: string;
	readonly arm: string;
	readonly rev: string;
	readonly model: string;
	readonly node: Task["node"];
	/** Raw reply size per attempt, in UTF-8 bytes, in order. */
	readonly bytes: number[];
	readonly head: boolean[];
	readonly ms: number[];
	/** Size of the line the plugin would store; null when it refused or failed. */
	readonly finalBytes: number | null;
	readonly error?: string;
}

const jsonl = <T>(file: string): T[] =>
	existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as T) : [];

const quantile = (values: number[], q: number): number | null => {
	if (values.length === 0) return null;
	const sorted = values.slice().sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
};

/** Two-sided exact sign test over discordant pairs. */
function signTest(a: number, b: number): number {
	const n = a + b;
	if (n === 0) return 1;
	let tail = 0;
	let term = 0.5 ** n;
	for (let k = 0; k <= Math.min(a, b); k++) {
		tail += term;
		term = (term * (n - k)) / (k + 1);
	}
	return Math.min(1, 2 * tail);
}

function summary(rows: Row[]) {
	const ok = rows.filter((row) => row.finalBytes !== null);
	const attempts = [];
	for (let at = 0; at < TRIES; at++) {
		const sizes = ok.flatMap((row) => (row.bytes[at] === undefined ? [] : [row.bytes[at]!]));
		const over = sizes.filter((size) => size > NODE_BYTES).map((size) => size - NODE_BYTES);
		// A retry's change against the reply it was asked to shorten.
		const delta = ok.flatMap((row) => (at > 0 && row.bytes[at] !== undefined ? [row.bytes[at]! - row.bytes[at - 1]!] : []));
		attempts.push({
			attempt: at + 1,
			calls: sizes.length,
			over: over.length,
			overMedian: quantile(over, 0.5),
			overP90: quantile(over, 0.9),
			overMax: over.length ? Math.max(...over) : null,
			deltaMedian: quantile(delta, 0.5),
		});
	}
	const calls = ok.reduce((sum, row) => sum + row.bytes.length, 0);
	return {
		tasks: rows.length,
		failed: rows.length - ok.length,
		calls,
		callsPerTask: ok.length ? Number((calls / ok.length).toFixed(3)) : null,
		retryShare: calls ? Number(((calls - ok.length) / calls).toFixed(3)) : null,
		headReplies: ok.reduce((sum, row) => sum + row.head.filter(Boolean).length, 0),
		finalOver: ok.filter((row) => row.finalBytes! > NODE_BYTES).length,
		finalBytes: { p10: quantile(ok.map((row) => row.finalBytes!), 0.1), median: quantile(ok.map((row) => row.finalBytes!), 0.5) },
		ms: ok.reduce((sum, row) => sum + row.ms.reduce((a, b) => a + b, 0), 0),
		attempts,
	};
}

function report(dir: string, names: string[]): void {
	const [base, candidate] = names.map((name) => jsonl<Row>(join(dir, `length-${name}.jsonl`)));
	const out: Record<string, unknown> = { nodeBytes: NODE_BYTES };
	names.forEach((name, at) => (out[name] = { revs: [...new Set([base, candidate][at]!.map((row) => row.rev))], ...summary([base, candidate][at]!) }));
	if (base && candidate) {
		const other = new Map(candidate.map((row) => [row.task, row]));
		let fewer = 0, more = 0, same = 0, shorter = 0;
		const finals: number[] = [];
		for (const row of base) {
			const pair = other.get(row.task);
			if (!pair || row.finalBytes === null || pair.finalBytes === null) continue;
			if (pair.bytes.length < row.bytes.length) fewer++;
			else if (pair.bytes.length > row.bytes.length) more++;
			else same++;
			finals.push(pair.finalBytes - row.finalBytes);
			if (pair.finalBytes < row.finalBytes) shorter++;
		}
		out.paired = {
			pairs: fewer + more + same,
			candidateFewerCalls: fewer,
			candidateMoreCalls: more,
			sameCalls: same,
			signTestP: Number(signTest(fewer, more).toFixed(4)),
			finalBytesDeltaMedian: quantile(finals, 0.5),
			candidateShorterFinal: shorter,
		};
	}
	console.log(JSON.stringify(out, null, 2));
}

async function main(args: string[]): Promise<void> {
	const dir = runDir(flag(args, "--run", ""));
	const reportArms = flag(args, "--report", "");
	if (reportArms) return report(dir, reportArms.split(","));
	const arm = flag(args, "--arm", "");
	if (!/^[\w-]+$/.test(arm)) throw new Error("--arm must be a plain name");
	const maxCalls = Number(flag(args, "--max-calls", ""));
	if (!Number.isInteger(maxCalls) || maxCalls < TRIES) throw new Error(`--max-calls is required (an integer of at least ${TRIES})`);
	const jobs = Number(flag(args, "--jobs", "3"));
	const snapshot = await loadSnapshot(flag(args, "--run", ""), flag(args, "--rev", "HEAD"));
	const file = join(dir, `length-${arm}.jsonl`);
	const done = new Set(jsonl<Row>(file).map((row) => row.task));
	const node = flag(args, "--node", "merge");
	const tasks = jsonl<Task>(join(dir, "tasks.jsonl")).filter((task) => task.node === node).slice(0, Number(flag(args, "--limit", "1000"))).filter((task) => !done.has(task.id));
	const host: HostPrefix = JSON.parse(readFileSync(join(dir, "host-prefix.json"), "utf8"));
	const models = await openModels({ judge: "@judge", main: host.model });
	try {
		const { arms } = buildArms(snapshot, host, models);
		const model = models.compressor;
		const ledger = new Ledger(dir);
		const stores = new Map(storeDirectories().map((directory) => [directory.split("/").pop()!, loadStore(directory)]));
		let calls = 0;
		let reserved = 0;
		let stopped: string | null = null;
		const queue = tasks.slice();
		const worker = async (): Promise<void> => {
			for (;;) {
				const task = queue.shift();
				if (!task || stopped) return;
				// A whole retry chain is reserved up front, so parallel tasks cannot pass the cap together.
				if (reserved + TRIES > maxCalls) {
					stopped = `call cap ${maxCalls} reached`;
					return;
				}
				reserved += TRIES;
				const store = stores.get(task.store);
				if (!store) throw new Error(`store ${task.store} is gone`);
				const own = { lo: task.node === "leaf" ? task.i : task.start, hi: task.node === "leaf" ? task.i : task.end - 1 };
				const bytes: number[] = [];
				const head: boolean[] = [];
				const ms: number[] = [];
				let finalBytes: number | null = null;
				let error: string | undefined;
				// Memory replaces a provider error with its own backoff signal; keep the provider's own text.
				let failure: string | undefined;
				try {
					const final = await compactNode(snapshot, store, nodesBefore(store, task.row), { l: task.l, i: task.i, start: task.start, end: task.end }, async (request, signal) => {
						const messages: LlmMessage[] = [{
							role: "user",
							content: [...snapshot.viewBlocks(request.context, model), { type: "text", text: request.instruction }],
							timestamp: Date.now(),
						}];
						for (const turn of request.feedback) {
							messages.push(assistantTurn(model, turn.reply), { role: "user", content: [{ type: "text", text: turn.instruction }], timestamp: Date.now() });
						}
						const context: Context = { systemPrompt: arms.H.systemPrompt, messages };
						const started = performance.now();
						calls++;
						const reply = await call(models, ledger, { phase: "compress", task: task.id, arm: "H", attempt: bytes.length + 1 }, model, context, {
							signal: AbortSignal.any([signal, AbortSignal.timeout(180_000)]),
							maxTokens: undefined,
							reasoning: snapshot.compressorReasoning(model, undefined),
							onPayload: (payload: unknown, payloadModel: Model | undefined): unknown => {
								const tools = arms.H.tools;
								const encoded = tools && typeof payload === "object" && payload !== null
									? { ...(payload as Record<string, unknown>), tools: structuredClone(tools) }
									: payload;
								return snapshot.encodeCachePayload(encoded, payloadModel ?? model);
							},
						}).catch((caught: unknown) => {
							failure = caught instanceof Error ? caught.message : String(caught);
							throw caught;
						});
						const text = textOf(reply).trim();
						bytes.push(utf8Bytes(text));
						head.push(snapshot.replyHead(text, own) > 0);
						ms.push(Math.round(performance.now() - started));
						return textOf(reply);
					}, new AbortController().signal);
					if (final === undefined) error = "cancelled";
					else finalBytes = utf8Bytes(final);
				} catch (caught) {
					// The message may quote provider text; keep only its class and a short prefix without chat content.
					error = caught instanceof snapshot.CompressorRefusedError ? "refused" : (failure ?? (caught instanceof Error ? caught.message : String(caught))).slice(0, 120);
				}
				reserved -= TRIES - bytes.length;
				const row: Row = { task: task.id, arm, rev: snapshot.sha, model: selectorOf(model), node: task.node, bytes, head, ms, finalBytes, ...(error ? { error } : {}) };
				appendFileSync(file, `${JSON.stringify(row)}\n`, { mode: 0o600 });
				// A provider failure is not a length result: stop rather than burn the cap on a throttled route.
				if (error && error !== "refused") stopped = `task ${task.id} failed: ${error}`;
			}
		};
		await Promise.all(Array.from({ length: Math.max(1, jobs) }, worker));
		console.log(JSON.stringify({ arm, rev: snapshot.sha.slice(0, 12), model: selectorOf(model), callsThisRun: calls, stopped, ...summary(jsonl<Row>(file)) }, null, 2));
	} finally {
		models.close();
	}
}

if (import.meta.main) await main(process.argv.slice(2));
