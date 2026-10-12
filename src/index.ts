import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { clampThinkingLevelForModel, Effort } from "@oh-my-pi/pi-catalog";
import { requiresNativeTools } from "@oh-my-pi/pi-catalog/compat/tools";
import {
	completeSimple,
	type AssistantMessage,
	type ImageContent,
	type Judge,
	type JudgmentResult,
	type Message as LlmMessage,
	type Model,
	type Questions,
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
	ToolCallEvent,
	ToolCallEventResult,
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
import {
	defaultStoreDirectory,
	readConfig,
	readEnabled,
	registerFlags,
	toolGateRequested,
	type OptChatConfig,
} from "./config.js";
import { exportHtml, importHistory } from "./history.js";
import { writeExportFile } from "./export-file.js";
import { attachChildView, publishChildSource, registerMemoryTools, UNGUARDED, type ChildView, type PageEnvelope, type WorkEnvelope } from "./handoff.js";
import { appendMetric, boundedProviderError, type CompressorUsage } from "./metrics.js";
import { captureWorkReports, type ArtifactPathSource } from "./reports.js";
import type { ImageAttachment, ImageMimeType, MessageMetadata, WorkMetadata } from "./archive.js";
import { CompressorRefusedError, Memory, type CompactionRequest, type Summarize } from "./memory.js";
import { VIEW_DOC } from "./prompts.js";
import { Store, StoreLeaseConflictError, type Kind, type Message } from "./store.js";
import { boundedGateError, hostJudge, judgeWithin, sessionFallbackOf, utf8Length, type JudgeFactory, type NamedJudge } from "./system1/judge.js";
import { counted, GATE_KEYS, GATE_LABEL, GATE_PURPOSE, GateCounts, INACTIVE_REASON, type GateKey, type Judging } from "./system1/gates.js";
import { RuleLedger, renderRules, type Rule } from "./system1/ledger.js";
import { prefetchBlock, PREFETCH_MS } from "./system1/prefetch.js";
import { recall, registerRecallTool, renderRecall } from "./system1/recall.js";
import { decideTriage, offeredRules, ruleSentences, triageQuestions, triageState } from "./system1/rules.js";
import { gateToolCall } from "./system1/tool-gate.js";
import { valueHint } from "./system1/value.js";

type AgentMessage = ContextEvent["messages"][number];

/** Appended to the host system prompt; byte-identical on every request so it stays cached. */
export const SYSTEM_BLOCK = `# OptChat memory\n\n${VIEW_DOC}`;

/**
 * The host gives a context handler 30 s in total, then sends the request
 * unchanged. Startup wait and settle share one deadline that ends before that.
 */
export const SETTLE_TIMEOUT_MS = 25_000;
const HOST_HANDLER_LIMIT_MS = 30_000;
/** Absolute wall deadline for the main-model fallback after an original compressor refusal: admission, auth, lease and response. */
const MAIN_FALLBACK_DEADLINE_MS = 30_000;
const IDLE_POLL_MS = 250;
const TOOL_NAMES: readonly string[] = ["zoom", "date", "work", "chat_search"];
/** Host tools whose arguments and results are the model's private thoughts: never logged. */
const PRIVATE_TOOLS: Record<string, true> = { think: true };
const SKILL_PROMPT_MESSAGE_TYPE = "skill-prompt";
/** Host messages that deliver a background job's output into the chat. */
const BACKGROUND_RESULT_TYPES: Record<string, true> = { "async-result": true, "launch-completion": true };
/** Bound for one rules triage judgment. */
const TRIAGE_MS = 20_000;
/**
 * Triage still running at shutdown is waited for at most this long, then abandoned. It stays under the host's
 * 2 s session_shutdown handler cap, so the wait finishes inside the host's window.
 */
const SHUTDOWN_TRIAGE_MS = 1_500;
/** Prefetch uses the settle deadline's remaining time minus this margin, so it never delays past that deadline. */
const PREFETCH_MARGIN_MS = 500;

export interface OptChatOptions {
	/** Bounded wait for startup and the view's summaries before a fresh turn is refused; below 30 s. */
	settleTimeoutMs?: number;
	/** Metric-only, per completed compressor call; receives no message content or credentials. */
	onCompressorUsage?: (usage: CompressorUsage) => void;
	/**
	 * Checked before every compressor provider attempt, including retries. `false`, or a throw, fails that
	 * call closed: nothing is sent and no summary is published.
	 */
	/** Called before every compaction provider attempt with the sending model's `provider/id`; false refuses the attempt. */
	admitCompressorCall?: (model: string) => boolean | Promise<boolean>;
	/** Output cap for compressor requests, an integer from 1 to 512. Unset: the model's own maximum. */
	compressorMaxTokens?: number;
	/**
	 * The judge for each System One gate, resolved per call with the gate's purpose. Default: the host judge role.
	 * Undefined means no judge: the gate does not run, and a tool call is blocked (fail closed).
	 */
	judge?: JudgeFactory;
}

/**
 * Reasoning for a compressor call. With an explicit output cap, reasoning is off: a budget-thinking
 * request makes the SDK raise max_tokens above the cap, and provider usage.output counts reasoning
 * tokens, so the cap could not bind. Without a cap, the default (medium effort) is unchanged.
 */
export function compressorReasoning(model: Model, maxTokens: number | undefined) {
	return maxTokens === undefined ? clampThinkingLevelForModel(model, Effort.Medium) : undefined;
}

/** Compressor-call policy: admission before each provider attempt and an optional output cap. */
interface CompressorPolicy {
	readonly admit?: (model: string) => boolean | Promise<boolean>;
	readonly maxTokens?: number;
}

class Refusal extends Error {}

/** pi-ai reports a provider refusal (Anthropic `stop_reason: refusal`) as stopReason "error" with an errorMessage beginning "Refusal". */
function isProviderRefusal(reply: AssistantMessage): boolean {
	return reply.stopReason === "error" && (reply.errorMessage ?? "").startsWith("Refusal");
}

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

/** A stored image's text label and, once durable, its attachment. */
interface ImageLabel {
	readonly text: string;
	readonly attachment?: ImageAttachment;
}

/** Stores one image of a message: the label keeps its place in the text. */
type ImageSaver = (part: ImageContent, index: number) => ImageLabel;

/** Host-side capture for one message: full tool output (before the cap) and durable images. */
interface Capture {
	readonly full: (toolCallId: string) => string | undefined;
	readonly image: ImageSaver;
	/** The session's artifact lookup, used to hydrate work reports whose output was saved as an artifact. */
	readonly artifacts?: ArtifactPathSource;
}

interface Entry {
	readonly kind: Kind;
	readonly text: string;
	/** Own recorded time, for work reports; otherwise the message's. */
	readonly at?: number;
	readonly metadata?: MessageMetadata;
}

/** Matches the store's per-message image bound. */
const MAX_IMAGES = 32;

function isImageMime(value: string): value is ImageMimeType {
	return value === "image/png" || value === "image/jpeg" || value === "image/webp";
}

/** Text in content order; each image becomes its label and, once durable, its attachment at the source index. */
function contentOf(
	content: string | readonly (TextContent | ImageContent)[],
	image: ImageSaver,
): { text: string; images: ImageAttachment[] } {
	if (typeof content === "string") return { text: content, images: [] };
	const images: ImageAttachment[] = [];
	const text = content
		.map((part, index) => {
			if (part.type === "text") return part.text;
			const label: ImageLabel =
				images.length < MAX_IMAGES ? image(part, index) : { text: "[image not stored: more than 32 images]" };
			if (label.attachment) images.push(label.attachment);
			return label.text;
		})
		.join("\n");
	return { text, images };
}

function metadataOf(work: WorkMetadata | undefined, images: readonly ImageAttachment[]): MessageMetadata | undefined {
	if (work === undefined && images.length === 0) return undefined;
	return { ...(work === undefined ? {} : { work }), ...(images.length === 0 ? {} : { images }) };
}

function workOf(
	source: WorkMetadata["source"],
	completeness: WorkMetadata["completeness"],
	id: string | undefined,
	agentId: string | undefined,
): WorkMetadata {
	return {
		source,
		completeness,
		...(id === undefined ? {} : { id }),
		...(agentId === undefined ? {} : { agentId }),
	};
}

/** The newest captured work recorded under this name, among messages before `before`. */
function findWork(
	messages: readonly Message[],
	name: string,
	before: number,
): { message: Message; work: WorkMetadata } | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index]!;
		const work = message.metadata?.work;
		if (work && message.i < before && (work.id === name || work.agentId === name || work.name === name)) {
			return { message, work };
		}
	}
	return undefined;
}

/**
 * Captured work entries: one per delivered batch member, each carrying its report's own timestamp.
 * A report with an incomplete output says why, so the log never presents partial output as whole.
 */
async function workEntries(
	source: WorkMetadata["source"],
	details: unknown,
	text: string,
	images: readonly ImageAttachment[],
	at: number,
	capture: Capture,
): Promise<Entry[]> {
	const { reports } = await captureWorkReports({
		source,
		details,
		text,
		timestamp: at,
		sessionManager: capture.artifacts,
	});
	if (reports.length === 0) {
		return [{ kind: "work", text, metadata: metadataOf(workOf(source, "pointer-only", undefined, undefined), images) }];
	}
	return reports.map((report, index) => ({
		kind: "work",
		text: report.reason === undefined ? report.body : `[incomplete: ${report.reason}] ${report.body}`,
		at: report.timestamp,
		metadata: metadataOf(report.work, index === 0 ? images : []),
	}));
}

/** Completed chat entries of one host message, in order; thoughts are never logged. */
async function entriesOf(
	message: AgentMessage,
	capture: Capture,
): Promise<Entry[]> {
	switch (message.role) {
		case "user": {
			if (message.synthetic === true || message.attribution === "agent") return [];
			const { text, images } = contentOf(message.content, capture.image);
			return text.length > 0 ? [{ kind: "user", text, metadata: metadataOf(undefined, images) }] : [];
		}
		case "custom": {
			// Admission precedes extraction: a message nothing admits never reaches capture.image, so it stores no image.
			const skill = message.customType === SKILL_PROMPT_MESSAGE_TYPE && message.attribution === "user";
			const background = Object.hasOwn(BACKGROUND_RESULT_TYPES, message.customType);
			if (!skill && !background) return [];
			const { text, images } = contentOf(message.content, capture.image);
			if (text.length === 0) return [];
			// A skill invoked by the user is the user's own ask.
			if (skill) return [{ kind: "user", text, metadata: metadataOf(undefined, images) }];
			// A background job's report: work delivered to the chat, marked so it never reads as the user's words.
			const source = message.customType === "launch-completion" ? "launch-completion" : "async-result";
			return workEntries(source, message.details, text, images, stamp(message), capture);
		}
		case "assistant":
			return assistantEntries(message, capture);
		case "toolResult": {
			if (Object.hasOwn(PRIVATE_TOOLS, message.toolName)) return [];
			const { text, images } = contentOf(message.content, capture.image);
			// The live result was capped after its full text was captured; the durable log keeps all of it.
			const full = capture.full(message.toolCallId) ?? text;
			const echo = message.isError ? `[error] ${full}` : full;
			if (message.toolName !== "task") return [{ kind: "echo", text: echo, metadata: metadataOf(undefined, images) }];
			// A subagent's report is work, with the provenance the capture records from its details.
			return workEntries("task", message.details, echo, images, stamp(message), capture);
		}
		default:
			return [];
	}
}

/**
 * Talk and tool entries of a finished reply. Public image parts are stored with the talk they sit in;
 * thinking is never logged, and the store's per-message image bound applies as it does to user content.
 */
function assistantEntries(message: AssistantMessage, capture: Capture): Entry[] {
	// A stopped or failed reply never finished; the messages it never took stay unanswered.
	if (message.stopReason === "aborted" || message.stopReason === "error") return [];
	const entries: Entry[] = [];
	let talk: string[] = [];
	let images: ImageAttachment[] = [];
	let stored = 0;
	const flushTalk = () => {
		const text = talk.join("\n");
		if (text.trim().length > 0) entries.push({ kind: "talk", text, metadata: metadataOf(undefined, images) });
		talk = [];
		images = [];
	};
	message.content.forEach((part, index) => {
		if (part.type === "text") talk.push(part.text);
		else if (part.type === "image") {
			const label: ImageLabel =
				stored < MAX_IMAGES ? capture.image(part, index) : { text: "[image not stored: more than 32 images]" };
			talk.push(label.text);
			if (label.attachment) {
				images.push(label.attachment);
				stored++;
			}
		} else if (part.type === "toolCall" && !Object.hasOwn(PRIVATE_TOOLS, part.name)) {
			flushTalk();
			entries.push({ kind: "tool", text: `${part.name} ${JSON.stringify(part.arguments ?? {})}` });
		}
	});
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
	/** System One messages (rules, then prefetch), frozen at the turn's start; empty when every gate is off. */
	extra: UserMessage[];
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
	/** Lease conflict at startup: no memory and no host changes; the reason names the directory. */
	| { kind: "inactive"; reason: string }
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
	/** Compactions the compressor refused that were retried with the main model, this process. */
	private mainRetries = 0;
	private store: Store | undefined;
	private memory: Memory | undefined;
	/** Standing rules: present only when the rules gate is on and the session is ready. */
	private rules: RuleLedger | undefined;
	/** Triage jobs run one at a time in log order, each after its message is durable. */
	private triageChain: Promise<void> = Promise.resolve();
	/** Aborted at shutdown: a triage still waiting on its judge is abandoned and never writes. */
	private readonly triageAbort = new AbortController();
	/** The latest System One failure, bounded, for `/optchat status`. */
	private gateFailure: string | undefined;
	/** Per-gate judge calls, failures and outcomes, in memory, for `/optchat status` only. */
	private readonly counts = new GateCounts();
	private ready: Promise<void> = Promise.resolve();
	private turn: Turn | undefined;
	private pending: Pending | undefined;
	/** Completed messages that arrived while no turn was open: logged after the next snapshot. */
	private held: AgentMessage[] = [];
	/** Messages created before activation or a session switch are prior history, never this chat. */
	private cutoff = Date.now();
	private readonly logged = new Set<string>();
	/** Full ordinary tool output captured before the live cap; consumed by its durable log entry. */
	private readonly captured = new Map<string, string>();
	/** Keys queued for logging but not yet appended: each message is appended once, in queue order. */
	private readonly queued = new Set<string>();
	private logChain: Promise<void> = Promise.resolve();
	private unpublish: (() => void) | undefined;
	private childStatus = "off";
	private childViewEnabled = false;
	/** Bumped at each publication: a snapshot of an older session generation never reads the live chat. */
	private childGeneration = 0;
	private ctx: ExtensionContext | undefined;
	private sharedPrefix: SharedPrefix | undefined;
	private readonly cache = new OptChatCacheCoordinator();
	private cacheFence = new AbortController();
	/** Cancels main requests still waiting on compressor writers once their run moves on. */
	private mainWaits = new AbortController();

	constructor(
		private readonly pi: ExtensionAPI,
		private readonly settleTimeoutMs: number,
		private readonly observe: (usage: CompressorUsage) => void,
		private readonly policy: CompressorPolicy = {},
		private readonly judges: JudgeFactory = hostJudge,
	) {}

	/** Inactive sessions pass every host hook through unchanged: no view, no capture, no compaction veto. */
	get passive(): boolean {
		return this.state.kind === "inactive";
	}

	start(ctx: ExtensionContext): Promise<void> {
		this.ctx = ctx;
		this.cutoff = Date.now();
		this.ready = this.open(ctx).catch((error: unknown) => {
			this.fail(`OptChat is off for this session: ${errorText(error)}. Every prompt will be refused until restart.`);
		});
		return this.ready;
	}

	private async open(ctx: ExtensionContext): Promise<void> {
		const config = readConfig(this.pi, defaultStoreDirectory(this.pi.pi.getAgentDir(), ctx.cwd));
		this.config = config;
		const model = ctx.models.resolve(config.model);
		if (!model) {
			throw new Error(`compressor model "${config.model}" is not available (configure it or pass --optchat-model provider/id)`);
		}
		if (requiresNativeTools(model)) {
			throw new Error(`compressor model "${config.model}" requires native tools that cannot be disabled; choose a model with tool-free inference`);
		}
		this.compressor = model;
		let store: Store;
		try {
			store = await Store.open(config.directory, (message) => this.notify(message, "warning"));
		} catch (error) {
			// A live writer owns this directory: run without memory, as --no-optchat does. Other failures stay fail-closed.
			if (error instanceof StoreLeaseConflictError && this.state.kind === "starting") {
				this.inactivate(`${config.directory} is in use by another session`);
				return;
			}
			throw error;
		}
		if (this.state.kind !== "starting") {
			await store.close();
			return;
		}
		let rules: RuleLedger | undefined;
		try {
			rules = config.gates.rules ? RuleLedger.open(store.directory) : undefined;
			this.registerTools();
			if (config.gates.recall) this.registerRecall();
		} catch (error) {
			await store.close();
			throw error;
		}
		this.store = store;
		this.rules = rules;
		this.memory = new Memory(store, this.summarize, {
			nodeBytes: config.nodeBytes,
			viewBytes: config.viewBytes,
			jobs: config.jobs,
			tries: config.tries,
			report: (message) => this.notify(`OptChat compressor: ${message}`, "warning"),
			// Requested only when the value-score gate is on: with it off, the compressor is never asked for a hint.
			hint: config.gates.valueScore ? (source, signal) => this.valueHintFor(source, signal) : undefined,
		});
		this.state = { kind: "ready" };
		this.childViewEnabled = config.childView;
		if (config.childView) this.publishChildView(ctx);
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
		registerMemoryTools(this.pi, {
			zoom: (id, n, offset, depth) => this.withImages(this.openMemory().zoom(id, n, offset, depth), id, n, offset),
			date: (id) => this.openMemory().date(id),
			work: (name, offset) => this.workEnvelope(name, offset, Number.POSITIVE_INFINITY),
			search: (query, options) => this.openMemory().search(query, options),
		}, UNGUARDED);
	}

	/** The recall gate's tool: a judge-guided descent from a view line to one stored message. Main sessions only. */
	private registerRecall(): void {
		if (this.pi.getAllTools().some((tool) => tool.name === "chat_recall")) {
			throw new Error('tool name "chat_recall" is already registered');
		}
		registerRecallTool(this.pi, (question, current, signal) => this.recallFor(question, current, signal));
	}

	private async recallFor(question: string, current: ExtensionContext | undefined, signal: AbortSignal | undefined): Promise<string> {
		const memory = this.openMemory();
		const config = this.config!;
		const ctx = current ?? this.ctx;
		const judging = ctx ? this.judgingFor(ctx, "recall") : undefined;
		// The tool stays registered, so tool definitions do not change with the judge; the call says why it did nothing.
		if (judging?.kind === "inactive") return `[optchat recall] inactive: ${INACTIVE_REASON}; use chat_search or zoom`;
		if (judging?.kind !== "judge") {
			this.gateFail("recall", "no judge candidate");
			throw new Error("chat_recall needs the judge role, which has no usable candidate; use chat_search or zoom");
		}
		const outcome = await recall(
			{
				viewLines: () => memory.viewLines(true),
				lineAt: (id, n) => memory.lineAt(id, n),
				page: (id) => memory.zoom(id, 1, 0),
			},
			{ judge: judging.judge, question, min: config.gates.recallMin, signal },
		);
		this.counts.add("recall", outcome.kind === "found" ? "answered" : outcome.kind);
		if (outcome.kind === "failed") this.gateFail("recall", outcome.reason);
		return renderRecall(outcome);
	}

	/** Child sessions get a frozen read-only snapshot, revoked when this chat shuts down. */
	private publishChildView(ctx: ExtensionContext): void {
		this.unpublish?.();
		this.unpublish = undefined;
		const manager = ctx.sessionManager.getArtifactManager();
		if (!manager) {
			this.childStatus = "unavailable: this session has no artifact manager";
			return;
		}
		const memory = this.openMemory();
		const generation = ++this.childGeneration;
		this.unpublish = publishChildSource(manager, {
			owner: `parent chat generation ${generation}`,
			snapshot: () => this.childSnapshot(memory, generation),
		});
		this.childStatus = "published (read-only snapshot per subagent)";
	}

	private childSnapshot(memory: Memory, generation: number): ChildView {
		const live = (): Memory => {
			if (this.state.kind !== "ready" || this.memory !== memory || this.childGeneration !== generation) {
				throw new Error("the parent chat is closed");
			}
			return memory;
		};
		const upperBound = live().status().messages;
		const within = (id: number, n: number): void => {
			if (id + n > upperBound) throw new Error(`message ${id} is not in the parent snapshot (${upperBound} messages)`);
		};
		return {
			render: memory.render(),
			upperBound,
			zoom: (id, n, offset, depth) => {
				within(id, n);
				return this.withImages(live().zoom(id, n, offset, depth), id, n, offset);
			},
			date: (id) => {
				within(id, 1);
				return live().date(id);
			},
			work: (name, offset) => {
				live();
				return this.workEnvelope(name, offset, upperBound);
			},
			search: (query, options) => {
				// Hits come only from messages the snapshot already holds.
				return live().search(query, { ...options, before: Math.min(options.before ?? upperBound, upperBound) });
			},
		};
	}

	private openStore(): Store {
		const store = this.store;
		if (this.state.kind !== "ready" || !store) throw new Error("OptChat store is not open");
		return store;
	}

	/** A durable image attachment, or an explicit label when the image cannot be stored. */
	private storeImage(part: ImageContent, index: number): ImageLabel {
		if (!isImageMime(part.mimeType)) return { text: "[image not stored: unsupported format]" };
		try {
			const descriptor = this.openStore().saveImage(part.data, part.mimeType);
			return { text: "[image]", attachment: { ...descriptor, order: index } };
		} catch (error) {
			return { text: `[image not stored: ${errorText(error)}]` };
		}
	}

	/** One page of a captured report, found by name among messages before `before`. */
	private workEnvelope(name: string, offset: number, before: number): WorkEnvelope {
		const store = this.openStore();
		const found = findWork(store.messages, name, before);
		if (!found) throw new Error(`no captured work is recorded as "${name}"`);
		const page = this.withImages(store.readMessagePage(found.message.i, offset), found.message.i, 1, offset);
		return { page, messageId: found.message.i, source: found.work.source, completeness: found.work.completeness };
	}

	/** A record's first page carries its stored images in source order; later pages and summaries carry none. */
	private withImages<Page extends PageEnvelope>(page: Page, id: number, n: number, offset: number): Page {
		if (n !== 1 || offset !== 0) return page;
		const images = this.openStore().readMessageImages(id).map(({ attachment, data }) => ({ data, mimeType: attachment.mimeType }));
		return images.length === 0 ? page : { ...page, images };
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

	/** Metric-only: counts and timing of one completed compressor call; never its content. */
	private observeUsage(model: Model, reply: AssistantMessage, feedback: number, latencyMs: number): void {
		const total = reply.usage.cost.total;
		try {
			this.observe({
				model: `${model.provider}/${model.id}`,
				input: reply.usage.input,
				output: reply.usage.output,
				cacheRead: reply.usage.cacheRead,
				cacheWrite: reply.usage.cacheWrite,
				attempt: feedback + 1,
				purpose: feedback > 0 ? "shorten" : "leaf",
				latencyMs: Math.round(latencyMs),
				costUsd: Number.isFinite(total) ? total : null,
				stopReason: reply.stopReason,
				error: reply.stopReason === "error" || reply.stopReason === "aborted" ? boundedProviderError(reply.errorMessage) : null,
			});
		} catch (error) {
			this.notify(`OptChat metrics: ${errorText(error)}`, "warning");
		}
	}

	private async compress(request: CompactionRequest, signal: AbortSignal): Promise<string> {
		const compressor = this.compressor;
		const ctx = this.ctx;
		if (!compressor || !ctx) throw new Error("Compressor model is not configured");
		let model = compressor;
		let reply = await this.compressorReply(compressor, ctx, request, signal);
		if (isProviderRefusal(reply)) {
			const main = this.mainFallback(compressor, ctx);
			if (main) {
				// A cancelled original call never reaches the fallback: no send, no counter, no warning.
				signal.throwIfAborted();
				this.mainRetries++;
				this.notify(
					`OptChat: the compressor ${compressor.provider}/${compressor.id} refused a compaction; retrying it once with the main model ${main.provider}/${main.id}.`,
					"warning",
				);
				model = main;
				reply = await this.mainFallbackReply(main, ctx, request, signal);
			}
			// Still refused, or no distinct main model: Memory commits a source-derived stand-in for this node.
			if (isProviderRefusal(reply)) throw new CompressorRefusedError();
		}
		return this.summaryText(model, reply);
	}

	/**
	 * The main-model fallback under one absolute wall deadline. The race is independent of the provider: an attempt
	 * that ignores its signal cannot hold the node open. Deadline expiry is the terminal refusal; a cancelled parent
	 * stays a cancellation and never becomes a stand-in.
	 */
	private async mainFallbackReply(
		main: Model,
		ctx: ExtensionContext,
		request: CompactionRequest,
		parent: AbortSignal,
	): Promise<AssistantMessage> {
		parent.throwIfAborted();
		const lapse = new AbortController();
		const signal = AbortSignal.any([parent, lapse.signal]);
		const timer = setTimeout(() => lapse.abort(), MAIN_FALLBACK_DEADLINE_MS);
		const stopped = new Promise<never>((_, reject) => {
			signal.addEventListener(
				"abort",
				() => {
					if (parent.aborted) {
						reject(parent.reason);
						return;
					}
					this.notify(
						`OptChat: the main-model fallback ${main.provider}/${main.id} did not finish within ${MAIN_FALLBACK_DEADLINE_MS / 1000} s; committing an unsummarized stand-in.`,
						"warning",
					);
					reject(new CompressorRefusedError());
				},
				{ once: true },
			);
		});
		try {
			return await Promise.race([this.compressorReply(main, ctx, request, signal), stopped]);
		} finally {
			clearTimeout(timer);
		}
	}

	/** The live main model as a compaction fallback; none when it is the compressor, absent, or needs native tools. */
	private mainFallback(compressor: Model, ctx: ExtensionContext): Model | undefined {
		const main = ctx.model;
		if (!main || (main.provider === compressor.provider && main.id === compressor.id)) return undefined;
		return requiresNativeTools(main) ? undefined : main;
	}

	/** One admitted provider attempt with `model`. Admission, cache coordination and metering are identical for every model. */
	private async compressorReply(
		model: Model,
		ctx: ExtensionContext,
		request: CompactionRequest,
		signal: AbortSignal,
	): Promise<AssistantMessage> {
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
		const started = performance.now();
		// Admission precedes every send. The first attempt is admitted here, before the request can be
		// dispatched on any provider path; later payloads (SDK retries) are admitted by onPayload.
		const selector = `${model.provider}/${model.id}`;
		signal.throwIfAborted();
		if (this.policy.admit && !(await this.policy.admit(selector))) throw new Error("compressor call was not admitted");
		// Admission may have outlived a cancellation or deadline: an abandoned call sends nothing.
		signal.throwIfAborted();
		let admitted = true;
		let sends = 0;
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
				maxTokens: this.policy.maxTokens,
				reasoning: compressorReasoning(model, this.policy.maxTokens),
				onPayload: async (payload, payloadModel, attemptSignal) => {
					// Auth/provider retries must release their own previous attempt before waiting.
					finish();
					// An abandoned attempt (cancelled or lapsed) is never counted, admitted, leased, or sent.
					signal.throwIfAborted();
					// The first payload is the attempt admitted above; each retry is admitted before its send.
					sends += 1;
					if (sends > 1) {
						admitted = this.policy.admit ? await this.policy.admit(selector) : true;
						if (!admitted) throw new Error("compressor call was not admitted");
					}
					signal.throwIfAborted();
					const actualModel = payloadModel ?? model;
					const encoded = applyOptChatCache(this.alignPrefix(payload, actualModel, ctx), actualModel);
					// This request's own onResponse/finally release the lease: the only correlated writer.
					release = await this.cache.acquire(encoded, actualModel, {
						signal: attemptSignal ? AbortSignal.any([signal, attemptSignal]) : signal,
					});
					// The lease wait may have outlived the attempt: give it back before any send.
					if (signal.aborted) {
						finish();
						signal.throwIfAborted();
					}
					return encoded;
				},
				onResponse: (response) => finish(response.status >= 200 && response.status < 300),
			},
		).finally(() => finish());
		// A refused attempt was never sent: it is not a completed call and writes no metric line.
		if (!admitted) throw new Error("compressor call was not admitted");
		this.observeUsage(model, reply, request.feedback.length, performance.now() - started);
		return reply;
	}

	/** The summary text of a completed reply. Provider errors, aborts and tool calls are never summaries. */
	private summaryText(model: Model, reply: AssistantMessage): string {
		if (reply.stopReason === "error" || reply.stopReason === "aborted") {
			const status = reply.errorStatus === undefined ? "" : ` (HTTP ${reply.errorStatus})`;
			const detail = boundedProviderError(reply.errorMessage);
			throw new Error(`${model.provider}/${model.id} request ${reply.stopReason === "error" ? "failed" : "was aborted"}${status}${detail ? `: ${detail}` : ""}`);
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

	/** Lease conflict at startup: the session runs without memory, exactly like --no-optchat, and says why once. */
	private inactivate(reason: string): void {
		this.state = { kind: "inactive", reason };
		this.notify(`OptChat is inactive: ${reason}. Use --optchat-dir for a separate memory.`, "warning");
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
			// A side turn is not this chat's turn: it passes through before any turn, pending, log or cutoff use.
			if (this.state.kind === "ready" && this.isSideTurn(messages, ctx)) return undefined;
			if (this.state.kind === "starting") await this.waitForStart(deadline);
			// Inactive (startup lease conflict): the request passes through untouched.
			if (this.state.kind === "inactive") return undefined;
			const memory = this.requireReady();
			const active = new Set(this.pi.getActiveTools());
			if (!TOOL_NAMES.every((name) => active.has(name))) {
				throw new Refusal(`OptChat refused the request: the ${TOOL_NAMES.join(", ")} tools are not active in this session.`);
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
			return { messages: [view, ...turn.extra, ...messages.slice(start)] };
		} catch (error) {
			const reason = error instanceof Refusal ? error.message : `OptChat refused the request: ${errorText(error)}`;
			if (!(error instanceof Refusal) && this.state.kind === "ready") this.fail(reason);
			return this.refuse(ctx, reason);
		}
	}

	/**
	 * A side turn (/btw, recap) sends a snapshot of the session plus host-authored agent messages. The
	 * session never persists those, so an unlogged tail made only of them, absent from the branch, is a
	 * side turn. A user-attributed message, even one that mimics a recap, is always this chat's input.
	 */
	private isSideTurn(messages: AgentMessage[], ctx: ExtensionContext): boolean {
		const tail = messages.slice(this.unloggedStart(messages));
		if (tail.length === 0) return false;
		const agentAuthored = tail.every(
			(message) => (message.role === "developer" || message.role === "user") && message.attribution === "agent",
		);
		if (!agentAuthored) return false;
		const persisted = new Set(
			ctx.sessionManager.getBranch().flatMap((entry) => ("message" in entry ? [keyOf(entry.message)] : [])),
		);
		return tail.every((message) => !persisted.has(keyOf(message)));
	}

	/** Index where the unlogged suffix starts: the new prompt batch and the host context queued with it. */
	private unloggedStart(messages: AgentMessage[]): number {
		let start = messages.length;
		while (start > 0) {
			const message = messages[start - 1]!;
			if (stamp(message) < this.cutoff || this.logged.has(keyOf(message))) break;
			start--;
		}
		return start;
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
			case "inactive":
				throw new Refusal(`OptChat refused the request: ${this.state.reason}.`);
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
		const start = this.unloggedStart(messages);
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
			// Only the deadline aborts this wait. A false settle without it is a failed summary, retried on the next append.
			if (!job.controller.signal.aborted) {
				throw new Refusal(
					"OptChat: a memory summary failed and is retried only when the next message is saved, so nothing was sent. " +
						"Your message is saved in the chat log, unanswered. Send it again to retry the summary.",
				);
			}
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
			? { blocks, partition, timestamp, extra: [], first: mark(first) }
			: { blocks, partition, timestamp, extra: [], after: start > 0 ? mark(messages[start - 1]!) : undefined };
		this.turn = turn;
		// Frozen with the view: every request of this turn carries the same System One messages.
		turn.extra = await this.extraFor(tail, memory, ctx, deadline, timestamp);
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

	/** Queue one message's durable entries. The cutoff and the full output are fixed now, at queue time. */
	private logMessage(message: AgentMessage): void {
		if (stamp(message) < this.cutoff) return;
		const key = keyOf(message);
		if (this.logged.has(key) || this.queued.has(key)) return;
		this.queued.add(key);
		const at = stamp(message);
		const full = message.role === "toolResult" ? this.captured.get(message.toolCallId) : undefined;
		const capture: Capture = {
			full: () => full,
			image: (part, index) => this.storeImage(part, index),
			artifacts: this.ctx?.sessionManager,
		};
		this.enqueue(async () => {
			const memory = this.openMemory();
			const date = Number.isFinite(at) ? new Date(at) : undefined;
			let typed: { source: number; text: string } | undefined;
			for (const entry of await entriesOf(message, capture)) {
				const stored = memory.append(entry.kind, entry.text, entry.at === undefined ? date : new Date(entry.at), entry.metadata);
				// Only a user's own text can state a rule. Skill prompts, reports and agent-authored messages never reach here as role user.
				if (message.role === "user" && entry.kind === "user") typed = { source: stored.i, text: entry.text };
			}
			if (message.role === "toolResult") this.captured.delete(message.toolCallId);
			this.queued.delete(key);
			this.logged.add(key);
			// Triage starts only now: the message is durable, and the chain keeps log order.
			if (typed && this.rules && this.ctx) this.queueTriage(typed.source, typed.text, this.ctx);
		});
	}

	/** Appends run one at a time, in queue order. A failed append stops logging; later tasks never run. */
	private enqueue(task: () => Promise<void>): void {
		this.logChain = this.logChain
			.then(() => (this.state.kind === "ready" ? task() : undefined))
			.catch((error: unknown) => {
				this.fail(`OptChat stopped logging: ${errorText(error)}. Every prompt will be refused until restart.`);
			});
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

	/** The returned promise settles once every queued entry of this run is durable. */
	agentEnd(messages: AgentMessage[], willContinue: boolean): Promise<void> {
		this.endTurn(messages, willContinue);
		return this.logChain;
	}

	private endTurn(messages: AgentMessage[], willContinue: boolean): void {
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
		// Capture before the cap: the durable log keeps this full text.
		this.captured.set(event.toolCallId, text);
		const images = event.content.filter((part): part is ImageContent => part.type === "image");
		return { content: [{ type: "text", text: capText(text, cap) }, ...images] };
	}

	/** Prior host history is not this chat's turn; reset turn tracking for the new session. */
	sessionChanged(ctx: ExtensionContext): void {
		this.saveUnanswered();
		this.turn = undefined;
		this.cutoff = Date.now();
		this.captured.clear();
		this.resetCacheFence();
		// The child view belongs to the session it was published from: revoke it, then publish the new session's.
		this.unpublish?.();
		this.unpublish = undefined;
		if (this.childViewEnabled && this.state.kind === "ready") this.publishChildView(ctx);
	}

	async shutdown(): Promise<void> {
		this.saveUnanswered();
		// Queued appends settle while the store is still open.
		await this.logChain;
		// Triage still judging gets a short wait, then is abandoned: it must never write once the store closes.
		await this.settleTriage();
		this.triageAbort.abort();
		this.rules?.close();
		this.rules = undefined;
		this.state = { kind: "closed" };
		this.unpublish?.();
		this.unpublish = undefined;
		this.captured.clear();
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
				case "rules":
					ctx.ui.notify(this.rulesCommand(argument), "info");
					return;
				default:
					throw new Error(`unknown subcommand "${action}" (use status, view, export PATH, import PATH or rules [remove ID])`);
			}
		} catch (error) {
			ctx.ui.notify(`/optchat ${action}: ${errorText(error)}`, "error");
		}
	}

	private statusText(): string {
		const state = this.state;
		const lines = [`OptChat: ${state.kind === "failed" || state.kind === "inactive" ? `${state.kind}: ${state.reason}` : state.kind}`];
		if (this.config) {
			lines.push(`directory: ${this.store?.directory ?? this.config.directory}`);
			lines.push(`compressor: ${this.compressor ? `${this.compressor.provider}/${this.compressor.id}` : this.config.model}`);
		}
		if (this.memory) {
			const status = this.memory.status();
			lines.push(
				`messages: ${status.messages}; tree nodes: ${status.nodes}; compressor jobs running: ${status.pending}`,
				`view: ${status.parts} lines, ${status.viewBytes} of ${this.config!.viewBytes} bytes`,
				`compressor fallbacks: ${this.mainRetries} main-model retries; ${status.extractive} unsummarized stand-ins`,
			);
		}
		lines.push(...this.gateStatus());
		lines.push(
			`stateless OpenAI: ${process.env.PI_OPENAI_STATEFUL === "0" ? "requested (PI_OPENAI_STATEFUL=0)" : "not set; official OpenAI main requests may chain responses"}`,
			`settlement deadline: ${this.settleTimeoutMs} ms (host handler limit ${HOST_HANDLER_LIMIT_MS} ms)`,
			"host maintenance: automatic compaction can bypass the plugin veto; OptChat cannot disable it",
			"correlation: main provider responses carry no request identity; cache writers are compressor-only",
			`child view: ${this.childStatus}`,
			"side turns (/btw, recaps): the host gives no typed purpose; see issue #1",
		);
		return lines.join("\n");
	}

	// --- System One (opt-in gates) --------------------------------------------------

	/** The judge factory's answer for one gate. A factory that throws is recorded as a failure and counts as no judge. */
	private factoryJudge(ctx: ExtensionContext, gate: GateKey): Judge | undefined {
		try {
			return this.judges(ctx, GATE_PURPOSE[gate]);
		} catch (error) {
			this.gateFail(gate, error);
			return undefined;
		}
	}

	/**
	 * How one gate may judge. The session-model fallback serves only the tool gate; every other gate is inactive on it,
	 * which is not a failure and records nothing. Each judgment of a returned judge is counted for `/optchat status`.
	 */
	private judgingFor(ctx: ExtensionContext, gate: GateKey): Judging {
		const judge = this.factoryJudge(ctx, gate);
		if (!judge) return { kind: "none" };
		if (gate !== "toolGate" && sessionFallbackOf(judge)) return { kind: "inactive" };
		return { kind: "judge", judge: counted(judge, () => this.counts.add(gate, "calls")) };
	}

	/** Records the latest System One failure for `/optchat status`, bounded and without model output. */
	private gateFail(gate: GateKey, reason: unknown): void {
		this.gateFailure = `${GATE_LABEL[gate]}: ${boundedGateError(reason)}`;
		this.counts.add(gate, "failures");
	}

	/** A tool call, screened by the judge when the tool gate is on. A failed judgment, or no judge, fails closed. */
	async toolCall(event: ToolCallEvent, ctx: ExtensionContext): Promise<ToolCallEventResult | undefined> {
		const config = this.config;
		// Without a config, the gate cannot know its threshold: block rather than run unscreened.
		if (!config) return { block: true, reason: "OptChat tool gate blocked the call: OptChat did not open." };
		const judging = this.judgingFor(ctx, "toolGate");
		return gateToolCall(
			{ toolName: event.toolName, input: event.input, cwd: ctx.cwd },
			{
				judge: judging.kind === "judge" ? judging.judge : undefined,
				toolAsk: config.gates.toolAsk,
				ui: { hasUI: ctx.hasUI, confirm: (title, message) => ctx.ui.confirm(title, message) },
				report: (failure) => this.gateFail("toolGate", failure),
				outcome: (result) => this.counts.add("toolGate", result),
			},
		);
	}

	/** The System One messages of one turn, frozen at its start: the rules block, then the prefetch block. */
	private async extraFor(
		tail: AgentMessage[],
		memory: Memory,
		ctx: ExtensionContext,
		deadline: number,
		timestamp: number,
	): Promise<UserMessage[]> {
		const extra: UserMessage[] = [];
		const rules = this.rules?.active() ?? [];
		if (rules.length > 0) extra.push({ role: "user", content: [{ type: "text", text: renderRules(rules) }], timestamp });
		const block = await this.prefetch(tail, memory, ctx, deadline);
		if (block !== undefined) extra.push({ role: "user", content: [{ type: "text", text: block }], timestamp });
		return extra;
	}

	/** The prefetch block for the newest user message of the turn; undefined when it does not apply or fails open. */
	private async prefetch(tail: AgentMessage[], memory: Memory, ctx: ExtensionContext, deadline: number): Promise<string | undefined> {
		const config = this.config;
		if (!config?.gates.prefetch) return undefined;
		const newest = tail.findLast((message) => message.role === "user");
		const message = newest?.role === "user"
			? typeof newest.content === "string"
				? newest.content
				: newest.content.filter((part): part is TextContent => part.type === "text").map((part) => part.text).join("\n")
			: undefined;
		// No judge is resolved unless there is a merged line to judge and time left within the settle deadline.
		const remaining = Math.min(PREFETCH_MS, deadline - Date.now() - PREFETCH_MARGIN_MS);
		if (message === undefined || message.length === 0 || remaining <= 0 || !memory.viewLines().some((line) => line.n >= 2)) {
			return undefined;
		}
		const judging = this.judgingFor(ctx, "prefetch");
		if (judging.kind === "inactive") return undefined;
		if (judging.kind === "none") {
			this.gateFail("prefetch", "no judge candidate");
			return undefined;
		}
		let block: string | undefined;
		try {
			block = await prefetchBlock(memory, {
				judge: judging.judge,
				message,
				k: config.gates.prefetchK,
				min: config.gates.prefetchMin,
				timeoutMs: remaining,
			});
		} catch (error) {
			this.gateFail("prefetch", error);
			return undefined;
		}
		if (block !== undefined) {
			this.counts.add("prefetch", "blocks");
			this.counts.add("prefetch", "bytes", utf8Length(block));
		}
		return block;
	}

	/** Queues one durable user message for triage. The chain runs in log order and never rejects. */
	private queueTriage(source: number, text: string, ctx: ExtensionContext): void {
		this.triageChain = this.triageChain
			.then(() => this.triage(source, text, ctx))
			.catch((error: unknown) => this.gateFail("rules", error));
	}

	/** One triage: one judge request, then add, replace, or nothing. Fails open: a failure changes no rule. */
	private async triage(source: number, text: string, ctx: ExtensionContext): Promise<void> {
		const ledger = this.rules;
		const config = this.config;
		const abort = this.triageAbort.signal;
		if (!ledger || !config || abort.aborted) return;
		const offered = offeredRules(ledger.active());
		const judging = this.judgingFor(ctx, "rules");
		if (judging.kind === "inactive") return;
		if (judging.kind === "none") {
			this.gateFail("rules", "no judge candidate");
			return;
		}
		const sentences = ruleSentences(text);
		let result: JudgmentResult<Questions>;
		try {
			result = await judgeWithin(
				judging.judge,
				{ state: triageState(text, sentences), questions: triageQuestions(offered, sentences) },
				TRIAGE_MS,
				abort,
			);
		} catch (error) {
			if (!abort.aborted) this.gateFail("rules", error);
			return;
		}
		// Shutdown began while the judge answered: the ledger is closing, so nothing is written.
		if (abort.aborted) return;
		const decision = decideTriage(result.answers, offered, config.gates.ruleAdd, text, sentences);
		if (decision.kind === "none") return;
		let rule: Rule;
		try {
			rule = decision.kind === "add"
				? ledger.add(source, decision.text, Date.now())
				: ledger.replace(decision.replaces, source, decision.text, Date.now());
		} catch (error) {
			this.gateFail("rules", error);
			return;
		}
		this.counts.add("rules", decision.kind === "add" ? "added" : "replaced");
		const change = decision.kind === "add" ? "added" : `replaced ${decision.replaces}`;
		this.notify(`OptChat rule ${rule.id} ${change} from message ${source}: ${rule.text}\nUndo with /optchat rules remove ${rule.id}.`, "info");
	}

	/** Waits for queued triage at most SHUTDOWN_TRIAGE_MS. The caller then aborts whatever still runs. */
	private async settleTriage(): Promise<void> {
		const { promise: bound, resolve } = Promise.withResolvers<void>();
		const timer = setTimeout(resolve, SHUTDOWN_TRIAGE_MS);
		try {
			await Promise.race([this.triageChain, bound]);
		} finally {
			clearTimeout(timer);
		}
	}

	/** The compressor's importance hint for one leaf; undefined when the judge is missing or fails. */
	private async valueHintFor(source: { kind: Kind; text: string }, signal: AbortSignal): Promise<string | undefined> {
		const ctx = this.ctx;
		const judging = ctx ? this.judgingFor(ctx, "valueScore") : undefined;
		if (judging?.kind !== "judge") return undefined;
		const hint = await valueHint(judging.judge, source, signal);
		if (hint !== undefined) this.counts.add("valueScore", "hints");
		return hint;
	}

	/** `/optchat status` lines for the System One gates. With every gate off there are none: status matches v0.5.0. */
	private gateStatus(): string[] {
		const gates = this.config?.gates;
		if (!gates || !(gates.rules || gates.prefetch || gates.valueScore || gates.toolGate || gates.recall)) return [];
		const flag = (on: boolean) => (on ? "on" : "off");
		const lines = [
			`System One gates: rules ${flag(gates.rules)}, prefetch ${flag(gates.prefetch)}, value-score ${flag(gates.valueScore)}, tool-gate ${flag(gates.toolGate)}, recall ${flag(gates.recall)}`,
		];
		const judge = this.ctx ? this.factoryJudge(this.ctx, "toolGate") : undefined;
		const model = (judge as NamedJudge | undefined)?.primaryModel?.();
		const fallback = judge !== undefined && sessionFallbackOf(judge);
		lines.push(
			`judge: ${model ? `${model.provider}/${model.id}` : "none (the judge role has no credentialed candidate, or resolving it failed)"}${fallback ? " (session model fallback: the judge role has no native candidate; only the tool gate runs)" : ""}`,
		);
		if (fallback) {
			for (const gate of GATE_KEYS) {
				if (gates[gate] && gate !== "toolGate") lines.push(`${GATE_LABEL[gate]} inactive: ${INACTIVE_REASON}`);
			}
		}
		if (gates.rules) lines.push(`standing rules: ${this.rules?.active().length ?? 0} active`);
		lines.push(`last System One failure: ${this.gateFailure ?? "none"}`);
		lines.push(...this.counts.lines(gates));
		return lines;
	}

	/** `/optchat rules` lists standing rules; `/optchat rules remove ID` removes one. */
	private rulesCommand(argument: string): string {
		const ledger = this.rules;
		if (!ledger) throw new Error("standing rules are off or unavailable (they are on unless the session started with --no-optchat-rules)");
		if (argument.length === 0) {
			const active = ledger.active();
			if (active.length === 0) return "OptChat has no standing rules.";
			return ["OptChat standing rules:", ...active.map((rule) => `${rule.id} [${rule.source}] ${rule.text}`)].join("\n");
		}
		const [verb, id, ...extra] = argument.split(/\s+/);
		if (verb !== "remove" || id === undefined || extra.length > 0) {
			throw new Error("usage: /optchat rules | /optchat rules remove ID");
		}
		if (!ledger.remove(id, Date.now())) throw new Error(`no active rule ${id}`);
		return `OptChat rule ${id} removed.`;
	}

	private exportTo(argument: string, cwd: string): string {
		const memory = this.openMemory();
		const path = this.pathArgument(argument, cwd);
		writeExportFile(path, Buffer.from(exportHtml(memory), "utf8"));
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
	const maxTokens = options.compressorMaxTokens;
	if (maxTokens !== undefined && (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 512)) {
		throw new Error("OptChat compressorMaxTokens must be an integer from 1 to 512");
	}
	const policy: CompressorPolicy = { admit: options.admitCompressorCall, maxTokens };
	const judges: JudgeFactory = options.judge ?? hostJudge;
	return (pi: ExtensionAPI): void => {
		// Flags are parsed after factories run: register unconditionally, read in session_start.
		registerFlags(pi);
		let chat: OptChat | undefined;
		const metricsFile = process.env.OPTCHAT_METRICS_FILE;
		const observe = (usage: CompressorUsage): void => {
			options.onCompressorUsage?.(usage);
			if (metricsFile) appendMetric(metricsFile, usage);
		};

		pi.registerCommand("optchat", {
			description: "OptChat memory: status | view | export PATH | import PATH | rules [remove ID]",
			handler: async (args, ctx) => {
				if (!chat) {
					ctx.ui.notify("OptChat is not active in this session (main sessions are active unless opted out with --no-optchat).", "info");
					return;
				}
				await chat.command(args, ctx);
			},
		});

		pi.on("session_start", async (_event, ctx) => {
			if (ctx.agent.kind !== "main") {
				attachChildView(pi, ctx, SYSTEM_BLOCK);
				return;
			}
			if (chat) return;
			try {
				if (!readEnabled(pi)) return;
			} catch {
				// Invalid activation must enter the same fail-closed startup as any other
				// malformed config: open() reports it and installed context hooks refuse prompts.
			}
			const active = new OptChat(pi, settleTimeoutMs, observe, policy, judges);
			chat = active;
			// Registered for every opted-in main session. An inactive one (startup lease conflict) passes through.
			pi.on("before_agent_start", (event) => (active.passive ? undefined : active.beforeAgentStart(event.systemPrompt)));
			pi.on("context", (event, handlerCtx) => active.context(event.messages, handlerCtx));
			pi.on("before_provider_request", (event, handlerCtx) => (active.passive ? undefined : active.beforeProviderRequest(event.payload, handlerCtx)));
			pi.on("credential_disabled", () => active.resetCacheFence());
			pi.on("tool_result", (event) => active.toolResult(event));
			// Registered only when the gate is requested (a malformed value requests it too, so it fails closed).
			if (toolGateRequested(pi)) pi.on("tool_call", (event, toolCtx) => active.toolCall(event, toolCtx));
			pi.on("message_end", (event) => active.messageEnd(event.message));
			pi.on("agent_end", (event) => active.agentEnd(event.messages, event.willContinue === true));
			// The current turn's tool loop must reach the model verbatim: no host compaction.
			pi.on("session_before_compact", () => (active.passive ? undefined : { cancel: true }));
			pi.on("session_switch", (_event, switchCtx) => active.sessionChanged(switchCtx));
			pi.on("session_branch", (_event, branchCtx) => active.sessionChanged(branchCtx));
			pi.on("session_tree", (_event, treeCtx) => active.sessionChanged(treeCtx));
			pi.on("session_shutdown", () => active.shutdown());
			await active.start(ctx);
		});
	};
}

export default createOptChat();
