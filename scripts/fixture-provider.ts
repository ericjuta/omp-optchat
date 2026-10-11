import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { ChildArm, ChildTask } from "./evidence/child.ts";
import { ASYNC_ID, ASYNC_PREVIEW, ASYNC_SCHEMA } from "./smoke-fixtures.ts";

/* ------------------------------------------------------------------------------------------------
 * Scripted fixture reply for the offline e2e. Pure: no I/O, no clock, no randomness. The driver's
 * loopback server routes each request by role and converts the reply to SSE.
 * ------------------------------------------------------------------------------------------------ */

export interface ChildFixtureInput {
	readonly role: "parent" | "child";
	readonly arm: ChildArm;
	readonly task: ChildTask;
	/** Verbatim original text of the answering record, as a zoom (n=1) returns it. Must contain the expected value. */
	readonly quote: string;
	/** The parent has received the task's tool result (the child's output). */
	readonly parentTaskResultSeen: boolean;
	/** The child has received a zoom result for this turn. */
	readonly childZoomResultSeen: boolean;
}

export type ChildFixtureReply =
	| { readonly kind: "task"; readonly context: string; readonly tasks: readonly { name: string; task: string; solutionSpace: string }[] }
	| { readonly kind: "zoom"; readonly id: number; readonly n: 1 }
	| { readonly kind: "answer"; readonly text: string };

/** Scripted reply for one request. Parent delegates first; the view child zooms, then answers with a grounded citation; the blind child answers uncertain. */
export function childFixtureResponse(input: ChildFixtureInput): ChildFixtureReply {
	const { task } = input;
	const question = task.question;
	if (input.role === "parent") {
		if (!input.parentTaskResultSeen) {
			return {
				kind: "task",
				context: "Answer from parent chat memory only.",
				tasks: [{ name: "ChildAnswer", task: task.task, solutionSpace: "One fixed synthetic question; no design choices." }],
			};
		}
		return { kind: "answer", text: "Delegated; the subagent's answer is relayed above." };
	}
	if (input.arm === "blind") {
		const blind = { answers: [{ id: question.id, value: null, uncertain: true, citations: [] }] };
		return { kind: "answer", text: ["```json", JSON.stringify(blind), "```"].join("\n") };
	}
	const source = question.sources[0];
	if (source === undefined) throw new RangeError(`question ${question.id} has no source record`);
	if (!input.childZoomResultSeen) return { kind: "zoom", id: source.recordId, n: 1 };
	const grounded = {
		answers: [
			{ id: question.id, value: question.expect.join(" "), uncertain: false, citations: [{ recordId: source.recordId, quote: input.quote }] },
		],
	};
	return { kind: "answer", text: ["```json", JSON.stringify(grounded), "```"].join("\n") };
}

/**
 * Driver-owned Chat Completions SSE endpoint; no server or SDK runtime here.
 * Set OPTCHAT_SMOKE_BASE_URL=http://127.0.0.1:<port>/v1 and load with
 * --extension ./scripts/fixture-provider.ts --provider optchat-smoke
 * --model optchat-smoke-chat (or optchat-smoke-compact).
 * Send delta.reasoning_content for thinking, delta.content for text, then
 * finish_reason:"stop", usage, and [DONE]. Both models use the same transport.
 */
export default function fixtureProvider(pi: ExtensionAPI): void {
	const configuredUrl = process.env.OPTCHAT_SMOKE_BASE_URL;
	if (!configuredUrl) {
		throw new Error("Set OPTCHAT_SMOKE_BASE_URL to the driver-owned loopback /v1 endpoint.");
	}
	const baseUrl = new URL(configuredUrl);
	if (
		baseUrl.protocol !== "http:" ||
		!["127.0.0.1", "localhost", "[::1]"].includes(baseUrl.hostname) ||
		baseUrl.username ||
		baseUrl.password ||
		baseUrl.search ||
		baseUrl.hash ||
		baseUrl.pathname.replace(/\/$/, "") !== "/v1"
	) {
		throw new Error("OPTCHAT_SMOKE_BASE_URL must be an HTTP loopback /v1 URL without credentials, query, or fragment.");
	}

	pi.registerCommand("optchat-smoke-report", {
		description: "Deliver a full synthetic structured background report through the host message path",
		handler: async () => {
			pi.sendMessage({
				customType: "async-result",
				content: ASYNC_PREVIEW,
				display: true,
				attribution: "agent",
				details: { jobs: [{ jobId: ASYNC_ID, agentId: ASYNC_ID, type: "task", status: "completed", label: ASYNC_ID, schema: ASYNC_SCHEMA }] },
			}, { triggerTurn: false });
		},
	});

	pi.registerProvider("optchat-smoke", {
		baseUrl: baseUrl.href.replace(/\/$/, ""),
		apiKey: "optchat-smoke-fixture-key",
		api: "openai-completions",
		models: ["optchat-smoke-chat", "optchat-smoke-compact", "optchat-smoke-child"].map((id) => ({
			id,
			name: id,
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 16_384,
			compat: {
				supportsStore: false,
				supportsDeveloperRole: false,
				supportsMultipleSystemMessages: true,
				supportsReasoningEffort: true,
				supportsUsageInStreaming: true,
				maxTokensField: "max_tokens",
				thinkingFormat: "openai",
				reasoningContentField: "reasoning_content",
				replayReasoningContent: true,
			},
		})),
	});
}
