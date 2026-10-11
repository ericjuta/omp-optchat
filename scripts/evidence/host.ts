import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Dirent } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { UsageRecord } from "./artifact.ts";
import type { RetrievedPage } from "./scoring.ts";

export type Frame = Record<string, unknown>;

export interface HostLaunch {
	readonly omp: string;
	readonly plugin: string;
	readonly memory: string;
	readonly sessionDir: string;
	readonly cwd: string;
	readonly main: string;
	readonly compressor: string;
	readonly metricsFile: string;
	readonly admissionFile: string;
	readonly allowance: number;
	/** Per-host dollar allowance (OPTCHAT_EVIDENCE_USD_ALLOWANCE): reserved worst-case USD may not exceed it. */
	readonly usdAllowance: number;
	/** Worst-case USD charged per compressor admission (OPTCHAT_EVIDENCE_USD_PER_CALL), computed by the runner. */
	readonly usdPerCall: number;
	readonly compressorMaxTokens: number;
	/** The host's view budget in bytes (--optchat-view-bytes). The product default is larger; see EVIDENCE_VIEW_BYTES. */
	readonly viewBytes: number;
	/** Complete child environment. The caller builds it from an allowlist; nothing is inherited here. */
	readonly env: Readonly<Record<string, string>>;
	/** false → `--no-optchat`; the evidence wrapper extension still loads. */
	readonly optchat: boolean;
	/** Appended after the standard arguments. */
	readonly extraArgs: readonly string[];
	/** null keeps `--no-tools`; a list replaces it with `--tools <csv>`. */
	readonly tools: readonly string[] | null;
}

/** Common no-ambient-state flags: no tools, skills, rules, or discovered extensions. */
const ISOLATION_FLAGS = ["--mode", "rpc", "--no-ui", "--no-title", "--no-tools", "--no-skills", "--no-rules", "--no-extensions"];
/** Isolation flags for one launch: `--no-tools` unless a tool list names the tools to expose instead. */
function isolationFlags(tools: readonly string[] | null): string[] {
	if (tools === null) return [...ISOLATION_FLAGS];
	if (tools.length === 0) throw new RangeError("tools must name at least one tool; use null to disable tools");
	const at = ISOLATION_FLAGS.indexOf("--no-tools");
	return [...ISOLATION_FLAGS.slice(0, at), "--tools", tools.join(","), ...ISOLATION_FLAGS.slice(at + 1)];
}

/**
 * Real host launch with the evidence extension as the only -e entry. The extension wraps the
 * shipped OptChat factory; the agent directory comes from the isolated child environment.
 */
export function launchArgs(launch: HostLaunch, extension: string): string[] {
	return [
		...isolationFlags(launch.tools),
		"-e", extension,
		"--session-dir", launch.sessionDir,
		"--model", launch.main,
		"--optchat-model", launch.compressor,
		"--optchat-dir", launch.memory,
		// Runner-only: a view budget small enough that the saved tree coarsens within the call budget.
		"--optchat-view-bytes", String(launch.viewBytes),
		...(launch.optchat ? [] : ["--no-optchat"]),
		...launch.extraArgs,
	];
}

function withDeadline<T>(label: string, operation: Promise<T>, ms: number): Promise<T> {
	const expiry = Promise.withResolvers<never>();
	const timer = setTimeout(() => expiry.reject(new Error(`${label} exceeded ${ms}ms`)), ms);
	return Promise.race([operation, expiry.promise]).finally(() => clearTimeout(timer));
}

/**
 * Ends a detached child and its process group: SIGTERM, then SIGKILL after the grace period.
 * Resolves once the child has exited, so a returned stop means no owned process remains.
 */
export async function endProcess(child: ChildProcessWithoutNullStreams, exited: Promise<unknown>, graceMs: number): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	child.stdin.end();
	const pid = child.pid;
	const signal = (value: NodeJS.Signals) => {
		try {
			if (pid) process.kill(-pid, value);
			else child.kill(value);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
		}
	};
	const term = setTimeout(() => signal("SIGTERM"), 1000);
	const kill = setTimeout(() => signal("SIGKILL"), graceMs);
	try {
		await exited;
	} finally {
		clearTimeout(term);
		clearTimeout(kill);
	}
}

export class RpcHost {
	readonly events: Frame[] = [];
	readonly exited: Promise<number | null>;
	private readonly child: ChildProcessWithoutNullStreams;
	private serial = 0;
	private readonly waiters = new Map<string, (frame: Frame) => void>();
	private readonly listeners = new Set<() => void>();

	constructor(launch: HostLaunch, extension: string) {
		this.child = spawn(launch.omp, launchArgs(launch, extension), {
			cwd: launch.cwd,
			env: {
				...launch.env,
				OPTCHAT_METRICS_FILE: launch.metricsFile,
				OPTCHAT_EVIDENCE_ADMISSION_FILE: launch.admissionFile,
				OPTCHAT_EVIDENCE_ALLOWANCE: String(launch.allowance),
				// Plain decimals only: the extension's parser rejects exponent notation.
				OPTCHAT_EVIDENCE_USD_ALLOWANCE: launch.usdAllowance.toFixed(12),
				OPTCHAT_EVIDENCE_USD_PER_CALL: launch.usdPerCall.toFixed(12),
				OPTCHAT_EVIDENCE_COMPRESSOR_MAX_TOKENS: String(launch.compressorMaxTokens),
			},
			stdio: "pipe",
			detached: true,
		});
		const exit = Promise.withResolvers<number | null>();
		this.exited = exit.promise;
		this.child.once("exit", (code) => {
			exit.resolve(code);
			for (const notify of this.listeners) notify();
		});
		// Writes after the child exits must not surface as unhandled errors.
		this.child.stdin.on("error", () => {});
		// Diagnostics may carry provider detail: read to drain the pipe, never retain or print.
		this.child.stderr.on("data", () => {});
		createInterface({ input: this.child.stdout }).on("line", (line) => {
			let value: unknown;
			try {
				value = JSON.parse(line);
			} catch {
				return;
			}
			if (value === null || typeof value !== "object" || Array.isArray(value)) return;
			const frame = value as Frame;
			this.events.push(frame);
			if (frame.type === "response" && typeof frame.id === "string") {
				this.waiters.get(frame.id)?.(frame);
				this.waiters.delete(frame.id);
			}
			for (const notify of this.listeners) notify();
		});
	}

	private async waitFor(label: string, predicate: () => boolean, ms: number): Promise<void> {
		if (predicate()) return;
		const ready = Promise.withResolvers<void>();
		const listener = () => {
			if (predicate()) ready.resolve();
		};
		this.listeners.add(listener);
		try {
			await withDeadline(label, ready.promise, ms);
		} finally {
			this.listeners.delete(listener);
		}
	}

	private async send(type: string, fields: Frame, ms: number): Promise<Frame> {
		const id = `evidence-${++this.serial}`;
		const response = Promise.withResolvers<Frame>();
		this.waiters.set(id, response.resolve);
		this.child.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`);
		return withDeadline(`RPC ${type}`, response.promise, ms);
	}

	/**
	 * One prompt: waits for ready, the correlated prompt_result, then session_settled.
	 * `images` are base64 PNG/JPEG/WebP entries sent with the prompt.
	 */
	async prompt(message: string, ms: number, images?: readonly { data: string; mimeType: string }[]): Promise<{ start: number; end: number; status: string }> {
		await this.waitFor("RPC ready", () => this.events.some((event) => event.type === "ready"), ms);
		const start = this.events.length;
		const accepted = await this.send("prompt", images && images.length > 0 ? { message, images } : { message }, ms);
		if (accepted.success !== true || typeof accepted.id !== "string") throw new Error("RPC prompt was rejected");
		const id = accepted.id;
		await this.waitFor("prompt_result", () => this.events.some((event) => event.type === "prompt_result" && event.id === id), ms);
		const index = this.events.findIndex((event) => event.type === "prompt_result" && event.id === id);
		const result = this.events[index]!;
		if (result.sessionSettled !== true) {
			await this.waitFor("session_settled", () => this.events.slice(index + 1).some((event) => event.type === "session_settled"), ms);
		}
		const failures = this.events.slice(start).filter((event) => event.type === "error" || event.type === "extension_error");
		if (failures.length > 0) throw new Error(`host reported ${failures.length} error event(s) during a prompt`);
		return { start, end: this.events.length, status: String(result.status) };
	}

	/**
	 * The effective system prompt from the `get_state` snapshot. Only the snapshot is requested: no
	 * `prompt` is ever sent, so no main-model or compressor provider request can be made here.
	 */
	async effectiveSystemPrompt(ms: number): Promise<string> {
		await this.waitFor("RPC ready", () => this.events.some((event) => event.type === "ready"), ms);
		const response = await this.send("get_state", {}, ms);
		const state = asFrame(response.data);
		// OMP 18.9.0 reports the prompt as sections; earlier hosts sent one string.
		const prompt = state?.systemPrompt;
		const sections = typeof prompt === "string" ? [prompt] : Array.isArray(prompt) && prompt.every((part) => typeof part === "string") ? prompt : undefined;
		if (response.success !== true || sections === undefined || sections.length === 0) {
			throw new Error("host state carries no effective system prompt");
		}
		return sections.join("\n\n");
	}

	async stop(graceMs = 3000): Promise<void> {
		await endProcess(this.child, this.exited, graceMs);
	}
}

/**
 * Preflight host: one host launched with the caller's launch (the caller passes a zero compressor
 * allowance), read through `get_state` only, and ended before this resolves. No prompt is sent.
 */
export async function readEffectivePrompt(launch: HostLaunch, extension: string, ms: number): Promise<string> {
	const host = new RpcHost(launch, extension);
	try {
		return await host.effectiveSystemPrompt(ms);
	} finally {
		await host.stop();
	}
}

/**
 * Public model listing through the host's `get_available_models` RPC: no prompt, no provider
 * request. The host decides which models have configured authentication; the runner only reads
 * the provider/id pairs it returns. Owned process is always ended before this resolves.
 */
export async function queryAvailableModels(
	omp: string,
	env: Readonly<Record<string, string>>,
	sessionDir: string,
	cwd: string,
	timeoutMs = 60_000,
	extensions: readonly string[] = [],
): Promise<{ provider: string; id: string }[]> {
	const extensionFlags = extensions.flatMap((path) => ["-e", path]);
	const child = spawn(omp, [...ISOLATION_FLAGS, ...extensionFlags, "--session-dir", sessionDir], { cwd, env: { ...env }, stdio: "pipe", detached: true });
	const exit = Promise.withResolvers<number | null>();
	child.once("exit", (code) => exit.resolve(code));
	const exited = exit.promise;
	child.stdin.on("error", () => {});
	child.stderr.on("data", () => {});
	const response = Promise.withResolvers<Frame>();
	createInterface({ input: child.stdout }).on("line", (line) => {
		try {
			const frame = asFrame(JSON.parse(line));
			if (frame?.type === "response" && frame.id === "models") response.resolve(frame);
		} catch {
			// Non-JSON lines are host logging; they carry no RPC response.
		}
	});
	try {
		child.stdin.write(`${JSON.stringify({ id: "models", type: "get_available_models" })}\n`);
		const frame = await withDeadline("RPC get_available_models", response.promise, timeoutMs);
		if (frame.success !== true || frame.command !== "get_available_models") throw new Error("get_available_models was not accepted by the host");
		const data = asFrame(frame.data);
		const models = Array.isArray(data?.models) ? data.models : [];
		return models.flatMap((entry) => {
			const model = asFrame(entry);
			return model && typeof model.provider === "string" && typeof model.id === "string" ? [{ provider: model.provider, id: model.id }] : [];
		});
	} finally {
		await endProcess(child, exited, 3000);
	}
}

export interface TurnObservation {
	/** Final assistant text of the turn: the structured answer set for batch prompts. */
	readonly answer: string;
	readonly zoomCalls: ReadonlyArray<{ id: number | null; n: number | null; offset: number | null }>;
	/** Original record text the model actually received: only n=1 zoom results and non-error work results. */
	readonly pages: RetrievedPage[];
	readonly usage: UsageRecord[];
	readonly assistantMessages: number;
	/** stopReason of the last finalized assistant message: "aborted" or "error" means the host did not complete the turn. */
	readonly stopReason: string | null;
	/** Provider error text of that message when it failed: control characters removed, at most 300 characters. */
	readonly errorMessage: string | null;
}

/** Provider error text is diagnostic only; strip control characters and bound it before it reaches the artifact. */
function boundedError(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const text = value.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim();
	return text ? text.slice(0, 300) : null;
}

/**
 * Why a turn did not complete, or null. A host that aborted or failed the turn, or finalized no
 * assistant message, did not answer: the caller records a phase error, never a schema failure.
 */
export function hostStopReason(observation: Pick<TurnObservation, "assistantMessages" | "stopReason"> & { readonly errorMessage?: string | null }): string | null {
	if (observation.assistantMessages === 0) return "host produced no assistant message";
	if (observation.stopReason === "aborted" || observation.stopReason === "error") {
		const detail = observation.errorMessage ? `: ${observation.errorMessage}` : "";
		return `host stopped the turn (stopReason ${observation.stopReason}${detail})`;
	}
	return null;
}

interface ToolCallRef { readonly name: string; readonly args: Frame }

function numberOrNull(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asFrame(value: unknown): Frame | null {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Frame) : null;
}

/** Visible text of an assistant message; empty when the message carries only tool calls. */
function assistantText(message: Frame): string {
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	return message.content
		.map((block) => asFrame(block))
		.filter((block): block is Frame => block !== null && block.type === "text" && typeof block.text === "string")
		.map((block) => block.text as string)
		.join("\n");
}

/** The first text block of a tool result is the exact page; later blocks are the host envelope. */
function firstText(message: Frame): string {
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	const block = message.content.map((entry) => asFrame(entry)).find((entry) => entry?.type === "text" && typeof entry.text === "string");
	return typeof block?.text === "string" ? block.text : "";
}

/**
 * Whether a tool result is an original-text retrieval page. Zoom qualifies only at n=1 (an n>1
 * call returns child summaries); a result marked as an error never qualifies.
 */
export function isOriginalPage(toolName: string, args: Frame, message: Frame): boolean {
	if (message.isError === true) return false;
	if (toolName === "zoom") return args.n === 1;
	return toolName === "work";
}

/**
 * Main-model usage and retrieved pages from one prompt's events. Only finalized assistant
 * messages count; a missing counter stays null. Pages are the original text returned by zoom (n=1)
 * or work, keyed by the record id the tool addressed.
 */
export function observeTurn(events: readonly Frame[], price: { input: number; output: number; cacheRead: number; cacheWrite: number } | null): TurnObservation {
	let answer = "";
	const zoomCalls: { id: number | null; n: number | null; offset: number | null }[] = [];
	const calls = new Map<string, ToolCallRef>();
	const pages: RetrievedPage[] = [];
	const usage: UsageRecord[] = [];
	let assistantMessages = 0;
	let stopReason: string | null = null;
	let errorMessage: string | null = null;
	for (const event of events) {
		if (event.type !== "message_end") continue;
		const message = asFrame(event.message);
		if (!message) continue;
		if (message.role === "assistant") {
			assistantMessages++;
			stopReason = typeof message.stopReason === "string" ? message.stopReason : null;
			errorMessage = boundedError(message.errorMessage);
			const text = assistantText(message);
			if (text.trim()) answer = text;
			for (const block of Array.isArray(message.content) ? message.content : []) {
				const call = asFrame(block);
				if (!call || (call.type !== "toolCall" && call.type !== "tool_use") || typeof call.id !== "string") continue;
				const args = asFrame(call.arguments) ?? {};
				const name = typeof call.name === "string" ? call.name : "";
				calls.set(call.id, { name, args });
				if (name === "zoom") {
					zoomCalls.push({ id: numberOrNull(args.id), n: numberOrNull(args.n), offset: numberOrNull(args.offset) });
				}
			}
			usage.push(mainUsage(message, price));
		} else if (message.role === "toolResult" && typeof message.toolCallId === "string") {
			const ref = calls.get(message.toolCallId);
			if (!ref || (ref.name !== "zoom" && ref.name !== "work")) continue;
			if (!isOriginalPage(ref.name, ref.args, message)) continue;
			const details = asFrame(message.details) ?? {};
			// Work addresses records by name; its details name the message id the store resolved.
			const recordId = ref.name === "zoom" ? numberOrNull(ref.args.id) : numberOrNull(details.messageId);
			if (recordId === null) continue;
			pages.push({ recordId, text: firstText(message) });
		}
	}
	return { answer, zoomCalls, pages, usage, assistantMessages, stopReason, errorMessage };
}

/**
 * Per-message main usage. The cost is the SDK-reported figure when the message carries one, which
 * is not a provider invoice; otherwise a catalog-rate estimate; otherwise unavailable. Latency is
 * not apportioned to messages: the runner records wall-clock per prompt instead.
 */
function mainUsage(message: Frame, price: { input: number; output: number; cacheRead: number; cacheWrite: number } | null): UsageRecord {
	const counters = asFrame(message.usage);
	const cost = asFrame(counters?.cost);
	const base = {
		role: "main" as const,
		purpose: "turn",
		input: numberOrNull(counters?.input),
		output: numberOrNull(counters?.output),
		cacheRead: numberOrNull(counters?.cacheRead),
		cacheWrite: numberOrNull(counters?.cacheWrite),
		latencyMs: null,
	};
	const reported = numberOrNull(cost?.total);
	if (reported !== null) return { ...base, costUsd: reported, costSource: "sdk-reported" };
	const { input, output, cacheRead, cacheWrite } = base;
	if (price && input !== null && output !== null && cacheRead !== null && cacheWrite !== null) {
		const estimate = (input * price.input + output * price.output + cacheRead * price.cacheRead + cacheWrite * price.cacheWrite) / 1_000_000;
		return { ...base, costUsd: estimate, costSource: "catalog-estimate" };
	}
	return { ...base, costUsd: null, costSource: "unavailable" };
}

export interface DurableRecord {
	readonly i: number;
	readonly kind: string;
	readonly text: string;
	readonly date: string;
}

/** Durable main-store records. Read-only; the runner never writes memory directly. */
export async function readDurableRecords(directory: string): Promise<DurableRecord[]> {
	const files: string[] = [];
	const walk = async (path: string): Promise<void> => {
		let entries: Dirent[];
		try {
			entries = await readdir(path, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const child = join(path, entry.name);
			if (entry.isDirectory()) await walk(child);
			else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(child);
		}
	};
	await walk(directory);
	const records: DurableRecord[] = [];
	for (const file of files.sort()) {
		for (const line of (await readFile(file, "utf8")).split("\n")) {
			if (!line.trim()) continue;
			let value: unknown;
			try {
				value = JSON.parse(line);
			} catch {
				continue;
			}
			const frame = asFrame(value);
			if (frame && typeof frame.i === "number" && typeof frame.kind === "string" && typeof frame.text === "string" && typeof frame.date === "string") {
				records.push({ i: frame.i, kind: frame.kind, text: frame.text, date: frame.date });
			}
		}
	}
	return records.sort((a, b) => a.i - b.i);
}

/** One saved tiling part as the store writes it: [level, index] spans [index·2^level, (index+1)·2^level). */
export type TilingPart = readonly [number, number];

/**
 * Distinct saved tree-node levels. Level 0 is a leaf (possibly unbuilt), so only levels >= 1 name
 * saved tree nodes; the level is the part's first coordinate, never a log of its length.
 */
export function treeLevels(parts: readonly TilingPart[]): number[] {
	const levels = new Set<number>();
	for (const [level] of parts) if (level >= 1) levels.add(level);
	return [...levels].sort((a, b) => a - b);
}

function isTilingPart(node: unknown): node is TilingPart {
	return Array.isArray(node) && node.length === 2 && Number.isSafeInteger(node[0]) && (node[0] as number) >= 0 && Number.isSafeInteger(node[1]) && (node[1] as number) >= 0;
}

export interface TreeStructure {
	readonly mainLength: number;
	readonly compactorLength: number;
	readonly mainParts: number;
	readonly compactorParts: number;
	readonly levels: number[];
}

/**
 * Tree structure from the persisted view.json (ViewSnapshot v2). Only v2 snapshots are read: the
 * store writes nothing else. Returns null before the first save or when the file is not v2.
 */
export async function readTreeStructure(directory: string): Promise<TreeStructure | null> {
	let raw: string;
	try {
		raw = await readFile(join(directory, "view.json"), "utf8");
	} catch {
		return null;
	}
	const value = asFrame(JSON.parse(raw));
	if (!value || value.version !== 2 || typeof value.length !== "number") return null;
	const compactor = asFrame(value.compactor);
	const parts = Array.isArray(value.parts) ? value.parts.filter(isTilingPart) : [];
	const compactorParts = Array.isArray(compactor?.parts) ? compactor.parts.filter(isTilingPart) : [];
	return {
		mainLength: value.length,
		compactorLength: typeof compactor?.length === "number" ? compactor.length : 0,
		mainParts: parts.length,
		compactorParts: compactorParts.length,
		levels: treeLevels([...parts, ...compactorParts]),
	};
}

/**
 * Compressor admissions dispatched so far, from the per-host counter file. The host increments it
 * before each provider attempt, so this counts attempts including failed and shutdown work.
 */
export async function readAdmissionDispatched(file: string): Promise<number> {
	const parsed = asFrame(JSON.parse(await readFile(file, "utf8")));
	if (!parsed || typeof parsed.dispatched !== "number" || !Number.isSafeInteger(parsed.dispatched) || parsed.dispatched < 0) {
		throw new Error("admission counter is malformed");
	}
	return parsed.dispatched;
}

export interface MetricLine {
	readonly model: string;
	readonly input: number | null;
	readonly output: number | null;
	readonly cacheRead: number | null;
	readonly cacheWrite: number | null;
	readonly attempt: number | null;
	readonly purpose: "leaf" | "shorten" | null;
	readonly latencyMs: number | null;
	readonly costUsd: number | null;
	readonly stopReason: string | null;
	readonly error: string | null;
}

/** Creates the metric sink empty before launch: an empty file is zero completed calls; no file is no host run. */
export async function initMetricsFile(file: string): Promise<void> {
	await writeFile(file, "", { flag: "wx", mode: 0o600 });
}

/** Metric-only compressor sink; null when the host never wrote it (unavailable, not zero). */
export async function readMetricLines(file: string): Promise<MetricLine[] | null> {
	let raw: string;
	try {
		raw = await readFile(file, "utf8");
	} catch {
		return null;
	}
	return raw.split("\n").filter((line) => line.trim()).map((line) => {
		const value = asFrame(JSON.parse(line)) ?? {};
		return {
			model: typeof value.model === "string" ? value.model : "",
			input: numberOrNull(value.input),
			output: numberOrNull(value.output),
			cacheRead: numberOrNull(value.cacheRead),
			cacheWrite: numberOrNull(value.cacheWrite),
			attempt: numberOrNull(value.attempt),
			purpose: value.purpose === "leaf" || value.purpose === "shorten" ? value.purpose : null,
			latencyMs: numberOrNull(value.latencyMs),
			costUsd: numberOrNull(value.costUsd),
			stopReason: typeof value.stopReason === "string" ? value.stopReason : null,
			error: typeof value.error === "string" ? value.error : null,
		};
	});
}

/** Failed compressor calls grouped by provider error text, for diagnostics; empty when none failed. */
export function compressorFailures(lines: readonly MetricLine[] | null): string {
	const counts = new Map<string, number>();
	for (const line of lines ?? []) {
		if (line.stopReason !== "error" && line.stopReason !== "aborted") continue;
		const key = line.error ?? `stopReason ${line.stopReason}`;
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	return [...counts].map(([error, count]) => `${count}× ${error}`).join("; ");
}
