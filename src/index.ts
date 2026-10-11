import { openSync, closeSync, fsyncSync, readFileSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";
import { clampThinkingLevelForModel, Effort } from "@oh-my-pi/pi-catalog";
import { requiresNativeTools } from "@oh-my-pi/pi-catalog/compat/tools";
import {
	completeSimple,
	type AssistantMessage,
	type ImageContent,
	type Message as LlmMessage,
	type Model,
	type TextContent,
	type Tool,
	type UserMessage,
} from "@oh-my-pi/pi-ai";
import type {
	ContextEvent,
	ContextEventResult,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ToolResultEvent,
	ToolResultEventResult,
} from "@oh-my-pi/pi-coding-agent";
import {
	applyOptChatCache,
	OptChatCacheCoordinator,
	type OptChatCacheRelease,
	viewBlocks,
	viewPartition,
	type ViewPartition,
} from "./cache.js";
import { dialectKey, sharedToolsAllowed } from "./dialect.js";
import { readConfig, readEnabled, registerFlags, type OptChatConfig } from "./config.js";
import { exportHtml, importHistory } from "./history.js";
import { Memory, type CompactionRequest, type Summarize } from "./memory.js";
import { VIEW_DOC } from "./prompts.js";
import { Store, type Kind } from "./store.js";

type AgentMessage = ContextEvent["messages"][number];

/** Appended to the host system prompt; byte-identical on every request so it stays cached. */
export const SYSTEM_BLOCK = `# OptChat memory\n\n${VIEW_DOC}`;

/**
 * The host gives a context handler 30 s in total, then sends the request
 * unchanged. Startup wait and settle share one deadline that ends before that.
 */
export const SETTLE_TIMEOUT_MS = 25_000;
const HOST_HANDLER_LIMIT_MS = 30_000;
const IDLE_POLL_MS = 250;
const TOOL_NAMES: readonly string[] = ["zoom", "date"];
/** Host tools whose arguments and results are the model's private thoughts: never logged. */
const PRIVATE_TOOLS: Record<string, true> = { think: true };
const SKILL_PROMPT_MESSAGE_TYPE = "skill-prompt";
/** Host messages that deliver a background job's output into the chat. */
const BACKGROUND_RESULT_TYPES: Record<string, true> = { "async-result": true, "launch-completion": true };

export interface OptChatOptions {
	/** Bounded wait for startup and the view's summaries before a fresh turn is refused; below 30 s. */
	settleTimeoutMs?: number;
}

class Refusal extends Error {}

/** Keep the head and tail of a long tool result, with a note of what was cut; never longer than `cap`. */
export function capText(text: string, cap: number): string {
	if (text.length <= cap) return text;
	const note = (removed: number) => `\n\n[${removed} of ${text.length} characters cut]\n\n`;
	const keep = cap - note(10 ** String(text.length).length - 1).length;
	if (keep <= 0) {
		// No room for the note: a plain head cut, without splitting a surrogate pair.
		const end = Math.max(0, cap);
		const lastCode = text.charCodeAt(end - 1);
		return text.slice(0, end > 0 && lastCode >= 0xd800 && lastCode <= 0xdbff ? end - 1 : end);
	}
	let head = Math.ceil(keep / 2);
	let tailStart = text.length - (keep - head);
	// Never split a surrogate pair.
	const last = text.charCodeAt(head - 1);
	if (head > 0 && last >= 0xd800 && last <= 0xdbff) head--;
	const first = text.charCodeAt(tailStart);
	if (tailStart < text.length && first >= 0xdc00 && first <= 0xdfff) tailStart++;
	return text.slice(0, head) + note(tailStart - head) + text.slice(tailStart);
}

function stamp(message: AgentMessage): number {
	if (!("timestamp" in message)) return Number.NEGATIVE_INFINITY;
	const value: unknown = message.timestamp;
	return typeof value === "number" && Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
}

/**
 * Identity of a message across the host's copies of it. Assistant content is
 * not hashed: listeners may receive it display-deobfuscated while requests carry
 * it obfuscated.
 */
function keyOf(message: AgentMessage): string {
	const at = `${message.role}:${stamp(message)}`;
	if (message.role === "assistant") return at;
	if (message.role === "toolResult") return `${at}:${message.toolCallId}`;
	const body = "content" in message ? message.content : "";
	return `${at}:${Bun.hash(JSON.stringify(body) ?? "").toString(36)}`;
}

function contentText(content: string | readonly (TextContent | ImageContent)[]): string {
	if (typeof content === "string") return content;
	return content.map((part) => (part.type === "text" ? part.text : "[image]")).join("\n");
}

/** Completed chat entries of one host message, in order; thoughts are never logged. */
function entriesOf(message: AgentMessage, toolCap: number): Array<{ kind: Kind; text: string }> {
	switch (message.role) {
		case "user": {
			if (message.synthetic === true || message.attribution === "agent") return [];
			const text = contentText(message.content);
			return text.length > 0 ? [{ kind: "user", text }] : [];
		}
		case "custom": {
			const text = contentText(message.content);
			if (text.length === 0) return [];
			// A skill invoked by the user is the user's own ask.
			if (message.customType === SKILL_PROMPT_MESSAGE_TYPE && message.attribution === "user") return [{ kind: "user", text }];
			// A background job's report: work delivered to the chat, marked so it never reads as the user's words.
			if (Object.hasOwn(BACKGROUND_RESULT_TYPES, message.customType)) {
				const ids = jobIds(message.details);
				// Preserve the host's existing report-row encoding; prompts label its provenance as work.
				const label = ids.length > 0 ? `[${ids.join(", ")}]` : "[background]";
				return [{ kind: "user", text: capText(`${label} ${text}`, toolCap) }];
			}
			return [];
		}
		case "assistant":
			return assistantEntries(message);
		case "toolResult": {
			if (Object.hasOwn(PRIVATE_TOOLS, message.toolName)) return [];
			const text = contentText(message.content);
			const echo = message.isError ? `[error] ${text}` : text;
			// Retrieval output stays whole in the log too: zoom must be lossless.
			return [{ kind: "echo", text: TOOL_NAMES.includes(message.toolName) ? echo : capText(echo, toolCap) }];
		}
		default:
			return [];
	}
}

/** Job ids of a background report: `details.jobId`, or each `details.jobs[].jobId`. */
function jobIds(details: unknown): string[] {
	if (typeof details !== "object" || details === null) return [];
	const jobs: unknown[] = "jobs" in details && Array.isArray(details.jobs) ? details.jobs : [details];
	const ids: string[] = [];
	for (const job of jobs) {
		if (typeof job === "object" && job !== null && "jobId" in job && typeof job.jobId === "string") ids.push(job.jobId);
	}
	return ids;
}

function assistantEntries(message: AssistantMessage): Array<{ kind: Kind; text: string }> {
	// A stopped or failed reply never finished; the messages it never took stay unanswered.
	if (message.stopReason === "aborted" || message.stopReason === "error") return [];
	const entries: Array<{ kind: Kind; text: string }> = [];
	let talk: string[] = [];
	const flushTalk = () => {
		const text = talk.join("\n");
		if (text.trim().length > 0) entries.push({ kind: "talk", text });
		talk = [];
	};
	for (const part of message.content) {
		if (part.type === "text") talk.push(part.text);
		else if (part.type === "toolCall" && !Object.hasOwn(PRIVATE_TOOLS, part.name)) {
			flushTalk();
			entries.push({ kind: "tool", text: `${part.name} ${JSON.stringify(part.arguments ?? {})}` });
		}
	}
	flushTalk();
	return entries;
}

function assistantReply(model: Model, text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

interface Mark {
	key: string;
	stamp: number;
}

function mark(message: AgentMessage): Mark {
	return { key: keyOf(message), stamp: stamp(message) };
}

/**
 * One turn: from a fresh prompt to the run's terminal end. Steering, asides,
 * follow-ups and retries delivered meanwhile belong to it.
 */
interface Turn {
	/** Snapshot taken before the turn's first message was logged; sent unchanged on every request. */
	blocks: TextContent[];
	partition: ViewPartition;
	timestamp: number;
	/** First host message of the turn. */
	first?: Mark;
	/** Last host message before the turn, when the turn began with no new message. */
	after?: Mark;
}

interface Pending {
	controller: AbortController;
	/** The new messages waiting for the snapshot; logged however the wait ends. */
	tail: AgentMessage[];
	superseded: boolean;
	abandoned: boolean;
}

type State =
	| { kind: "starting" }
	| { kind: "ready" }
	| { kind: "failed"; reason: string }
	| { kind: "closed" };

type WireObject = Record<string, unknown>;

function wireObject(value: unknown): value is WireObject {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Exact JSON-shaped wire equality except cache metadata; no serialization or temporary arrays. */
function sameWireValue(left: unknown, right: unknown): boolean {
	if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return Object.is(left, right);
	if (Array.isArray(left)) {
		if (!Array.isArray(right) || left.length !== right.length) return false;
		for (let index = 0; index < left.length; index++) {
			if (!Object.hasOwn(left, index) || !Object.hasOwn(right, index) ||
				!sameWireValue(left[index], right[index])) return false;
		}
		return true;
	}
	if (!wireObject(left) || !wireObject(right)) return false;
	let leftCount = 0;
	let rightCount = 0;
	for (const key in left) {
		// These two fields mark cache placement, not the encoded prompt or tool definition.
		if (!Object.hasOwn(left, key) || key === "cache_control" || key === "prompt_cache_breakpoint") continue;
		leftCount++;
		if (!Object.hasOwn(right, key) || !Object.prototype.propertyIsEnumerable.call(right, key) ||
			!sameWireValue(left[key], right[key])) return false;
	}
	for (const key in right) {
		if (Object.hasOwn(right, key) && key !== "cache_control" && key !== "prompt_cache_breakpoint") rightCount++;
	}
	return leftCount === rightCount;
}

/** Only these stateless request dialects expose passive function definitions. */
function functionDialect(model: Model): boolean {
	return model.transport !== "pi-native" &&
		["anthropic-messages", "openai-completions", "openai-responses", "openai-codex-responses"].includes(model.api);
}

/** These declarations ask the caller for execution; hosted/native tools are deliberately excluded. */
function passiveTool(tool: unknown, api: Model["api"]): boolean {
	if (!wireObject(tool)) return false;
	if (api === "anthropic-messages") {
		return (tool.type === undefined || tool.type === "custom") && typeof tool.name === "string" && wireObject(tool.input_schema);
	}
	if (api === "openai-completions") return tool.type === "function" && wireObject(tool.function);
	if (tool.type === "namespace") return Array.isArray(tool.tools) && tool.tools.every((child) => passiveTool(child, api));
	return (tool.type === "function" || tool.type === "custom") && typeof tool.name === "string";
}

interface SharedPrefix {
	model: Model;
	dialect: string;
	systemPrompt: string[];
	tools: Tool[];
	wireTools: unknown;
	/** Provider-added formatting stays in the same request dialect; never copied across providers. */
	head: WireObject;
	messageField?: "messages" | "input";
	messages?: WireObject[];
}

class OptChat {
	private state: State = { kind: "starting" };
	private config: OptChatConfig | undefined;
	private compressor: Model | undefined;
	private store: Store | undefined;
	private memory: Memory | undefined;
	private ready: Promise<void> = Promise.resolve();
	private turn: Turn | undefined;
	private pending: Pending | undefined;
	/** Completed messages that arrived while no turn was open: logged after the next snapshot. */
	private held: AgentMessage[] = [];
	/** Messages created before activation or a session switch are prior history, never this chat. */
	private cutoff = Date.now();
	private readonly logged = new Set<string>();
	private ctx: ExtensionContext | undefined;
	private sharedPrefix: SharedPrefix | undefined;
	private readonly cache = new OptChatCacheCoordinator();
	private cacheFence = new AbortController();
	/** Cancels main requests still waiting on compressor writers once their run moves on. */
	private mainWaits = new AbortController();

	constructor(
		private readonly pi: ExtensionAPI,
		private readonly settleTimeoutMs: number,
	) {}

	start(ctx: ExtensionContext): Promise<void> {
		this.ctx = ctx;
		this.cutoff = Date.now();
		this.ready = this.open(ctx).catch((error: unknown) => {
			this.fail(`OptChat is off for this session: ${errorText(error)}. Every prompt will be refused until restart.`);
		});
		return this.ready;
	}

	private async open(ctx: ExtensionContext): Promise<void> {
		const config = readConfig(this.pi, join(this.pi.pi.getAgentDir(), "optchat"));
		this.config = config;
		const model = ctx.models.resolve(config.model);
		if (!model) {
			throw new Error(`compressor model "${config.model}" is not available (configure it or pass --optchat-model provider/id)`);
		}
		if (requiresNativeTools(model)) {
			throw new Error(`compressor model "${config.model}" requires native tools that cannot be disabled; choose a model with tool-free inference`);
		}
		this.compressor = model;
		this.registerTools();
		const store = await Store.open(config.directory, (message) => this.notify(message, "warning"));
		if (this.state.kind !== "starting") {
			await store.close();
			return;
		}
		this.store = store;
		this.memory = new Memory(store, this.summarize, {
			nodeBytes: config.nodeBytes,
			viewBytes: config.viewBytes,
			jobs: config.jobs,
			tries: config.tries,
			retryMs: config.retryMs,
			report: (message) => this.notify(`OptChat compressor: ${message}`, "warning"),
		});
		this.state = { kind: "ready" };
		const status = this.memory.status();
		this.notify(
			`OptChat active: ${status.messages} messages in ${store.directory}; compressor ${model.provider}/${model.id}.`,
			"info",
		);
	}

	private registerTools(): void {
		const taken = this.pi.getAllTools().filter((tool) => TOOL_NAMES.includes(tool.name));
		if (taken.length > 0) {
			throw new Error(`tool name ${taken.map((tool) => `"${tool.name}"`).join(", ")} is already registered`);
		}
		const z = this.pi.zod;
		const zoomParams = z.object({
			id: z.number().int().min(0).describe("First message id of the line"),
			n: z.number().int().min(1).describe("Messages the line covers (a power of 2)"),
		});
		this.pi.registerTool<typeof zoomParams>({
			name: "zoom",
			label: "OptChat zoom",
			description:
				"Open the line id+n of the view into the two lines of n/2 under it; n = 1 gives the message whole.",
			parameters: zoomParams,
			approval: "read",
			loadMode: "essential",
			execute: async (_id, params) => ({
				content: [{ type: "text", text: this.openMemory().zoom(params.id, params.n) }],
			}),
		});
		const dateParams = z.object({ id: z.number().int().min(0).describe("Message id") });
		this.pi.registerTool<typeof dateParams>({
			name: "date",
			label: "OptChat date",
			description: "The date and time of message id.",
			parameters: dateParams,
			approval: "read",
			loadMode: "essential",
			execute: async (_id, params) => ({
				content: [{ type: "text", text: this.openMemory().date(params.id) }],
			}),
		});
	}

	private openMemory(): Memory {
		if (this.state.kind !== "ready" || !this.memory) throw new Error("OptChat memory is not open");
		return this.memory;
	}

	/** Compressor call: the host's shared system/tools, then its view, task and feedback. No tool executor is installed. */
	private readonly summarize: Summarize = (request, parentSignal) => {
		const signal = AbortSignal.any([parentSignal, this.cacheFence.signal]);
		if (signal.aborted) return Promise.reject(new Error("Compressor call cancelled"));
		const { promise, resolve: done, reject } = Promise.withResolvers<string>();
		// Shutdown must not wait on a provider that ignores cancellation.
		const cancel = () => reject(new Error("Compressor call cancelled"));
		signal.addEventListener("abort", cancel, { once: true });
		this.compress(request, signal)
			.then(done, reject)
			.finally(() => signal.removeEventListener("abort", cancel));
		return promise;
	};

	private async compress(request: CompactionRequest, signal: AbortSignal): Promise<string> {
		const model = this.compressor;
		const ctx = this.ctx;
		if (!model || !ctx) throw new Error("Compressor model is not configured");
		const messages: LlmMessage[] = [
			{
				role: "user",
				// Same bytes as one block; split only at stable whole-line boundaries.
				content: [...viewBlocks(request.context, model), { type: "text", text: request.instruction }],
				timestamp: Date.now(),
			},
		];
		for (const turn of request.feedback) {
			messages.push(assistantReply(model, turn.reply), {
				role: "user",
				content: [{ type: "text", text: turn.instruction }],
				timestamp: Date.now(),
			});
		}
		let release: OptChatCacheRelease | undefined;
		const finish = (started = false) => {
			release?.(started);
			release = undefined;
		};
		const reply = await completeSimple(
			model,
			{
				systemPrompt: this.beforeAgentStart(ctx.getSystemPrompt()).systemPrompt,
				messages,
				// Bootstrap has no tools: public enabled names are not the final host-visible list.
				// onPayload reuses only a compatible captured function-tool prefix.
			},
			{
				apiKey: ctx.modelRegistry.resolver(model, ctx.sessionManager.getSessionId()),
				signal,
				// Full independent context, never the main session's response chain or mutable state.
				statefulResponses: false,
				// Medium effort, clamped to what the model offers; none for a model without reasoning.
				// The output limit stays the host default (the model's own maximum).
				reasoning: clampThinkingLevelForModel(model, Effort.Medium),
				onPayload: async (payload, payloadModel, attemptSignal) => {
					// Auth/provider retries must release their own previous attempt before waiting.
					finish();
					const actualModel = payloadModel ?? model;
					const encoded = applyOptChatCache(this.alignPrefix(payload, actualModel, ctx), actualModel);
					// This request's own onResponse/finally release the lease: the only correlated writer.
					release = await this.cache.acquire(encoded, actualModel, {
						signal: attemptSignal ? AbortSignal.any([signal, attemptSignal]) : signal,
					});
					return encoded;
				},
				onResponse: (response) => finish(response.status >= 200 && response.status < 300),
			},
		).finally(() => finish());
		if (reply.stopReason === "error" || reply.stopReason === "aborted") {
			const status = reply.errorStatus === undefined ? "" : ` (HTTP ${reply.errorStatus})`;
			throw new Error(`${model.provider}/${model.id} request ${reply.stopReason === "error" ? "failed" : "was aborted"}${status}`);
		}
		if (reply.stopReason === "toolUse" || reply.content.some((part) => part.type === "toolCall")) {
			throw new Error("Compressor returned a tool call instead of a summary; no tool calls were dispatched");
		}
		return reply.content
			.filter((part): part is TextContent => part.type === "text")
			.map((part) => part.text)
			.join("");
	}

	/** An invalidation fingerprint only; never used as compressor tool exposure. */
	private activeToolSnapshot(model: Model): Tool[] | undefined {
		// ToolInfo lacks visibility, examples and native/custom metadata. Compare
		// its public subset, but send only the host's actually encoded tool list.
		if (!functionDialect(model)) return undefined;
		const tools = new Map(this.pi.getAllTools().map((tool) => [tool.name, tool]));
		return this.pi.getActiveTools().flatMap((name) => {
			const tool = tools.get(name);
			return tool ? [{ name: tool.name, description: tool.description, parameters: tool.parameters }] : [];
		});
	}

	/** Public ToolInfo omits custom formats/examples, so retain the host's encoded prefix when safe. */
	private capturePrefix(payload: unknown, model: Model, ctx: ExtensionContext): void {
		this.sharedPrefix = undefined;
		if (!functionDialect(model) || !wireObject(payload) || payload.previous_response_id != null) return;
		const tools = payload.tools;
		if (tools !== undefined && (!Array.isArray(tools) || !tools.every((tool) => passiveTool(tool, model.api)))) return;
		const head: WireObject = {};
		if (Object.hasOwn(payload, "system")) head.system = payload.system;
		if (Object.hasOwn(payload, "instructions")) head.instructions = payload.instructions;
		let messages: WireObject[] | undefined;
		let messageField: "messages" | "input" | undefined;
		if (model.api !== "anthropic-messages") {
			messageField = model.api === "openai-completions" ? "messages" : "input";
			const items = payload[messageField];
			if (!Array.isArray(items)) return;
			messages = [];
			for (const message of items) {
				if (!wireObject(message) || (message.role !== "system" && message.role !== "developer")) break;
				messages.push(message);
			}
		}
		this.sharedPrefix = {
			model,
			dialect: dialectKey(model),
			systemPrompt: ctx.getSystemPrompt().slice(),
			tools: this.activeToolSnapshot(model) ?? [],
			wireTools: structuredClone(tools),
			head: structuredClone(head),
			messageField,
			messages: messages && structuredClone(messages),
		};
	}

	private alignPrefix(payload: unknown, model: Model, ctx: ExtensionContext): unknown {
		const prefix = this.sharedPrefix;
		if (!prefix || !ctx.model || !functionDialect(model) || !wireObject(payload) || payload.previous_response_id != null ||
			prefix.dialect !== dialectKey(model) || prefix.dialect !== dialectKey(ctx.model) || prefix.model.id !== ctx.model.id) return payload;
		const prompt = this.beforeAgentStart(ctx.getSystemPrompt()).systemPrompt;
		if (prompt.length !== prefix.systemPrompt.length || prompt.some((block, index) => block !== prefix.systemPrompt[index])) return payload;
		const tools = this.activeToolSnapshot(model) ?? [];
		if (tools.length !== prefix.tools.length || tools.some((tool, index) => {
			const previous = prefix.tools[index]!;
			return tool.name !== previous.name || tool.description !== previous.description || tool.parameters !== previous.parameters;
		})) return payload;
		// Require exact encoded prefix equality except cache metadata. Reasoning and
		// compat.whenThinking can relocate the prompt between heads and messages;
		// replay must reject that relocation rather than override the destination encoder.
		const hasSystem = Object.hasOwn(prefix.head, "system");
		const hasInstructions = Object.hasOwn(prefix.head, "instructions");
		if (hasSystem !== Object.hasOwn(payload, "system") || hasInstructions !== Object.hasOwn(payload, "instructions")) return payload;
		if (hasSystem && !sameWireValue(prefix.head.system, payload.system)) return payload;
		if (hasInstructions && !sameWireValue(prefix.head.instructions, payload.instructions)) return payload;
		let items: unknown[] | undefined;
		let prefixEnd = 0;
		if (prefix.messages && prefix.messageField) {
			const destination = payload[prefix.messageField];
			if (!Array.isArray(destination)) return payload;
			while (prefixEnd < destination.length) {
				const message: unknown = destination[prefixEnd];
				if (!wireObject(message) || (message.role !== "system" && message.role !== "developer")) break;
				if (!sameWireValue(prefix.messages[prefixEnd], message)) return payload;
				prefixEnd++;
			}
			if (prefixEnd !== prefix.messages.length) return payload;
			items = destination;
		}
		// All prefix validation precedes aligned copies and tool injection.
		const aligned: WireObject = { ...payload, ...structuredClone(prefix.head) };
		// Captured declarations go only to a destination whose own encoder would emit the
		// same ones; otherwise the compressor keeps its tool-free bootstrap encoding.
		if (sharedToolsAllowed(prefix.model, model)) {
			if (prefix.wireTools === undefined) delete aligned.tools;
			else aligned.tools = structuredClone(prefix.wireTools);
		}
		if (prefix.messages && prefix.messageField && items) {
			aligned[prefix.messageField] = [...structuredClone(prefix.messages), ...items.slice(prefixEnd)];
		}
		return aligned;
	}

	private notify(message: string, type: "info" | "warning" | "error"): void {
		try {
			this.ctx?.ui.notify(message, type);
		} catch {
			// Notifications are best effort; refusals are enforced by abort, not by the message.
		}
	}

	private fail(reason: string): void {
		if (this.state.kind === "closed") return;
		this.state = { kind: "failed", reason };
		this.notify(reason, "error");
	}

	/** The only supported way to stop a request from a context hook: abort the run, send nothing. */
	private refuse(ctx: ExtensionContext, reason: string): ContextEventResult {
		ctx.abort();
		this.notify(reason, "error");
		return { messages: [] };
	}

	// --- host events -----------------------------------------------------------------

	async beforeProviderRequest(payload: unknown, ctx: ExtensionContext): Promise<unknown> {
		if (!ctx.model) return undefined;
		this.capturePrefix(payload, ctx.model, ctx);
		const encoded = applyOptChatCache(payload, ctx.model);
		if (!this.turn || ctx.isIdle()) return encoded;
		// Public host hooks carry no request identity: side requests share them, and
		// retries or advisors report responses without a matching request event. A
		// main request therefore never claims a writer lease; it only waits for the
		// compressor writers already covering its prefix.
		const signal = AbortSignal.any([this.mainWaits.signal, this.cacheFence.signal]);
		try {
			await this.cache.wait(encoded, ctx.model, { signal });
		} catch (error) {
			if (!signal.aborted) throw error;
		}
		return encoded;
	}

	private releaseMainWaits(): void {
		this.mainWaits.abort();
		this.mainWaits = new AbortController();
	}

	resetCacheFence(): void {
		this.releaseMainWaits();
		this.cacheFence.abort();
		this.cache.clear();
		this.cacheFence = new AbortController();
		this.sharedPrefix = undefined;
	}

	beforeAgentStart(systemPrompt: string[]): { systemPrompt: string[] } {
		return { systemPrompt: systemPrompt.includes(SYSTEM_BLOCK) ? systemPrompt : [...systemPrompt, SYSTEM_BLOCK] };
	}

	async context(messages: AgentMessage[], ctx: ExtensionContext): Promise<ContextEventResult | undefined> {
		const deadline = Date.now() + this.settleTimeoutMs;
		try {
			if (this.state.kind === "starting") await this.waitForStart(deadline);
			const memory = this.requireReady();
			const active = new Set(this.pi.getActiveTools());
			if (!TOOL_NAMES.every((name) => active.has(name))) {
				throw new Refusal("OptChat refused the request: the zoom and date tools are not active in this session.");
			}
			let turn = this.turn;
			if (!turn) {
				turn = await this.openTurn(messages, ctx, memory, deadline);
				// Abandoned by the host (cancelled or superseded): it ignores this result.
				if (!turn) return { messages: [] };
			}
			const start = this.turnStart(messages, turn);
			if (start < 0) {
				// Live steering converts only the queued steering batch, for a request that already carries the view.
				if (messages.length > 0 && messages.every((message) => message.role === "user" || message.role === "custom")) {
					return undefined;
				}
				throw new Refusal("OptChat refused the request: this turn's messages are missing from the host context.");
			}
			const partition = viewPartition(ctx.model);
			if (turn.partition !== partition) {
				// A model switch may change only block boundaries, never the frozen view bytes.
				turn.blocks = viewBlocks(turn.blocks.map((block) => block.text).join(""), ctx.model);
				turn.partition = partition;
			}
			// Agent-started runs (background reports in an idle session) skip before_agent_start, so the
			// memory instructions may be absent from the system prompt: carry them in front of the view.
			const view: UserMessage = {
				role: "user",
				content: ctx.getSystemPrompt().includes(SYSTEM_BLOCK)
					? turn.blocks
					: [{ type: "text", text: `${SYSTEM_BLOCK}\n\n` }, ...turn.blocks],
				timestamp: turn.timestamp,
			};
			return { messages: [view, ...messages.slice(start)] };
		} catch (error) {
			const reason = error instanceof Refusal ? error.message : `OptChat refused the request: ${errorText(error)}`;
			if (!(error instanceof Refusal) && this.state.kind === "ready") this.fail(reason);
			return this.refuse(ctx, reason);
		}
	}

	private async waitForStart(deadline: number): Promise<void> {
		let timer: Timer | undefined;
		const timeout = new Promise<void>((done) => {
			timer = setTimeout(done, Math.max(0, deadline - Date.now()));
		});
		try {
			await Promise.race([this.ready, timeout]);
		} finally {
			clearTimeout(timer);
		}
	}

	private requireReady(): Memory {
		switch (this.state.kind) {
			case "ready":
				if (this.memory) return this.memory;
				break;
			case "failed":
				throw new Refusal(this.state.reason);
			case "starting":
				throw new Refusal("OptChat refused the request: memory is still opening.");
			case "closed":
				break;
		}
		throw new Refusal("OptChat refused the request: memory is closed.");
	}

	/** Index of the turn's first message in this host list; -1 when the list does not hold the turn. */
	private turnStart(messages: AgentMessage[], turn: Turn): number {
		if (turn.first) return this.find(messages, turn.first);
		if (!turn.after) return 0;
		const after = this.find(messages, turn.after);
		return after < 0 ? -1 : after + 1;
	}

	/** Hash only messages with the target's timestamp: host lists hold the whole session history. */
	private find(messages: AgentMessage[], target: Mark): number {
		for (let index = messages.length - 1; index >= 0; index--) {
			const message = messages[index]!;
			if (stamp(message) === target.stamp && keyOf(message) === target.key) return index;
		}
		return -1;
	}

	/** Settle, snapshot the view, then log the turn's new messages: in that order. */
	private async openTurn(
		messages: AgentMessage[],
		ctx: ExtensionContext,
		memory: Memory,
		deadline: number,
	): Promise<Turn | undefined> {
		// Context calls are sequential: an unfinished earlier wait was abandoned by the host.
		if (this.pending) this.supersede(this.pending);
		// The new prompt batch and the host context queued with it: everything after the last logged message.
		let start = messages.length;
		while (start > 0) {
			const message = messages[start - 1]!;
			if (stamp(message) < this.cutoff || this.logged.has(keyOf(message))) break;
			start--;
		}
		const tail = messages.slice(start);
		const job: Pending = { controller: new AbortController(), tail, superseded: false, abandoned: false };
		this.pending = job;
		const timer = setTimeout(() => job.controller.abort(), Math.max(0, deadline - Date.now()));
		// No signal reaches context handlers; an idle session means the host stopped this run.
		const watch = setInterval(() => {
			if (!ctx.isIdle()) return;
			job.abandoned = true;
			job.controller.abort();
		}, IDLE_POLL_MS);
		let settled: boolean;
		try {
			settled = await memory.settle(job.controller.signal);
		} finally {
			clearTimeout(timer);
			clearInterval(watch);
			if (this.pending === job) this.pending = undefined;
		}
		if (job.superseded) return undefined;
		if (!settled) {
			// Durable and unanswered: the next turn's snapshot holds it.
			this.logNew(tail);
			if (job.abandoned) return undefined;
			if (this.state.kind !== "ready") throw new Refusal("OptChat refused the request: memory is closed.");
			throw new Refusal(
				`OptChat: the memory summaries were not ready after ${Math.round(this.settleTimeoutMs / 1000)} s, so nothing was sent. ` +
					"Your message is saved in the chat log, unanswered. The compressor keeps working in the background; " +
					"resend once /optchat status shows no pending work.",
			);
		}
		const first = tail[0];
		const blocks = viewBlocks(memory.render(), ctx.model);
		const timestamp = first ? stamp(first) : Date.now();
		this.logNew(tail);
		const partition = viewPartition(ctx.model);
		const turn: Turn = first
			? { blocks, partition, timestamp, first: mark(first) }
			: { blocks, partition, timestamp, after: start > 0 ? mark(messages[start - 1]!) : undefined };
		this.turn = turn;
		return turn;
	}

	private supersede(job: Pending): void {
		job.superseded = true;
		// Durable before the next turn's snapshot: the cancelled message stays in the log, unanswered.
		this.logNew(job.tail);
		job.controller.abort();
	}

	/** Log `messages`, then whatever completed while no turn was open. */
	private logNew(messages: readonly AgentMessage[]): void {
		for (const message of messages) this.logMessage(message);
		for (const message of this.held.splice(0)) this.logMessage(message);
	}

	private logMessage(message: AgentMessage): void {
		if (stamp(message) < this.cutoff) return;
		const key = keyOf(message);
		if (this.logged.has(key)) return;
		const memory = this.openMemory();
		for (const entry of entriesOf(message, this.config!.toolCap)) memory.append(entry.kind, entry.text);
		this.logged.add(key);
	}

	/** A completed message is durable at once, unless a fresh turn still needs its snapshot first. */
	messageEnd(message: AgentMessage): void {
		if (message.role === "assistant") this.releaseMainWaits();
		if (this.state.kind !== "ready" || stamp(message) < this.cutoff) return;
		try {
			if (this.turn) this.logMessage(message);
			else if (!this.logged.has(keyOf(message))) this.held.push(message);
		} catch (error) {
			this.fail(`OptChat stopped logging: ${errorText(error)}. Every prompt will be refused until restart.`);
		}
	}

	agentEnd(messages: AgentMessage[], willContinue: boolean): void {
		if (this.state.kind !== "ready") return;
		try {
			const turn = this.turn;
			if (turn) {
				const start = this.turnStart(messages, turn);
				// A late notice from an earlier run: this turn is not in its messages.
				if (start < 0) return;
				for (let index = start; index < messages.length; index++) this.logMessage(messages[index]!);
			}
			this.releaseMainWaits();
			// Retries and queued continuations stay in the turn.
			if (willContinue) return;
			this.turn = undefined;
			// A prompt cancelled before its first request stays in the log, unanswered.
			this.logNew([]);
		} catch (error) {
			this.fail(`OptChat stopped logging: ${errorText(error)}. Every prompt will be refused until restart.`);
		}
	}

	toolResult(event: ToolResultEvent): ToolResultEventResult | undefined {
		if (this.state.kind !== "ready" || TOOL_NAMES.includes(event.toolName)) return undefined;
		const cap = this.config!.toolCap;
		const text = event.content
			.filter((part): part is TextContent => part.type === "text")
			.map((part) => part.text)
			.join("\n");
		if (text.length <= cap) return undefined;
		const images = event.content.filter((part): part is ImageContent => part.type === "image");
		return { content: [{ type: "text", text: capText(text, cap) }, ...images] };
	}

	/** Prior host history is not this chat's turn; reset turn tracking for the new session. */
	sessionChanged(): void {
		this.saveUnanswered();
		this.turn = undefined;
		this.cutoff = Date.now();
		this.resetCacheFence();
	}

	async shutdown(): Promise<void> {
		this.saveUnanswered();
		this.state = { kind: "closed" };
		this.resetCacheFence();
		const memory = this.memory;
		const store = this.store;
		this.memory = undefined;
		this.store = undefined;
		await memory?.close();
		await store?.close();
	}

	/** Log a waiting prompt and messages held for a snapshot that will not come. */
	private saveUnanswered(): void {
		if (this.state.kind !== "ready") return;
		try {
			if (this.pending) this.supersede(this.pending);
			this.logNew([]);
		} catch (error) {
			this.fail(`OptChat could not save the pending messages: ${errorText(error)}. Every prompt will be refused until restart.`);
		}
	}

	// --- /optchat --------------------------------------------------------------------

	async command(args: string, ctx: ExtensionCommandContext): Promise<void> {
		const trimmed = args.trim();
		const space = trimmed.search(/\s/);
		const action = space < 0 ? trimmed : trimmed.slice(0, space);
		const argument = space < 0 ? "" : trimmed.slice(space).trim();
		try {
			switch (action) {
				case "":
				case "status":
					ctx.ui.notify(this.statusText(), "info");
					return;
				case "view":
					ctx.ui.notify(this.openMemory().render(), "info");
					return;
				case "export":
					ctx.ui.notify(this.exportTo(argument, ctx.cwd), "info");
					return;
				case "import":
					if (!ctx.isIdle()) throw new Error("wait until the agent is idle before importing");
					ctx.ui.notify(this.importFrom(argument, ctx.cwd), "info");
					return;
				default:
					throw new Error(`unknown subcommand "${action}" (use status, view, export PATH or import PATH)`);
			}
		} catch (error) {
			ctx.ui.notify(`/optchat ${action}: ${errorText(error)}`, "error");
		}
	}

	private statusText(): string {
		const state = this.state;
		const lines = [`OptChat: ${state.kind === "failed" ? `failed: ${state.reason}` : state.kind}`];
		if (this.config) {
			lines.push(`directory: ${this.store?.directory ?? this.config.directory}`);
			lines.push(`compressor: ${this.compressor ? `${this.compressor.provider}/${this.compressor.id}` : this.config.model}`);
		}
		if (this.memory) {
			const status = this.memory.status();
			lines.push(
				`messages: ${status.messages}; tree nodes: ${status.nodes}; compressor jobs running: ${status.pending}`,
				`view: ${status.parts} lines, ${status.viewBytes} of ${this.config!.viewBytes} bytes`,
			);
		}
		return lines.join("\n");
	}

	private exportTo(argument: string, cwd: string): string {
		const memory = this.openMemory();
		const path = this.pathArgument(argument, cwd);
		const html = exportHtml(memory);
		// "wx": never overwrite an existing file.
		const fd = openSync(path, "wx", 0o600);
		try {
			const bytes = Buffer.from(html, "utf8");
			let written = 0;
			while (written < bytes.length) written += writeSync(fd, bytes, written, bytes.length - written);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		return `OptChat exported ${memory.status().messages} messages to ${path}`;
	}

	private importFrom(argument: string, cwd: string): string {
		const memory = this.openMemory();
		const path = this.pathArgument(argument, cwd);
		const count = importHistory(memory, readFileSync(path, "utf8"));
		return `OptChat imported ${count} messages from ${path}`;
	}

	private pathArgument(argument: string, cwd: string): string {
		if (argument.length === 0) throw new Error("a file path is required");
		if (argument.includes("\0")) throw new Error("the path contains a NUL character");
		return resolve(cwd, argument);
	}
}

/** OptChat for OMP: active by default for the main agent, unless explicitly opted out. */
export function createOptChat(options: OptChatOptions = {}): (pi: ExtensionAPI) => void {
	const settleTimeoutMs = options.settleTimeoutMs ?? SETTLE_TIMEOUT_MS;
	if (!Number.isFinite(settleTimeoutMs) || settleTimeoutMs <= 0 || settleTimeoutMs >= HOST_HANDLER_LIMIT_MS) {
		throw new Error(`OptChat settleTimeoutMs must be above 0 and below the host's ${HOST_HANDLER_LIMIT_MS} ms handler limit`);
	}
	return (pi: ExtensionAPI): void => {
		// Flags are parsed after factories run: register unconditionally, read in session_start.
		registerFlags(pi);
		let chat: OptChat | undefined;

		pi.registerCommand("optchat", {
			description: "OptChat memory: status | view | export PATH | import PATH",
			handler: async (args, ctx) => {
				if (!chat) {
					ctx.ui.notify("OptChat is not active in this session (main sessions are active unless opted out with --no-optchat).", "info");
					return;
				}
				await chat.command(args, ctx);
			},
		});

		pi.on("session_start", async (_event, ctx) => {
			if (chat || ctx.agent.kind !== "main") return;
			try {
				if (!readEnabled(pi)) return;
			} catch {
				// Invalid activation must enter the same fail-closed startup as any other
				// malformed config: open() reports it and installed context hooks refuse prompts.
			}
			const active = new OptChat(pi, settleTimeoutMs);
			chat = active;
			// Registered only for an activated session: these hooks change host behavior even as no-ops.
			pi.on("before_agent_start", (event) => active.beforeAgentStart(event.systemPrompt));
			pi.on("context", (event, handlerCtx) => active.context(event.messages, handlerCtx));
			pi.on("before_provider_request", (event, handlerCtx) => active.beforeProviderRequest(event.payload, handlerCtx));
			pi.on("credential_disabled", () => active.resetCacheFence());
			pi.on("tool_result", (event) => active.toolResult(event));
			pi.on("message_end", (event) => active.messageEnd(event.message));
			pi.on("agent_end", (event) => active.agentEnd(event.messages, event.willContinue === true));
			// The current turn's tool loop must reach the model verbatim: no host compaction.
			pi.on("session_before_compact", () => ({ cancel: true }));
			pi.on("session_switch", () => active.sessionChanged());
			pi.on("session_branch", () => active.sessionChanged());
			pi.on("session_tree", () => active.sessionChanged());
			pi.on("session_shutdown", () => active.shutdown());
			await active.start(ctx);
		});
	};
}

export default createOptChat();
