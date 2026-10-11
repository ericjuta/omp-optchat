import { type ChildFixtureReply, childFixtureResponse } from "../fixture-provider.ts";
import { type ChildArm, type ChildTask, parentPrompt } from "./child.ts";
import type { Corpus, Question } from "./corpus.ts";
import type { FixtureReply, FixtureRequest } from "./offline-server.ts";

/**
 * Scripted replies for fixture mode. Pure: every reply derives from the corpus and the request, so a fixture run is
 * deterministic. A request's turn is the messages after its last user prompt that carries a batch or child-task marker.
 * Hosts keep history across prompts, so only that turn's tool results count as this prompt's retrievals.
 */

export const FIXTURE_CHAT_MODEL = "optchat-smoke-chat";
export const BATCH_MARKER = "Answer each numbered question";
const TASK_CALL = "fixture-task";
const ZOOM_CALL = "fixture-zoom";
const YIELD_CALL = "fixture-yield";

/** The current child experiment: its tasks, and the arm whose child host is running. */
export interface FixtureState {
	childTasks: ChildTask[];
	childArm: ChildArm;
}

/** One named field of an untyped JSON value; undefined when the value is not an object or lacks the field. */
function field(value: unknown, key: string): unknown {
	return typeof value === "object" && value !== null && key in value ? Reflect.get(value, key) : undefined;
}

function messageText(message: unknown): string {
	const content = field(message, "content");
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			const text = field(part, "text");
			return typeof text === "string" ? text : "";
		})
		.join("\n");
}

function hasToolResult(turn: readonly unknown[], callId: string): boolean {
	return turn.some((message) => field(message, "role") === "tool" && field(message, "tool_call_id") === callId);
}

/** The sentence of `text` that states `value`, verbatim. Falls back to the whole text when no such sentence is isolated. */
export function sentenceQuote(text: string, value: string): string {
	const at = text.indexOf(value);
	if (value.length === 0 || at < 0) return text;
	const previous = text.lastIndexOf(". ", at);
	const start = previous < 0 ? 0 : previous + 2;
	const next = text.indexOf(".", at + value.length);
	const end = next < 0 ? text.length : next + 1;
	const quote = text.slice(start, end);
	return quote.includes(value) ? quote : text;
}

/** The strict answer object for one question: its expected value, or an explicit abstention, citing sentences of its source records. */
function answerFor(corpus: Corpus, question: Question): Record<string, unknown> {
	if (!question.answerable) return { id: question.id, value: "not stated", uncertain: true, citations: [] };
	const citations = question.sources.map((source) => {
		const record = corpus.sources.find((entry) => entry.recordId === source.recordId);
		return { recordId: source.recordId, quote: sentenceQuote(record?.text ?? "", source.value) };
	});
	if (question.ambiguous) return { id: question.id, value: question.candidates.join(" or "), uncertain: true, citations };
	return { id: question.id, value: question.expect.join(" "), uncertain: false, citations };
}

function answerBlock(answers: readonly Record<string, unknown>[]): FixtureReply {
	return { text: ["```json", JSON.stringify({ answers }), "```"].join("\n") };
}

function childReply(reply: ChildFixtureReply): FixtureReply {
	if (reply.kind === "task") {
		const args = JSON.stringify({ i: "Delegating one synthetic question", context: reply.context, tasks: reply.tasks });
		return { toolCalls: [{ index: 0, id: TASK_CALL, type: "function", function: { name: "task", arguments: args } }] };
	}
	if (reply.kind === "zoom") {
		return { toolCalls: [{ index: 0, id: ZOOM_CALL, type: "function", function: { name: "zoom", arguments: JSON.stringify({ id: reply.id, n: reply.n }) } }] };
	}
	return { text: reply.text };
}

/**
 * Child-experiment turn. The parent delegates its task once, then relays. The view child zooms its record and answers
 * with a verbatim quote; a view child with no source record abstains without retrieval. The blind child answers uncertain.
 * A worker ends its turn with `yield`; `type: "result"` makes its last assistant text the raw final result.
 */
function childTurn(corpus: Corpus, arm: ChildArm, task: ChildTask, parent: boolean, turn: readonly unknown[]): FixtureReply {
	const question = task.question;
	const source = question.sources[0];
	if (!parent && arm === "view" && source === undefined) return answerBlock([answerFor(corpus, question)]);
	const record = source === undefined ? undefined : corpus.sources.find((entry) => entry.recordId === source.recordId);
	const quote = source === undefined ? "" : sentenceQuote(record?.text ?? "", source.value);
	const reply = childFixtureResponse({
		role: parent ? "parent" : "child",
		arm,
		task,
		quote,
		parentTaskResultSeen: hasToolResult(turn, TASK_CALL),
		childZoomResultSeen: hasToolResult(turn, ZOOM_CALL),
	});
	if (!parent && reply.kind === "answer") {
		const yieldArgs = JSON.stringify({ type: "result" });
		return { text: reply.text, toolCalls: [{ index: 0, id: YIELD_CALL, type: "function", function: { name: "yield", arguments: yieldArgs } }] };
	}
	return childReply(reply);
}

/**
 * On-arm batch turn. One zoom (n=1) per distinct expected source record, one call per request, in question order. Once
 * each has returned (even as an error), the answer is given from the retrieved originals.
 */
function memoryTurn(corpus: Corpus, questions: readonly Question[], turn: readonly unknown[]): FixtureReply {
	const recordIds = [...new Set(questions.flatMap((question) => question.sources.map((source) => source.recordId)))];
	for (const recordId of recordIds) {
		const callId = `${ZOOM_CALL}-${recordId}`;
		if (hasToolResult(turn, callId)) continue;
		const args = JSON.stringify({ id: recordId, n: 1 });
		return { toolCalls: [{ index: 0, id: callId, type: "function", function: { name: "zoom", arguments: args } }] };
	}
	return answerBlock(questions.map((question) => answerFor(corpus, question)));
}

/** The index of the last user message carrying a batch or child-task prompt, or -1 when none does. */
function turnStart(messages: readonly unknown[], tasks: readonly ChildTask[]): number {
	for (let index = messages.length - 1; index >= 0; index--) {
		if (field(messages[index], "role") !== "user") continue;
		const text = messageText(messages[index]);
		if (text.includes(BATCH_MARKER) || tasks.some((task) => text.includes(task.task))) return index;
	}
	return -1;
}

/**
 * The fixture reply for one request. A compressor request gets a plain summary. A child-experiment request is routed by
 * its child task text. A batch prompt on the on arm (memory tools present) zooms, then answers. On the off arm the
 * seeded history already holds the records, so the answer comes directly.
 */
export function fixtureReply(corpus: Corpus, fixture: FixtureState, request: FixtureRequest): FixtureReply {
	const body = request.body ?? {};
	if (body.model !== FIXTURE_CHAT_MODEL) return { text: "Fixture summary of synthetic records; the original text stays in the record." };
	const messages: readonly unknown[] = Array.isArray(body.messages) ? body.messages : [];
	const tools: readonly unknown[] = Array.isArray(body.tools) ? body.tools : [];
	const start = turnStart(messages, fixture.childTasks);
	if (start < 0) return { text: "Fixture: no question in this request." };
	const subject = messageText(messages[start]);
	const turn = messages.slice(start + 1);
	const task = fixture.childTasks.find((entry) => subject.includes(entry.task));
	if (task !== undefined) return childTurn(corpus, fixture.childArm, task, subject.includes(parentPrompt(task)), turn);
	const questions = corpus.questions.filter((question) => subject.includes(`[${question.id}]`));
	const onArm = tools.some((tool) => field(field(tool, "function"), "name") === "zoom");
	if (!onArm) return answerBlock(questions.map((question) => answerFor(corpus, question)));
	return memoryTurn(corpus, questions, turn);
}
