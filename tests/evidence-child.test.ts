import { describe, expect, test } from "bun:test";
import { buildCorpus, type Corpus, type Question } from "../scripts/evidence/corpus.ts";
import {
	analyzeTaskTurn,
	childLaunch,
	childSpendUsd,
	childTaskText,
	deriveChildTasks,
	parentPrompt,
	type ArmBase,
	type ChildTask,
	type TaskFiles,
} from "../scripts/evidence/child.ts";
import { childFixtureResponse } from "../scripts/fixture-provider.ts";
import { parseAnswerSet, scoreAnswers, type RetrievedPage } from "../scripts/evidence/scoring.ts";
import type { Frame } from "../scripts/evidence/host.ts";

const corpus: Corpus = buildCorpus({ seed: 7, projects: 3, sourceCount: 24, minSourceBytes: 512 });
const knownIds = new Set(corpus.knownIds);

function questionOf(kind: string): Question {
	const question = corpus.questions.find((candidate) => candidate.kind === kind && !candidate.ambiguous);
	if (!question) throw new Error(`corpus has no ${kind} question`);
	return question;
}

function taskFor(question: Question): ChildTask {
	return { id: `task-${question.id}`, questionId: question.id, kind: question.kind, question, task: childTaskText(question) };
}

function parentMessage(text: string): Frame {
	return {
		type: "message_end",
		message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text }], usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } } },
	};
}

function callMessage(id: string, name: string, args: Frame, input: number): Frame {
	return {
		type: "message_end",
		message: {
			role: "assistant",
			stopReason: "toolUse",
			content: [{ type: "toolCall", id, name, arguments: args }],
			usage: { input, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } },
		},
	};
}

function startEvent(id: string): Frame {
	return { type: "tool_execution_start", toolName: "task", toolCallId: id };
}

/** A task completion whose structured child entry carries the child's output and usage; `child` overrides fields. */
function endEvent(id: string, text: string, isError = false, child: Frame = {}): Frame {
	const usage = { input: 20, output: 8, cacheRead: 0, cacheWrite: 0, totalTokens: 28, cost: { total: 0.002 } };
	const entry = { output: text, exitCode: 0, truncated: false, requests: 1, durationMs: 1500, resolvedModel: "provider/child", usage, ...child };
	return { type: "tool_execution_end", toolCallId: id, isError, result: { content: [{ type: "text", text }], details: { results: [entry] } } };
}

function answerFence(id: string, value: string | null, uncertain: boolean, citations: { recordId: number; quote: string }[]): string {
	return ["```json", JSON.stringify({ answers: [{ id, value, uncertain, citations }] }), "```"].join("\n");
}

/** Events of one delegated turn: the parent's call, optional nested child frames, the task result, and the parent's relay. */
function delegatedTurn(task: ChildTask, output: string, nested: Frame[] = [], isError = false, child: Frame = {}): Frame[] {
	const id = "call-1";
	return [
		callMessage(id, "task", { tasks: [{ task: task.task }] }, 10),
		startEvent(id),
		...nested,
		endEvent(id, output, isError, child),
		parentMessage("Relayed the subagent answer."),
	];
}

describe("deriveChildTasks", () => {
	test("is deterministic, skips ambiguous questions, and spans distinct kinds", () => {
		const first = deriveChildTasks(corpus, 4);
		const second = deriveChildTasks(corpus, 4);
		expect(second.map((task) => task.id)).toEqual(first.map((task) => task.id));
		expect(first).toHaveLength(4);
		expect(first.every((task) => !task.question.ambiguous)).toBe(true);
		expect(new Set(first.map((task) => task.kind)).size).toBe(4);
		expect(new Set(first.map((task) => task.questionId)).size).toBe(4);
	});

	test("returns every non-ambiguous question when the count exceeds supply, and rejects invalid counts", () => {
		const available = corpus.questions.filter((question) => !question.ambiguous).length;
		expect(deriveChildTasks(corpus, 1000)).toHaveLength(available);
		expect(() => deriveChildTasks(corpus, 0)).toThrow(RangeError);
		expect(() => deriveChildTasks(corpus, 1.5)).toThrow(RangeError);
	});

	test("child and parent text carry the question and the strict answer schema, and the parent must delegate verbatim", () => {
		const question = questionOf("correction");
		const task = taskFor(question);
		expect(task.task).toContain(question.prompt);
		expect(task.task).toContain(question.id);
		const prompt = parentPrompt(task);
		expect(prompt).toContain(`<<<TASK\n${task.task}\nTASK>>>`);
		expect(prompt).toContain("Do not answer it yourself");
	});
});

describe("childLaunch and overlay", () => {
	const base: ArmBase = {
		omp: "omp",
		plugin: "plugin",
		cwd: "cwd",
		main: "provider/main",
		compressor: "provider/compressor",
		allowance: 0,
		usdAllowance: 0,
		usdPerCall: 0,
		usdPerFallbackCall: 0,
		compressorMaxTokens: 512,
		viewBytes: 4096,
		env: {},
	};
	const files: TaskFiles = {
		memory: "task/memory",
		sessionDir: "task/session",
		metricsFile: "task/metrics.jsonl",
		admissionFile: "task/admission.json",
		overlayFile: "work/child-overlay.yml",
	};

	test("view arm adds the child-view flag, blind arm opts out; both keep OptChat on, tools to task, and per-task files", () => {
		const view = childLaunch(base, "view", files);
		const blind = childLaunch(base, "blind", files);
		expect(view).toMatchObject({ optchat: true, tools: ["task"], memory: "task/memory", sessionDir: "task/session", metricsFile: "task/metrics.jsonl", admissionFile: "task/admission.json" });
		expect(view.extraArgs).toEqual(["--optchat-child-view", "--config=work/child-overlay.yml"]);
		expect(blind).toMatchObject({ optchat: true, tools: ["task"] });
		expect(blind.extraArgs).toEqual(["--no-optchat-child-view", "--config=work/child-overlay.yml"]);
	});

	test("preserves fixture extension arguments while normalizing the arm flag and overlay", () => {
		const configured: ArmBase = { ...base, extraArgs: ["-e", "fixture.ts", "--optchat-child-view", "--no-optchat-child-view", "--config=stale.yml"] };
		expect(childLaunch(configured, "view", files).extraArgs).toEqual(["-e", "fixture.ts", "--optchat-child-view", "--config=work/child-overlay.yml"]);
		expect(childLaunch(configured, "blind", files).extraArgs).toEqual(["-e", "fixture.ts", "--no-optchat-child-view", "--config=work/child-overlay.yml"]);
	});
});

describe("analyzeTaskTurn", () => {
	test("a delegated, correct, grounded child answer succeeds; parent usage excludes nested child messages", () => {
		const question = questionOf("correction");
		const task = taskFor(question);
		const source = corpus.sources[question.sources[0]!.recordId]!;
		const output = answerFence(question.id, question.expect.join(" "), false, [{ recordId: source.recordId, quote: source.text }]);
		const nested = [
			callMessage("call-1-zoom", "zoom", { id: source.recordId, n: 1 }, 999),
			{ type: "message_end", message: { role: "toolResult", toolCallId: "call-1-zoom", content: [{ type: "text", text: source.text }], details: {} } },
		];
		const outcome = analyzeTaskTurn({ task, events: delegatedTurn(task, output, nested), knownIds, price: null });
		expect(outcome.status).toBe("completed");
		expect(outcome.success).toBe(true);
		expect(outcome.valueCorrect).toBe(true);
		expect(outcome.grounded).toBe(true);
		expect(outcome.childZoomCalls).toBe(1);
		expect(outcome.childWorkCalls).toBe(0);
		expect(outcome.childUsage).toMatchObject({ calls: 1, input: 20, costUsd: 0.002, costSource: "sdk-reported", aborted: false });
		expect(outcome.parentUsage.map((record) => record.input)).toEqual([10, 10]);
	});

	test("a child that cites the superseded owner fails, and the superseded value is recorded as a hallucination", () => {
		const question = questionOf("correction");
		const task = taskFor(question);
		const stale = question.forbid[0];
		expect(stale).toBeDefined();
		const source = corpus.sources[question.sources[0]!.recordId]!;
		const output = answerFence(question.id, stale!, false, [{ recordId: source.recordId, quote: source.text }]);
		const nested = [
			callMessage("call-1-zoom", "zoom", { id: source.recordId, n: 1 }, 999),
			{ type: "message_end", message: { role: "toolResult", toolCallId: "call-1-zoom", content: [{ type: "text", text: source.text }], details: {} } },
		];
		const outcome = analyzeTaskTurn({ task, events: delegatedTurn(task, output, nested), knownIds, price: null });
		expect(outcome.status).toBe("completed");
		expect(outcome.success).toBe(false);
		expect(outcome.valueCorrect).toBe(false);
		expect(outcome.outcome).toBe("hallucinated");
	});

	test("a parent turn that never completed is incomplete with its stop reason, not a not-delegated model choice", () => {
		const question = questionOf("minor-fact");
		const task = taskFor(question);
		const aborted: Frame = {
			type: "message_end",
			message: { role: "assistant", stopReason: "aborted", errorMessage: "request aborted by host", content: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } },
		};
		const outcome = analyzeTaskTurn({ task, events: [aborted], knownIds, price: null });
		expect(outcome.status).toBe("incomplete");
		expect(outcome.parentStopReason).toContain("aborted");
		expect(outcome.reason).toContain("aborted");
		expect(outcome.childTaskIssued).toBe(false);
		expect(outcome.spend).toBe("none");
		const empty = analyzeTaskTurn({ task, events: [], knownIds, price: null });
		expect(empty.status).toBe("incomplete");
		expect(empty.parentStopReason).toBe("host produced no assistant message");
	});

	test("a parent that answers without calling task is not-delegated, never a success, and no child ran", () => {
		const question = questionOf("minor-fact");
		const task = taskFor(question);
		const outcome = analyzeTaskTurn({
			task,
			events: [parentMessage(answerFence(question.id, question.expect.join(" "), false, []))],
			knownIds,
			price: null,
		});
		expect(outcome.status).toBe("not-delegated");
		expect(outcome.parentStopReason).toBeNull();
		expect(outcome.success).toBe(false);
		expect(outcome.valueCorrect).toBeNull();
		expect(outcome.childTaskIssued).toBe(false);
		expect(outcome.spend).toBe("none");
		expect(childSpendUsd(outcome)).toBe(0);
		expect(outcome.parentUsage).toHaveLength(1);
	});

	test("an uncertain child answer abstains and does not succeed", () => {
		const question = questionOf("minor-fact");
		const task = taskFor(question);
		const outcome = analyzeTaskTurn({ task, events: delegatedTurn(task, answerFence(question.id, null, true, [])), knownIds, price: null });
		expect(outcome.status).toBe("completed");
		expect(outcome.success).toBe(false);
		expect(outcome.outcome).toBe("abstained");
	});

	test("a right value without retrieval observed succeeds, with grounding unknown rather than false", () => {
		const question = questionOf("minor-fact");
		const task = taskFor(question);
		const outcome = analyzeTaskTurn({
			task,
			events: delegatedTurn(task, answerFence(question.id, question.expect.join(" "), false, [])),
			knownIds,
			price: null,
		});
		expect(outcome.success).toBe(true);
		expect(outcome.childZoomCalls).toBeNull();
		expect(outcome.childWorkCalls).toBeNull();
		expect(outcome.grounded).toBeNull();
	});

	test("malformed child output fails on schema and never succeeds", () => {
		const question = questionOf("minor-fact");
		const task = taskFor(question);
		const outcome = analyzeTaskTurn({ task, events: delegatedTurn(task, `the answer is ${question.expect.join(" ")}`), knownIds, price: null });
		expect(outcome.status).toBe("completed");
		expect(outcome.success).toBe(false);
		expect(outcome.failure).toBe("schema");
	});

	test("a task that errored, never finished, or returned only a preview is not a completed answer", () => {
		const question = questionOf("minor-fact");
		const task = taskFor(question);
		const correct = answerFence(question.id, question.expect.join(" "), false, []);

		const failed = analyzeTaskTurn({ task, events: delegatedTurn(task, correct, [], true), knownIds, price: null });
		expect(failed.status).toBe("failed");
		expect(failed.success).toBe(false);

		const unfinished = analyzeTaskTurn({ task, events: [callMessage("call-1", "task", {}, 10), startEvent("call-1")], knownIds, price: null });
		expect(unfinished.status).toBe("incomplete");
		expect(unfinished.success).toBe(false);

		const preview = analyzeTaskTurn({
			task,
			events: delegatedTurn(task, `${correct}\n[Output truncated. Showing first 240 characters]`),
			knownIds,
			price: null,
		});
		expect(preview.status).toBe("incomplete");
		expect(preview.success).toBe(false);
		expect(preview.childOutputPreview).not.toBeNull();
	});

	test("two task calls for one question are recorded as incomplete, not scored from either", () => {
		const question = questionOf("minor-fact");
		const task = taskFor(question);
		const events = [
			callMessage("call-1", "task", {}, 10),
			startEvent("call-1"),
			endEvent("call-1", answerFence(question.id, question.expect.join(" "), false, [])),
			callMessage("call-2", "task", {}, 10),
			startEvent("call-2"),
			endEvent("call-2", answerFence(question.id, question.expect.join(" "), false, [])),
		];
		const outcome = analyzeTaskTurn({ task, events, knownIds, price: null });
		expect(outcome.status).toBe("incomplete");
		expect(outcome.success).toBe(false);
		expect(outcome.spend).toBe("unobserved");
		expect(childSpendUsd(outcome)).toBeNull();
	});

	test("task progress proves zoom/date/work without pretending absent tools are zero", () => {
		const question = questionOf("minor-fact");
		const task = taskFor(question);
		const correct = answerFence(question.id, question.expect.join(" "), false, []);
		const recentTools = [
			{ tool: "zoom", args: "id=0", endMs: 10 },
			{ tool: "date", args: "", endMs: 11 },
			{ tool: "work", args: "report", endMs: 12 },
		];
		const update = { type: "tool_execution_update", toolCallId: "call-1", partialResult: { details: { progress: [{ id: "ChildAnswer", recentTools }] } } };
		const events = delegatedTurn(task, correct);
		events.splice(2, 0, update, update);
		const outcome = analyzeTaskTurn({ task, events, knownIds, price: null });
		expect(outcome.childRetrievalSource).toBe("task-progress");
		expect(outcome.childZoomCalls).toBe(1);
		expect(outcome.childDateCalls).toBe(1);
		expect(outcome.childWorkCalls).toBe(1);
		expect(outcome.grounded).toBeNull();
	});
});

describe("child usage and completion from the task result", () => {
	const question = questionOf("minor-fact");
	const task = taskFor(question);
	const correct = answerFence(question.id, question.expect.join(" "), false, []);

	test("present usage maps per counter, calls come from requests, and cost is SDK-reported", () => {
		const outcome = analyzeTaskTurn({ task, events: delegatedTurn(task, correct, [], false, { requests: 3 }), knownIds, price: null });
		expect(outcome.childUsage).toEqual({
			calls: 3,
			input: 20,
			output: 8,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 28,
			costUsd: 0.002,
			costSource: "sdk-reported",
			latencyMs: 1500,
			model: "provider/child",
			aborted: false,
		});
		expect(outcome.success).toBe(true);
	});

	test("absent counters stay null rather than zero, and cost is unavailable without a reported total", () => {
		const outcome = analyzeTaskTurn({ task, events: delegatedTurn(task, correct, [], false, { usage: undefined, requests: undefined }), knownIds, price: null });
		expect(outcome.childUsage).toEqual({
			calls: null,
			input: null,
			output: null,
			cacheRead: null,
			cacheWrite: null,
			totalTokens: null,
			costUsd: null,
			costSource: "unavailable",
			latencyMs: 1500,
			model: "provider/child",
			aborted: false,
		});
		expect(outcome.spend).toBe("unobserved");
		expect(childSpendUsd(outcome)).toBeNull();
		expect(outcome.success).toBe(true);
	});

	test("the child's answer is read from its structured output, not the rendered tool text", () => {
		const events = [
			callMessage("call-1", "task", {}, 10),
			startEvent("call-1"),
			{ type: "tool_execution_end", toolCallId: "call-1", isError: false, result: { content: [{ type: "text", text: "rendered wrapper" }], details: { results: [{ output: correct, exitCode: 0, truncated: false }] } } },
			parentMessage("Relayed."),
		];
		const outcome = analyzeTaskTurn({ task, events, knownIds, price: null });
		expect(outcome.status).toBe("completed");
		expect(outcome.success).toBe(true);
	});

	test("a JSON-encoded schemaless child result is decoded and scored as the child's own text", () => {
		const encoded = JSON.stringify(correct);
		const outcome = analyzeTaskTurn({ task, events: delegatedTurn(task, encoded), knownIds, price: null });
		expect(outcome.status).toBe("completed");
		// Parsed as a strict answer: the only remaining grading concern is that no citation supports it.
		expect(outcome.failure).not.toBe("schema");
		expect(outcome.success).toBe(true);
		expect(outcome.childOutputPreview?.startsWith("```json")).toBe(true);
	});

	test("a task result without child details carries null child usage and cannot complete", () => {
		const events = [
			callMessage("call-1", "task", {}, 10),
			startEvent("call-1"),
			{ type: "tool_execution_end", toolCallId: "call-1", isError: false, result: { content: [{ type: "text", text: correct }] } },
			parentMessage("Relayed."),
		];
		const outcome = analyzeTaskTurn({ task, events, knownIds, price: null });
		expect(outcome.childUsage).toBeNull();
		expect(outcome.status).toBe("incomplete");
		expect(outcome.success).toBe(false);
		expect(outcome.spend).toBe("unobserved");
	});

	test("an aborted child keeps its partial usage; its observed cost is recorded and does not close the ledger", () => {
		const outcome = analyzeTaskTurn({ task, events: delegatedTurn(task, correct, [], false, { aborted: true, abortReason: "user", requests: 1 }), knownIds, price: null });
		expect(outcome.status).toBe("incomplete");
		expect(outcome.reason).toBe("child was aborted");
		expect(outcome.success).toBe(false);
		expect(outcome.childUsage).toMatchObject({ aborted: true, input: 20, calls: 1, costUsd: 0.002 });
		expect(outcome.spend).toBe("observed");
		expect(childSpendUsd(outcome)).toBe(0.002);
	});

	test("truncated, erroring, and non-zero-exit children never complete", () => {
		const truncated = analyzeTaskTurn({ task, events: delegatedTurn(task, correct, [], false, { truncated: true }), knownIds, price: null });
		expect(truncated.status).toBe("incomplete");
		expect(truncated.success).toBe(false);
		const errored = analyzeTaskTurn({ task, events: delegatedTurn(task, correct, [], false, { error: "boom" }), knownIds, price: null });
		expect(errored.status).toBe("failed");
		const exited = analyzeTaskTurn({ task, events: delegatedTurn(task, correct, [], false, { exitCode: 1 }), knownIds, price: null });
		expect(exited.status).toBe("failed");
		expect(exited.success).toBe(false);
	});

	test("more than one child entry is not attributable to one question and is incomplete", () => {
		const events = delegatedTurn(task, correct);
		events[2] = {
			type: "tool_execution_end",
			toolCallId: "call-1",
			isError: false,
			result: { content: [{ type: "text", text: correct }], details: { results: [{ output: correct }, { output: correct }] } },
		};
		const outcome = analyzeTaskTurn({ task, events, knownIds, price: null });
		expect(outcome.status).toBe("incomplete");
		expect(outcome.success).toBe(false);
		expect(outcome.childUsage).toBeNull();
	});
});

describe("child cost is counted once", () => {
	const question = questionOf("minor-fact");
	const task = taskFor(question);
	const correct = answerFence(question.id, question.expect.join(" "), false, []);

	test("the task result's usage is not counted as a parent turn; parent usage is only the parent's own assistant messages", () => {
		const events = [
			callMessage("call-1", "task", {}, 10),
			startEvent("call-1"),
			{
				type: "message_end",
				message: { role: "toolResult", toolCallId: "call-1", content: [{ type: "text", text: correct }], usage: { input: 999, output: 999, cacheRead: 0, cacheWrite: 0, cost: { total: 9 } } },
			},
			endEvent("call-1", correct),
			parentMessage("Relayed."),
		];
		const outcome = analyzeTaskTurn({ task, events, knownIds, price: null });
		expect(outcome.parentUsage.map((record) => record.input)).toEqual([10, 10]);
		expect(outcome.parentUsage.every((record) => record.costUsd !== 9)).toBe(true);
	});

	test("refusal-free settlement: observed child cost is the reported figure, not the parent's", () => {
		const outcome = analyzeTaskTurn({ task, events: delegatedTurn(task, correct, [], false, { usage: { input: 20, output: 8, cacheRead: 0, cacheWrite: 0, totalTokens: 28, cost: { total: 0.004 } } }), knownIds, price: null });
		expect(outcome.spend).toBe("observed");
		expect(childSpendUsd(outcome)).toBe(0.004);
	});
});

describe("schema-typed child yields", () => {
	const question = questionOf("minor-fact");
	const task = taskFor(question);

	test("a bare JSON answer object, as a schema-typed yield delivers it, is graded as the fenced answer it is", () => {
		const bare = JSON.stringify({ answers: [{ id: question.id, value: question.expect.join(" "), uncertain: false, citations: [] }] }, null, 2);
		const outcome = analyzeTaskTurn({ task, events: delegatedTurn(task, bare), knownIds, price: null });
		expect(outcome.status).toBe("completed");
		expect(outcome.failure).not.toBe("schema");
		expect(outcome.valueCorrect).toBe(true);
	});

	test("a bare object that is not an answer set remains a schema failure", () => {
		const outcome = analyzeTaskTurn({ task, events: delegatedTurn(task, JSON.stringify({ result: 1 }, null, 2)), knownIds, price: null });
		expect(outcome.failure).toBe("schema");
		expect(outcome.success).toBe(false);
	});
});

describe("childFixtureResponse", () => {
	const question = questionOf("minor-fact");
	const task = taskFor(question);
	const source = corpus.sources[question.sources[0]!.recordId]!;
	const base = { task, quote: source.text, parentTaskResultSeen: false, childZoomResultSeen: false };

	test("parent delegates first and relays after the task result", () => {
		const first = childFixtureResponse({ ...base, role: "parent", arm: "view" });
		expect(first).toMatchObject({ kind: "task" });
		if (first.kind !== "task") throw new Error("expected task reply");
		expect(first.tasks[0]!.task).toBe(task.task);
		expect(childFixtureResponse({ ...base, role: "parent", arm: "view", parentTaskResultSeen: true }).kind).toBe("answer");
	});

	test("view child zooms the answering record, then answers with a grounded citation that scores correct", () => {
		expect(childFixtureResponse({ ...base, role: "child", arm: "view" })).toEqual({ kind: "zoom", id: source.recordId, n: 1 });
		const reply = childFixtureResponse({ ...base, role: "child", arm: "view", childZoomResultSeen: true });
		if (reply.kind !== "answer") throw new Error("expected answer reply");
		const parsed = parseAnswerSet(reply.text, [question.id]);
		expect(parsed.ok).toBe(true);
		const pages: RetrievedPage[] = [{ recordId: source.recordId, text: source.text }];
		const score = scoreAnswers({ questions: [question], raw: reply.text, pages, knownIds });
		expect(score.judgements[0]!.outcome).toBe("correct");
	});

	test("blind child never zooms and answers uncertain with no value", () => {
		const reply = childFixtureResponse({ ...base, role: "child", arm: "blind" });
		expect(reply.kind).toBe("answer");
		if (reply.kind !== "answer") throw new Error("expected answer reply");
		const parsed = parseAnswerSet(reply.text, [question.id]);
		expect(parsed.ok).toBe(true);
		const score = scoreAnswers({ questions: [question], raw: reply.text, pages: [], knownIds });
		expect(score.judgements[0]!.outcome).toBe("abstained");
	});
});
