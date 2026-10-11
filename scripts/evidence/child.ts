import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { UsageRecord } from "./artifact.ts";
import { initialAdmission } from "./admission.ts";
import type { Corpus, Question } from "./corpus.ts";
import { compressorFailures, hostStopReason, initMetricsFile, observeTurn, readAdmissionCounts, readMetricLines, RpcHost, type Frame, type HostLaunch } from "./host.ts";
import { answerInstruction, scoreAnswers, type Failure, type Outcome, type RetrievedPage } from "./scoring.ts";

/**
 * #13 child memory experiment. Each task runs on its own fresh parent host with OptChat on and the
 * built-in `task` tool. The parent must delegate the question to a subagent. The `view` arm passes
 * `--optchat-child-view`, the `blind` arm does not. Grading uses the child's delegated output only.
 */

export type ChildArm = "view" | "blind";

export type ChildStatus = "completed" | "not-delegated" | "incomplete" | "failed" | "refused";

/**
 * What a task did to the spend ledger. `none`: no child ran (refused, host ended, or no task call).
 * `observed`: a child ran and its cost is reported. `unobserved`: a child may have run without a reported cost.
 */
export type ChildSpend = "none" | "observed" | "unobserved";

/** Files for one task's host: its own store copy, session, metrics and admission sinks, and the overlay. */
export interface TaskFiles {
	readonly memory: string;
	readonly sessionDir: string;
	readonly metricsFile: string;
	readonly admissionFile: string;
	readonly overlayFile: string;
}

/** Host launch with the child-experiment fields. host.ts honors each of them in launchArgs. */
export interface ChildHostLaunch extends HostLaunch {
	/** false → `--no-optchat`. Both arms run with OptChat on. */
	readonly optchat: boolean;
	/** Appended after the common flags. */
	readonly extraArgs: readonly string[];
	/** `["task"]` for this experiment. */
	readonly tools: readonly string[] | null;
}

/**
 * Caller's host settings for an arm, without the per-task files, which this module creates for every task.
 * `extraArgs` is optional; this module sets `--optchat-child-view` and the overlay itself.
 */
export type ArmBase = Omit<HostLaunch, "optchat" | "extraArgs" | "tools" | "memory" | "sessionDir" | "metricsFile" | "admissionFile"> & {
	readonly extraArgs?: readonly string[];
};

export interface Price {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
}

export interface ChildTask {
	readonly id: string;
	readonly questionId: string;
	readonly kind: string;
	readonly question: Question;
	/** Text the parent passes verbatim to the subagent's `task`. */
	readonly task: string;
}

/**
 * The child run's usage, from the task tool result's `details.results[0]` (the child's own
 * message_end aggregate). Each counter is null only when the host omitted it.
 */
export interface ChildUsage {
	/** Child assistant requests (`requests`). */
	readonly calls: number | null;
	readonly input: number | null;
	readonly output: number | null;
	readonly cacheRead: number | null;
	readonly cacheWrite: number | null;
	readonly totalTokens: number | null;
	/** SDK-reported `usage.cost.total`; null when the host omitted it. Never a catalog estimate here. */
	readonly costUsd: number | null;
	readonly costSource: "sdk-reported" | "unavailable";
	readonly latencyMs: number | null;
	readonly model: string | null;
	/** True when the child was aborted: the counters are the partial run's, not a completed run's. */
	readonly aborted: boolean;
}

export const DEFAULT_CHILD_TASKS = 4;
const PREVIEW_CHARS = 240;
/** Markers the host writes when a child output is a preview or pointer, not the full answer. */
const POINTER_MARKER = /\[Output truncated|full-output="agent:\/\/|Full output: artifact:\/\//;

export interface ChildTaskOutcome {
	readonly taskId: string;
	readonly questionId: string;
	readonly kind: string;
	readonly status: ChildStatus;
	readonly reason: string | null;
	/** Child answered and the value is right, with no forbidden or superseded value asserted. */
	readonly success: boolean;
	/** Value rules only (citations excluded). Null when the child never completed. */
	readonly valueCorrect: boolean | null;
	readonly outcome: Outcome | null;
	readonly failure: Failure | null;
	/** Null unless the child's retrieval was observed in the parent stream. */
	readonly grounded: boolean | null;
	/** Nested-event counts, or task-progress lower bounds. Unobserved retrieval is null, never inferred zero. */
	readonly childZoomCalls: number | null;
	readonly childWorkCalls: number | null;
	readonly childDateCalls: number | null;
	/** Progress snapshots retain only recent tools; counts derived from them are observed lower bounds. */
	readonly childRetrievalSource: "nested-events" | "task-progress" | null;
	readonly childOutputPreview: string | null;
	/** Null only when the task result carries no child details at all. */
	readonly childUsage: ChildUsage | null;
	/** Whether the parent issued a task call. Without one, no child ran. */
	readonly childTaskIssued: boolean;
	readonly spend: ChildSpend;
	/** Main-model usage of the parent's own turns for this task (nested child messages excluded). */
	readonly parentUsage: UsageRecord[];
	/** The parent turn's host stop reason (with bounded error text) when it did not complete; null when it completed. */
	readonly parentStopReason: string | null;
	/** Last observed memory state when the copied store did not settle, so no prompt was sent; null otherwise. */
	readonly setupDiagnostic: string | null;
	/** Compressor admissions refused by the host's counter, read before the host stopped; null when not read. */
	readonly admissionsRefused: number | null;
	/** Failed compressor calls grouped by provider error, read before the host stopped; empty when none. */
	readonly compressorFailures: string;
}

export interface ChildArmResult {
	readonly arm: ChildArm;
	readonly outcomes: readonly ChildTaskOutcome[];
	readonly summary: {
		readonly tasks: number;
		readonly delegated: number;
		readonly completed: number;
		readonly succeeded: number;
		readonly refused: number;
	};
}

/** Child spend a task adds to the ledger: 0 when no child ran, its reported cost when observed, null when unobserved. */
export function childSpendUsd(outcome: ChildTaskOutcome): number | null {
	if (outcome.spend === "none") return 0;
	if (outcome.spend === "observed") return outcome.childUsage?.costUsd ?? null;
	return null;
}

function asFrame(value: unknown): Frame | null {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Frame) : null;
}

/**
 * The child's final text. A schema-typed `yield` reaches the parent as its bare JSON object, which is the answer block
 * unfenced, so it is fenced for the parser. A schemaless `yield` reaches the parent JSON-encoded (a string literal, with
 * escaped newlines and quotes), so a whole-string JSON literal is decoded to its value. Any other output is returned unchanged.
 */
function childText(output: string): string {
	const trimmed = output.trim();
	if (trimmed.startsWith("{") && trimmed.endsWith("}")) return ["```json", trimmed, "```"].join("\n");
	if (!trimmed.startsWith('"') || !trimmed.endsWith('"')) return output;
	try {
		const decoded: unknown = JSON.parse(trimmed);
		return typeof decoded === "string" ? decoded : output;
	} catch {
		return output;
	}
}

function numberOrNull(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Corpus questions as child tasks. Non-ambiguous questions only; round-robin over kinds in the
 * corpus's first-appearance order, so the selection is deterministic and spans kinds. Returns fewer
 * than `count` when the corpus cannot supply that many.
 */
export function deriveChildTasks(corpus: Corpus, count: number = DEFAULT_CHILD_TASKS): ChildTask[] {
	if (!Number.isSafeInteger(count) || count < 1) throw new RangeError("child task count must be a positive integer");
	const groups = new Map<string, Question[]>();
	for (const question of corpus.questions) {
		if (question.ambiguous) continue;
		const group = groups.get(question.kind);
		if (group) group.push(question);
		else groups.set(question.kind, [question]);
	}
	const queues = [...groups.values()];
	const tasks: ChildTask[] = [];
	for (let round = 0; tasks.length < count; round++) {
		let picked = false;
		for (const queue of queues) {
			const question = queue[round];
			if (question === undefined || tasks.length >= count) continue;
			tasks.push({ id: `task-${question.id}`, questionId: question.id, kind: question.kind, question, task: childTaskText(question) });
			picked = true;
		}
		if (!picked) break;
	}
	return tasks;
}

/** Child instruction: identical across arms. Only the view child has memory tools and a snapshot. */
export function childTaskText(question: Question): string {
	return [
		"Answer from the parent chat memory available to you. If you cannot establish the answer from it, mark the answer uncertain and cite nothing.",
		"",
		`Question: ${question.prompt}`,
		"",
		answerInstruction([question.id]),
	].join("\n");
}

/** Parent instruction: must delegate the task text verbatim and must not answer or retrieve itself. */
export function parentPrompt(task: ChildTask): string {
	return [
		"Delegate the task between the markers to one subagent with the task tool, exactly once. Pass its text verbatim. Do not answer it yourself, and do not call zoom, date, work, or chat_search.",
		"After the subagent finishes, reply with its final answer unchanged.",
		"<<<TASK",
		task.task,
		"TASK>>>",
	].join("\n");
}

/** Config overlay that keeps `task` synchronous, so the child result arrives in the tool result. */
export async function writeSyncTaskOverlay(file: string): Promise<void> {
	await writeFile(file, "async:\n  enabled: false\n", { mode: 0o600 });
}

/**
 * Host launch for one task of one arm. The overlay applies `async.enabled=false`. Caller extraArgs are kept,
 * except the child-view flag and an earlier overlay, which this function replaces.
 */
export function childLaunch(base: ArmBase, arm: ChildArm, files: TaskFiles): ChildHostLaunch {
	const extraArgs = (base.extraArgs ?? []).filter((arg) => arg !== "--optchat-child-view" && !arg.startsWith("--config="));
	if (arm === "view") extraArgs.push("--optchat-child-view");
	extraArgs.push(`--config=${files.overlayFile}`);
	return {
		...base,
		memory: files.memory,
		sessionDir: files.sessionDir,
		metricsFile: files.metricsFile,
		admissionFile: files.admissionFile,
		optchat: true,
		tools: ["task"],
		extraArgs,
	};
}

interface TaskCall {
	readonly id: string;
	/** Index of the earliest event naming the call: the parent's assistant message or its start event. */
	readonly first: number;
	/** Index of the completing event, or null when the host never finished the task. */
	end: number | null;
	result: Frame | null;
	isError: boolean;
}

function toolName(event: Frame): string {
	if (typeof event.toolName === "string") return event.toolName;
	if (typeof event.name === "string") return event.name;
	return "";
}

/** Every `task` call in the event slice, in order, with its completion. Both start and message frames name it. */
function taskCalls(events: readonly Frame[]): TaskCall[] {
	const calls = new Map<string, TaskCall>();
	const ensure = (id: string, index: number): void => {
		if (!calls.has(id)) calls.set(id, { id, first: index, end: null, result: null, isError: false });
	};
	events.forEach((event, index) => {
		if (event.type === "tool_execution_start" && toolName(event) === "task" && typeof event.toolCallId === "string") {
			ensure(event.toolCallId, index);
		} else if (event.type === "tool_execution_end" && typeof event.toolCallId === "string") {
			const call = calls.get(event.toolCallId);
			if (call && call.end === null) {
				const result = asFrame(event.result);
				call.end = index;
				call.result = result;
				call.isError = event.isError === true || result?.isError === true;
			}
		} else if (event.type === "message_end") {
			const message = asFrame(event.message);
			if (!message) return;
			if (message.role === "assistant" && Array.isArray(message.content)) {
				for (const block of message.content) {
					const call = asFrame(block);
					if (call && (call.type === "toolCall" || call.type === "tool_use") && call.name === "task" && typeof call.id === "string") ensure(call.id, index);
				}
			} else if (message.role === "toolResult" && typeof message.toolCallId === "string") {
				const call = calls.get(message.toolCallId);
				// Only fills in a completion the tool_execution_end frame did not already provide.
				if (call && call.end === null) {
					call.end = index;
					call.result = message;
					call.isError = message.isError === true;
				}
			}
		}
	});
	return [...calls.values()].sort((a, b) => a.first - b.first);
}

/** The single child result inside a task tool result, or null when the details do not carry exactly one. */
function singleChildResult(result: Frame | null): Frame | null {
	const results = asFrame(result?.details)?.results;
	if (!Array.isArray(results) || results.length !== 1) return null;
	return asFrame(results[0]);
}

/** Child usage from the task result's child entry. Null only when that entry (or its details) is absent. */
function childUsageOf(result: Frame | null): ChildUsage | null {
	const child = singleChildResult(result);
	if (child === null) return null;
	const usage = asFrame(child.usage);
	const reportedCost = numberOrNull(asFrame(usage?.cost)?.total);
	return {
		calls: numberOrNull(child.requests),
		input: numberOrNull(usage?.input),
		output: numberOrNull(usage?.output),
		cacheRead: numberOrNull(usage?.cacheRead),
		cacheWrite: numberOrNull(usage?.cacheWrite),
		totalTokens: numberOrNull(usage?.totalTokens),
		costUsd: reportedCost,
		costSource: reportedCost === null ? "unavailable" : "sdk-reported",
		latencyMs: numberOrNull(child.durationMs),
		model: typeof child.resolvedModel === "string" ? child.resolvedModel : null,
		aborted: child.aborted === true,
	};
}

function countCalls(events: readonly Frame[], name: string): number {
	const ids = new Set<string>();
	for (const event of events) {
		if (event.type === "tool_execution_start" && toolName(event) === name && typeof event.toolCallId === "string") ids.add(event.toolCallId);
		if (event.type !== "message_end") continue;
		const message = asFrame(event.message);
		if (!message || message.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const block of message.content) {
			const call = asFrame(block);
			if (call && (call.type === "toolCall" || call.type === "tool_use") && call.name === name && typeof call.id === "string") ids.add(call.id);
		}
	}
	return ids.size;
}

/** Whether any nested child frame was forwarded in the span. Without one, child calls are unobserved. */
function nestedObserved(span: readonly Frame[]): boolean {
	return span.some((event) => {
		if (event.type === "tool_execution_start") return true;
		if (event.type !== "message_end") return false;
		const role = asFrame(event.message)?.role;
		return role === "assistant" || role === "toolResult";
	});
}

function outcomeFor(task: ChildTask, fields: Partial<ChildTaskOutcome> & { status: ChildStatus }): ChildTaskOutcome {
	return {
		taskId: task.id,
		questionId: task.questionId,
		kind: task.kind,
		reason: null,
		success: false,
		valueCorrect: null,
		outcome: null,
		failure: null,
		grounded: null,
		childZoomCalls: null,
		childWorkCalls: null,
		childDateCalls: null,
		childRetrievalSource: null,
		childOutputPreview: null,
		childUsage: null,
		childTaskIssued: false,
		spend: "none",
		parentUsage: [],
		parentStopReason: null,
		setupDiagnostic: null,
		admissionsRefused: null,
		compressorFailures: "",
		...fields,
	};
}

/**
 * Grades one parent turn in which the task was delegated (or not). Pure: the caller supplies the
 * host's event frames for that prompt only. `knownIds` are the corpus ZX IDs.
 */
export function analyzeTaskTurn(input: {
	readonly task: ChildTask;
	readonly events: readonly Frame[];
	readonly knownIds: ReadonlySet<string>;
	readonly price: Price | null;
}): ChildTaskOutcome {
	const { task, events, knownIds, price } = input;
	const calls = taskCalls(events);

	if (calls.length === 0) {
		const parent = observeTurn(events, price);
		const stop = hostStopReason(parent);
		// A parent turn that never completed (aborted, errored, or with no assistant message) is a host failure, not a choice not to delegate.
		if (stop !== null) {
			return outcomeFor(task, { status: "incomplete", reason: `parent turn did not complete: ${stop}`, parentStopReason: stop, parentUsage: parent.usage });
		}
		// The parent answered on its own: never a child success, and no child ran.
		return outcomeFor(task, { status: "not-delegated", reason: "parent did not call the task tool", parentUsage: parent.usage });
	}
	if (calls.length > 1) {
		// Several children ran; one result cannot account for all of their cost.
		return outcomeFor(task, {
			status: "incomplete",
			reason: `parent issued ${calls.length} task calls for one question`,
			childTaskIssued: true,
			spend: "unobserved",
			parentUsage: observeTurn(events, price).usage,
		});
	}

	const [call] = calls as [TaskCall];
	const end = call.end ?? events.length;
	// Parent turns are the events up to and including the call-issuing message, plus everything after the task completes.
	const parentEvents = call.end === null ? events.slice(0, call.first + 1) : [...events.slice(0, call.first + 1), ...events.slice(call.end + 1)];
	const parent = observeTurn(parentEvents, price);
	// The task's own start frame sits inside the span; it is the parent's, not the child's.
	const span = events.slice(call.first + 1, end).filter((event) => event.toolCallId !== call.id);
	const observed = nestedObserved(span);
	const childPages: RetrievedPage[] = observed ? observeTurn(span, null).pages : [];
	const progressTools = new Map<string, string>();
	for (const event of events) {
		if (event.type !== "tool_execution_update" || event.toolCallId !== call.id) continue;
		const progress = asFrame(asFrame(event.partialResult)?.details)?.progress;
		if (!Array.isArray(progress)) continue;
		for (const entry of progress) {
			const agent = asFrame(entry);
			if (!agent || typeof agent.id !== "string" || !Array.isArray(agent.recentTools)) continue;
			for (const item of agent.recentTools) {
				const tool = asFrame(item);
				if (!tool || typeof tool.tool !== "string" || typeof tool.endMs !== "number") continue;
				progressTools.set(JSON.stringify([agent.id, tool.tool, tool.endMs, tool.args]), tool.tool);
			}
		}
	}
	const recentTools = [...progressTools.values()];
	const progressCount = (name: string): number | null => {
		const count = recentTools.filter((tool) => tool === name).length;
		return count > 0 ? count : null;
	};
	const childUsage = childUsageOf(call.result);
	const common = {
		parentStopReason: hostStopReason(parent),
		parentUsage: parent.usage,
		childZoomCalls: observed ? countCalls(span, "zoom") : progressCount("zoom"),
		childWorkCalls: observed ? countCalls(span, "work") : progressCount("work"),
		childDateCalls: observed ? countCalls(span, "date") : progressCount("date"),
		childRetrievalSource: observed ? ("nested-events" as const) : recentTools.length > 0 ? ("task-progress" as const) : null,
		childUsage,
		childTaskIssued: true,
		spend: childUsage !== null && childUsage.costUsd !== null ? ("observed" as const) : ("unobserved" as const),
	};

	if (call.end === null) {
		return outcomeFor(task, { ...common, status: "incomplete", reason: "task did not finish before the host stopped" });
	}
	if (call.isError) {
		return outcomeFor(task, { ...common, status: "failed", reason: "task reported an error" });
	}
	const stop = hostStopReason(parent);
	if (stop !== null) {
		return outcomeFor(task, { ...common, status: "incomplete", reason: `parent turn did not complete: ${stop}` });
	}
	const child = singleChildResult(call.result);
	if (child === null) {
		return outcomeFor(task, { ...common, status: "incomplete", reason: "task result does not carry exactly one child result" });
	}
	if (child.aborted === true) {
		return outcomeFor(task, { ...common, status: "incomplete", reason: "child was aborted" });
	}
	if (typeof child.error === "string" || (typeof child.exitCode === "number" && child.exitCode !== 0)) {
		return outcomeFor(task, { ...common, status: "failed", reason: "child reported an error" });
	}
	if (child.truncated === true) {
		return outcomeFor(task, { ...common, status: "incomplete", reason: "child output was truncated" });
	}
	const text = typeof child.output === "string" ? childText(child.output) : "";
	if (text.trim() === "") {
		return outcomeFor(task, { ...common, status: "incomplete", reason: "child returned no output" });
	}
	const preview = text.slice(0, PREVIEW_CHARS);
	if (POINTER_MARKER.test(text)) {
		return outcomeFor(task, {
			...common,
			status: "incomplete",
			reason: "child output delivered as a preview or pointer, not the full answer",
			childOutputPreview: preview,
		});
	}

	const scored = scoreAnswers({ questions: [task.question], raw: text, pages: childPages, knownIds });
	const judgement = scored.judgements[0]!;
	const forbiddenAsserted = judgement.assertedForbidden.length > 0;
	return outcomeFor(task, {
		...common,
		status: "completed",
		success: scored.schemaValid && judgement.valueCorrect && !forbiddenAsserted,
		valueCorrect: judgement.valueCorrect,
		outcome: judgement.outcome,
		failure: judgement.failure,
		// Retrieval is observed only when the child's nested events were forwarded; otherwise unknown, not ungrounded.
		grounded: observed ? judgement.grounded : null,
		childOutputPreview: preview,
	});
}

/** Inputs for one arm. `snapshot` is the settled seeded store: it is copied for every task and never written. */
export interface ChildArmInput {
	readonly arm: ChildArm;
	readonly launch: ArmBase;
	readonly extension: string;
	readonly tasks: readonly ChildTask[];
	readonly knownIds: ReadonlySet<string>;
	readonly snapshot: string;
	/** Private scratch root: one directory per task, removed before the task's outcome is returned. */
	readonly workRoot: string;
	/** Worst-case dollar bound for one task: its parent turn plus the child run, from catalog rates and token caps. */
	readonly taskReserveUsd: number;
	/** Called before each task with `taskReserveUsd`. A non-null string refuses that task. */
	readonly admit: (reserveUsd: number) => string | null;
	readonly promptTimeoutMs: number;
	readonly price: Price | null;
	/**
	 * Settles one task's copied memory on its ready host, before the task prompt. Null once settled; a string is the last
	 * observed state. Deadline errors propagate.
	 */
	readonly settle: (files: TaskFiles) => Promise<string | null>;
	/** Called once per admitted task, after it ends, so its reserve can be replaced by observed spend before the next task. */
	readonly taskDone: (outcome: ChildTaskOutcome) => void;
}

/**
 * One task on its own fresh host: a private copy of the snapshot, its own session, metric and admission sinks.
 * The host is always stopped and the copy removed before this resolves, even on failure.
 */
async function runTask(input: ChildArmInput, task: ChildTask, overlayFile: string): Promise<ChildTaskOutcome> {
	const directory = join(input.workRoot, task.id);
	const files: TaskFiles = {
		memory: join(directory, "memory"),
		sessionDir: join(directory, "session"),
		metricsFile: join(directory, "metrics.jsonl"),
		admissionFile: join(directory, "admission.json"),
		overlayFile,
	};
	try {
		await mkdir(files.sessionDir, { recursive: true, mode: 0o700 });
		await cp(input.snapshot, files.memory, { recursive: true });
		await initMetricsFile(files.metricsFile);
		await writeFile(files.admissionFile, JSON.stringify(initialAdmission()), { flag: "wx", mode: 0o600 });
		const host = new RpcHost(childLaunch(input.launch, input.arm, files), input.extension);
		try {
			// Ready barrier: the host has opened its session, so OptChat has the copied store before memory is judged.
			let ready = true;
			try {
				await host.effectiveSystemPrompt(input.promptTimeoutMs);
			} catch {
				// Startup detail may carry provider or path text, so only the fact of failure is recorded.
				ready = false;
			}
			const setup = ready ? await input.settle(files) : "host did not become ready";
			if (setup !== null) {
				// OptChat refuses a prompt sent before its summaries settle, so no prompt is sent and the task has no parent turn.
				return outcomeFor(task, {
					status: "incomplete",
					reason: "memory did not settle before the prompt; no prompt was sent",
					setupDiagnostic: setup,
					...(await taskDiagnostics(files)),
				});
			}
			let promptFailed = false;
			try {
				await host.prompt(parentPrompt(task), input.promptTimeoutMs);
			} catch {
				// The error text may carry provider detail, so only the fact of failure is recorded. A child may have run.
				promptFailed = true;
			}
			// Read at failure time, before the host stops: shutdown work must not be blamed on this task's turn.
			const diagnostics = await taskDiagnostics(files);
			const analyzed = analyzeTaskTurn({ task, events: host.events, knownIds: input.knownIds, price: input.price });
			if (!promptFailed) return { ...analyzed, ...diagnostics };
			return outcomeFor(task, {
				status: "incomplete",
				reason: "host error during the prompt",
				childTaskIssued: analyzed.childTaskIssued,
				spend: "unobserved",
				parentUsage: analyzed.parentUsage,
				childUsage: analyzed.childUsage,
				parentStopReason: analyzed.parentStopReason,
				...diagnostics,
			});
		} finally {
			await host.stop();
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

/** Admission refusals and compressor failures for one task's host. Read before the host stops, so shutdown work is excluded. */
async function taskDiagnostics(files: TaskFiles): Promise<Pick<ChildTaskOutcome, "admissionsRefused" | "compressorFailures">> {
	const { refused } = await readAdmissionCounts(files.admissionFile);
	return { admissionsRefused: refused, compressorFailures: compressorFailures(await readMetricLines(files.metricsFile)) };
}

/**
 * Runs one arm: each task on its own host, in sequence. Each task is admitted with its worst-case
 * reserve before it starts; a non-null admit result refuses it. Each admitted task reports to `taskDone` when it ends.
 */
export async function runChildArm(input: ChildArmInput): Promise<ChildArmResult> {
	const { arm, tasks } = input;
	if (!Number.isFinite(input.taskReserveUsd) || input.taskReserveUsd < 0) {
		throw new RangeError("taskReserveUsd must be a finite, nonnegative number");
	}
	await mkdir(input.workRoot, { recursive: true, mode: 0o700 });
	const overlayFile = join(input.workRoot, "child-overlay.yml");
	await writeSyncTaskOverlay(overlayFile);
	const outcomes: ChildTaskOutcome[] = [];
	for (const task of tasks) {
		const refusal = input.admit(input.taskReserveUsd);
		if (refusal !== null) {
			outcomes.push(outcomeFor(task, { status: "refused", reason: refusal }));
			continue;
		}
		const outcome = await runTask(input, task, overlayFile);
		outcomes.push(outcome);
		input.taskDone(outcome);
	}
	return {
		arm,
		outcomes,
		summary: {
			tasks: outcomes.length,
			delegated: outcomes.filter((outcome) => outcome.childTaskIssued).length,
			completed: outcomes.filter((outcome) => outcome.status === "completed").length,
			succeeded: outcomes.filter((outcome) => outcome.success).length,
			refused: outcomes.filter((outcome) => outcome.status === "refused").length,
		},
	};
}

/* ------------------------------------------------------------------------------------------------
 * Scripted fixture reply for the offline e2e lives in fixture-provider.ts (childFixtureResponse).
 * ------------------------------------------------------------------------------------------------ */
