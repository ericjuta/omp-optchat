import { createHash, type Hash } from "node:crypto";
import { isOfficialCodexApiUrl, resolveCacheRetention, type Model, type TextContent } from "@oh-my-pi/pi-ai";

/**
 * Provider prompt-cache metadata for the OptChat view.
 *
 * Official Anthropic routes that keep text blocks separate use four-line
 * blocks. Every other route retains the fixed offset blocks used for explicit
 * Responses caching. This module marks the
 * stable cuts with each supported vendor's real wire field, after the host has
 * encoded the request. It never changes text, order, reasoning items, or a
 * continuation (`previous_response_id`) request; unsupported models, endpoints
 * and shapes come back as the same reference. Placing a marker is not proof
 * that the provider accepted it or served a hit.
 */

const VIEW_MARKS = [50_000, 80_000, 100_000] as const;
/** Anthropic and OpenAI explicit caching both accept at most four breakpoints per request. */
const MAX_BREAKPOINTS = 4;
const ANTHROPIC_URL = "https://api.anthropic.com";
/** A rendered view: `<chat>`, one `id+n|text` line per part, `</chat>` (Memory.render). */
const CHAT_VIEW = /^<chat>\n(?:\d+\+[1-9]\d*\|[^\n]*\n)*<\/chat>$/;
/** Fields of a plain host text block; anything else (citations, files) is never treated as the view. */
const VIEW_BLOCK_FIELDS: Record<string, true> = {
	type: true,
	text: true,
	cache_control: true,
	prompt_cache_breakpoint: true,
};
/** Anthropic rejects cache_control on these block types. */
const ANTHROPIC_UNCACHEABLE: Record<string, true> = {
	thinking: true,
	redacted_thinking: true,
	fallback: true,
	tool_addition: true,
	tool_removal: true,
};
/** Responses content blocks that accept prompt_cache_breakpoint. */
const RESPONSES_CACHEABLE: Record<string, true> = {
	input_text: true,
	input_image: true,
	input_file: true,
};

type WireObject = Record<string, unknown>;

function object(value: unknown): value is WireObject {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Responses cuts retain the original fixed-offset behavior and three-marker limit. */
function responseCuts(view: string): number[] {
	const cuts: number[] = [];
	let from = view.indexOf("\n") + 1;
	for (const mark of VIEW_MARKS) {
		if (mark >= view.length) break;
		const cut = view.lastIndexOf("\n", mark - 1) + 1;
		if (cut <= from) continue;
		cuts.push(cut);
		from = cut;
	}
	return cuts;
}

/** Keep the closing tag out of full blocks, including when the view has exactly four lines. */
function viewCuts(view: string): number[] {
	const cuts: number[] = [];
	let from = view.indexOf("\n") + 1;
	if ((!view.startsWith("<chat>\n") && !view.startsWith("<chat>\r\n")) || !view.endsWith("</chat>")) return cuts;
	const end = view.length - "</chat>".length;
	let lines = 0;
	while (from < end) {
		const newline = view.indexOf("\n", from);
		if (newline < 0 || newline >= end) break;
		from = newline + 1;
		if (++lines % 4 === 0) cuts.push(from);
	}
	return cuts;
}

/** The only Anthropic route that receives cache_control metadata here. */
function officialAnthropic(model: Model): boolean {
	const compat: unknown = model.compat;
	return model.api === "anthropic-messages" && model.transport !== "pi-native" && model.provider === "anthropic" &&
		object(compat) && compat.officialEndpoint === true && officialAnthropicEndpoint(model.baseUrl);
}

export type ViewPartition = "anthropic" | "fixed";

/**
 * Four-line blocks only on official Anthropic routes whose encoder keeps text
 * blocks separate: for a text-only model the host joins them with "\n", which
 * would add bytes. Every other route, and an unknown model, keeps fixed offsets.
 */
export function viewPartition(model: Model | undefined): ViewPartition {
	return model && officialAnthropic(model) && model.input.includes("image") ? "anthropic" : "fixed";
}

/** Split without changing any bytes, in the model's view partition. */
export function viewBlocks(view: string, model: Model | undefined): TextContent[] {
	const blocks: TextContent[] = [];
	let from = 0;
	const cuts = viewPartition(model) === "anthropic" ? viewCuts(view) : responseCuts(view);
	for (const cut of cuts) {
		blocks.push({ type: "text", text: view.slice(from, cut) });
		from = cut;
	}
	blocks.push({ type: "text", text: view.slice(from) });
	return blocks;
}

interface LeadingView {
	/** Index of the view message. */
	index: number;
	/** Blocks of that message that end exactly at a stable cut. */
	marks: number[];
}

/**
 * The plugin's view: leading plain text blocks of the first user message
 * (after Responses developer/system items), from `<chat>\n` to the first block
 * closing `</chat>` (possibly its own block). A pasted later view is never considered.
 */
function leadingView(messages: unknown[], textType: string): LeadingView | undefined {
	let index = 0;
	while (textType === "input_text" && index < messages.length) {
		const entry = messages[index];
		if (!object(entry) || (entry.role !== "developer" && entry.role !== "system")) break;
		index++;
	}
	const entry = messages[index];
	if (!object(entry) || entry.role !== "user" || !Array.isArray(entry.content)) return;
	const texts: string[] = [];
	const ends: number[] = [];
	let length = 0;
	for (const block of entry.content) {
		if (!object(block) || block.type !== textType || typeof block.text !== "string") return;
		for (const field in block) {
			if (!Object.hasOwn(VIEW_BLOCK_FIELDS, field)) return;
		}
		if (texts.length === 0 && !block.text.startsWith("<chat>\n")) return;
		texts.push(block.text);
		length += block.text.length;
		ends.push(length);
		if (!block.text.endsWith("</chat>")) continue;
		const view = texts.join("");
		if (!view.endsWith("\n</chat>")) continue;
		if (!CHAT_VIEW.test(view)) return;
		const cuts = new Set(textType === "text" ? viewCuts(view) : responseCuts(view));
		const marks: number[] = [];
		for (let i = 0; i < ends.length; i++) {
			if (cuts.has(ends[i]!)) marks.push(i);
		}
		return { index, marks };
	}
	return;
}

function mapChanged(values: unknown[], change: (value: unknown, index: number) => unknown): unknown[] {
	let result: unknown[] | undefined;
	for (let i = 0; i < values.length; i++) {
		const next = change(values[i], i);
		if (next !== values[i]) {
			result ??= values.slice();
			result[i] = next;
		}
	}
	return result ?? values;
}

/** Set or remove one metadata key, copying only when it changes. */
function withMarker(value: unknown, key: string, marker: WireObject | undefined): unknown {
	if (!object(value)) return value;
	if (marker) return { ...value, [key]: marker };
	if (!(key in value)) return value;
	const result = { ...value };
	delete result[key];
	return result;
}

function withBlockMarkers(
	message: unknown,
	key: string,
	marker: (block: number) => WireObject | undefined,
): unknown {
	if (!object(message) || !Array.isArray(message.content)) return message;
	const content = mapChanged(message.content, (block, j) => withMarker(block, key, marker(j)));
	return content === message.content ? message : { ...message, content };
}

function officialAnthropicEndpoint(baseUrl: string): boolean {
	// Mirrors the host's effective endpoint: Foundry or ANTHROPIC_BASE_URL can
	// redirect a model whose catalog URL is official.
	const foundry = process.env.CLAUDE_CODE_USE_FOUNDRY?.trim().toLowerCase();
	if (foundry === "1" || foundry === "true" || foundry === "yes" || foundry === "on") return false;
	for (const url of [baseUrl, process.env.ANTHROPIC_BASE_URL?.trim() ?? ""]) {
		const lower = url.toLowerCase();
		if (lower && lower !== ANTHROPIC_URL && !lower.startsWith(`${ANTHROPIC_URL}/`)) return false;
	}
	return true;
}

function officialOpenAIEndpoint(baseUrl: string): boolean {
	// An empty URL could be redirected by OPENAI_BASE_URL; require the explicit host.
	try {
		const url = new URL(baseUrl);
		return url.protocol === "https:" && url.hostname === "api.openai.com";
	} catch {
		return false;
	}
}

/**
 * Anthropic Messages: one cache_control on the last whole four-line block,
 * plus the host's request-end breakpoint. Keep the latest tools and system
 * anchors within the four-marker budget. Every marker is a 5-minute ephemeral one.
 */
function cacheAnthropic(payload: WireObject): unknown {
	const messages = payload.messages;
	if (!Array.isArray(messages)) return payload;
	const view = leadingView(messages, "text");
	if (!view) return payload;
	// Prefix order is tools, then system, then messages.
	const head: Array<{ field: "tools" | "system"; index: number }> = [];
	for (const field of ["tools", "system"] as const) {
		const values = payload[field];
		if (!Array.isArray(values)) continue;
		for (let index = 0; index < values.length; index++) {
			const value = values[index];
			if (object(value) && value.cache_control != null) head.push({ field, index });
		}
	}
	// The host's latest message breakpoint is its request-end anchor; it already
	// skips continuation pads and per-call messages the wire cannot identify.
	let end: { message: number; block: number } | undefined;
	for (let message = 0; message < messages.length; message++) {
		const entry: unknown = messages[message];
		const content = object(entry) ? entry.content : undefined;
		if (!Array.isArray(content)) continue;
		for (let block = 0; block < content.length; block++) {
			const value = content[block];
			if (object(value) && value.cache_control != null &&
				!(typeof value.type === "string" && Object.hasOwn(ANTHROPIC_UNCACHEABLE, value.type))) {
				end = { message, block };
			}
		}
	}
	// No host breakpoint at all means caching is off for this request (retention "none").
	if (!end && head.length === 0 && payload.cache_control == null) return payload;
	const viewMark = view.marks.at(-1);
	const endInView = end?.message === view.index && viewMark === end.block;
	const allowedHead = MAX_BREAKPOINTS - (viewMark === undefined ? 0 : 1) - (end && !endInView ? 1 : 0);
	// Keep each head family before spending any spare slots on earlier anchors.
	const keep: typeof head = [];
	for (const field of ["system", "tools"] as const) {
		const last = head.findLast((entry) => entry.field === field);
		if (last && keep.length < allowedHead) keep.push(last);
	}
	for (let index = head.length - 1; index >= 0 && keep.length < allowedHead; index--) {
		if (!keep.includes(head[index]!)) keep.push(head[index]!);
	}
	const result: WireObject = { ...payload };
	delete result.cache_control;
	for (const field of ["tools", "system"] as const) {
		const values = payload[field];
		if (!Array.isArray(values)) continue;
		result[field] = mapChanged(values, (value, index) => withMarker(
			value,
			"cache_control",
			keep.some((entry) => entry.field === field && entry.index === index)
				? { type: "ephemeral", ttl: "5m" }
				: undefined,
		));
	}
	result.messages = mapChanged(messages, (message, i) => withBlockMarkers(message, "cache_control", (j) =>
		(i === view.index && j === viewMark) || (i === end?.message && j === end.block)
			? { type: "ephemeral", ttl: "5m" }
			: undefined));
	return result;
}

/**
 * OpenAI Responses explicit caching: prompt_cache_breakpoint on the view's
 * stable cuts and on the end of the latest user message, with top-level
 * prompt_cache_options. Chained requests carry only new input after a stored
 * response, so they are left to the host.
 */
function cacheResponses(payload: WireObject, compat: WireObject): unknown {
	if (payload.previous_response_id != null) return payload;
	const input = payload.input;
	if (!Array.isArray(input)) return payload;
	const view = leadingView(input, "input_text");
	if (!view || resolveCacheRetention() === "none") return payload;
	let end: { message: number; block: number } | undefined;
	search: for (let message = input.length - 1; message >= view.index; message--) {
		const entry = input[message];
		if (!object(entry) || entry.role !== "user" || !Array.isArray(entry.content)) continue;
		for (let block = entry.content.length - 1; block >= 0; block--) {
			const value = entry.content[block];
			if (object(value) && typeof value.type === "string" && Object.hasOwn(RESPONSES_CACHEABLE, value.type)) {
				end = { message, block };
				break search;
			}
		}
	}
	const ttl = compat.promptCacheBreakpointTtl;
	return {
		...payload,
		input: mapChanged(input, (message, i) => withBlockMarkers(message, "prompt_cache_breakpoint", (j) =>
			(i === view.index && view.marks.includes(j)) || (i === end?.message && j === end.block)
				? { mode: "explicit" }
				: undefined)),
		prompt_cache_options: typeof ttl === "string" ? { mode: "explicit", ttl } : { mode: "explicit" },
	};
}

/** Codex Responses: no explicit markers exist; ask to keep reasoning across the turn's user messages. */
function cacheCodex(payload: WireObject): unknown {
	if (payload.previous_response_id != null || !Array.isArray(payload.input)) return payload;
	const reasoning = payload.reasoning;
	if (!object(reasoning) || reasoning.context !== undefined) return payload;
	if (!leadingView(payload.input, "input_text")) return payload;
	return { ...payload, reasoning: { ...reasoning, context: "all_turns" } };
}

/**
 * Add cache metadata to an encoded provider request that starts with the
 * OptChat view (the main chat's or the compressor's context, both rendered
 * `id+n|` rows). Use from `before_provider_request` or the compressor's
 * `onPayload`. Supported: official Anthropic Messages, official OpenAI
 * Responses models whose host compat enables explicit breakpoints, and
 * official Codex `reasoning.context`.
 */
export function applyOptChatCache(payload: unknown, model: Model): unknown {
	const compat: unknown = model.compat;
	if (!object(payload) || !object(compat) || model.transport === "pi-native") return payload;
	if (model.api === "anthropic-messages") return officialAnthropic(model) ? cacheAnthropic(payload) : payload;
	if (model.api === "openai-responses") {
		return model.provider === "openai" && compat.supportsPromptCacheBreakpoints === true &&
			officialOpenAIEndpoint(model.baseUrl)
			? cacheResponses(payload, compat)
			: payload;
	}
	if (model.api === "openai-codex-responses") {
		return model.provider === "openai-codex" && compat.supportsAllTurnsReasoningContext === true &&
			isOfficialCodexApiUrl(model.baseUrl)
			? cacheCodex(payload)
			: payload;
	}
	return payload;
}

/** Release at the first provider response (`true`), or error/cancel/finally (`false`). */
export type OptChatCacheRelease = (responseStarted?: boolean) => void;

interface CachePrefixes {
	/** Only explicit message marks, never a shared tools/system-only anchor. */
	marked: Set<string>;
	/** Exact marks plus Anthropic's preceding twenty-block lookup window. */
	lookup: Set<string>;
}

/** Hash the encoded JSON shape, omitting metadata only on its owning block. */
function hashValue(hash: Hash, value: unknown, omit?: string): void {
	if (Array.isArray(value)) {
		hash.update("[");
		for (const child of value) {
			hashValue(hash, child);
			hash.update(",");
		}
		hash.update("]");
	} else if (object(value)) {
		hash.update("{");
		for (const key of Object.keys(value).sort()) {
			if (key === omit || value[key] === undefined) continue;
			hash.update(JSON.stringify(key)).update(":");
			hashValue(hash, value[key]);
			hash.update(",");
		}
		hash.update("}");
	} else {
		hash.update(JSON.stringify(value) ?? "null");
	}
}

/**
 * Coordination is intentionally Anthropic-only: other APIs expose no equivalent
 * cache-write visibility contract. The caller passes the FINAL encoded payload,
 * after applyOptChatCache; neither credentials nor a model's headers enter keys.
 */
function cachePrefixes(payload: unknown, model: Model): CachePrefixes | undefined {
	if (!object(payload) || !officialAnthropic(model) || payload.previous_response_id != null) return;
	const messages = payload.messages;
	if (!Array.isArray(messages) || !leadingView(messages, "text")) return;
	const endpoint = new URL(process.env.ANTHROPIC_BASE_URL?.trim() || model.baseUrl || ANTHROPIC_URL);
	// Never derive a fence from credentials in URL userinfo/query strings.
	if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) return;
	const hash = createHash("sha256");
	hashValue(hash, [model.api, model.provider, model.id, endpoint.href, payload.model]);
	for (const field of ["tools", "system"] as const) {
		hash.update(field);
		const value = payload[field];
		if (Array.isArray(value)) {
			hash.update("[");
			for (const block of value) {
				hashValue(hash, block, "cache_control");
				hash.update(",");
			}
			hash.update("]");
		} else hashValue(hash, value);
	}
	// These alter Anthropic's prompt/cache identity rather than the generated text.
	for (const field of ["tool_choice", "thinking", "context_management"]) {
		hash.update(field);
		hashValue(hash, payload[field]);
	}
	const marked = new Set<string>();
	const lookup = new Set<string>();
	const recent: string[] = [];
	const visit = (): string => {
		const digest = hash.copy().digest("hex");
		recent.push(digest);
		if (recent.length > 20) recent.shift();
		return digest;
	};
	messages: for (const message of messages) {
		if (!object(message)) break;
		if (typeof message.content === "string") {
			// Legal unmarkable text content, e.g. the host's "Continue." pad: one block.
			hashValue(hash, message);
			visit();
			continue;
		}
		// An unknown later shape ends the walk; marks before it stay exact prefixes.
		if (!Array.isArray(message.content)) break;
		hashValue(hash, message, "content");
		hash.update("[");
		for (const block of message.content) {
			if (!object(block)) break messages;
			hashValue(hash, block, "cache_control");
			hash.update(",");
			const digest = visit();
			const marker = block.cache_control;
			if (object(marker) && marker.type === "ephemeral" &&
				!(typeof block.type === "string" && Object.hasOwn(ANTHROPIC_UNCACHEABLE, block.type))) {
				marked.add(digest);
				for (const prefix of recent) lookup.add(prefix);
			}
		}
		hash.update("]");
	}
	return marked.size === 0 ? undefined : { marked, lookup };
}

interface CacheWriter {
	marked: Set<string>;
	release: OptChatCacheRelease;
}

interface CacheWaiter {
	prefixes: CachePrefixes;
	/** Successful writers seen while this request waited, not a cache-hit ledger. */
	ready: Set<string>;
	signal: AbortSignal | undefined;
	/** False for a request that may only wait: it never becomes a writer. */
	claim: boolean;
	finish: (release?: OptChatCacheRelease) => void;
}

const NO_CACHE_WRITER: OptChatCacheRelease = () => {};
const CACHE_WRITER_FAILSAFE_MS = 20_000;

/**
 * One coordinator per extension instance AND auth/session fence; replace or
 * clear it when that fence changes. Main and compressor use the same instance.
 *
 * Only a request whose own response callbacks are tied to it may `acquire` a
 * writer lease: await it in encoded onPayload, never during context
 * construction, and release with true on that request's response start,
 * otherwise on error/cancel/finally. A request without such callbacks may
 * only `wait` for tracked writers of its prefixes. There is no throttle or
 * minimum holding time. The timeout is only a fail-open escape for abandoned
 * callbacks, and is shorter than the host's request-hook limit.
 */
export class OptChatCacheCoordinator {
	private readonly writers = new Set<CacheWriter>();
	private readonly waiters = new Set<CacheWaiter>();

	constructor(private readonly failSafeMs = CACHE_WRITER_FAILSAFE_MS) {}

	acquire(payload: unknown, model: Model, options: { signal?: AbortSignal } = {}): Promise<OptChatCacheRelease> {
		return this.enter(payload, model, options.signal, true);
	}

	/** Wait until no unreleased writer covers this request's prefixes; never write. */
	async wait(payload: unknown, model: Model, options: { signal?: AbortSignal } = {}): Promise<void> {
		await this.enter(payload, model, options.signal, false);
	}

	private async enter(
		payload: unknown,
		model: Model,
		signal: AbortSignal | undefined,
		claim: boolean,
	): Promise<OptChatCacheRelease> {
		signal?.throwIfAborted();
		const prefixes = cachePrefixes(payload, model);
		if (!prefixes) return NO_CACHE_WRITER;
		const release = await new Promise<OptChatCacheRelease>((resolve, reject) => {
			let settled = false;
			const cancel = () => waiter.finish();
			const timer = setTimeout(() => waiter.finish(NO_CACHE_WRITER), this.failSafeMs);
			timer.unref?.();
			const waiter: CacheWaiter = {
				prefixes,
				ready: new Set(),
				signal,
				claim,
				finish: (lease) => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					signal?.removeEventListener("abort", cancel);
					this.waiters.delete(waiter);
					if (signal?.aborted) {
						lease?.();
						reject(signal.reason);
					} else resolve(lease ?? NO_CACHE_WRITER);
				},
			};
			this.waiters.add(waiter);
			signal?.addEventListener("abort", cancel, { once: true });
			if (signal?.aborted) cancel();
			else this.drain();
		});
		// Release-before-abort in the same tick must not leak a just-granted writer.
		if (signal?.aborted) {
			release();
			signal.throwIfAborted();
		}
		return release;
	}

	/** Abort caller controllers first when replacing an auth/session fence. */
	clear(): void {
		for (const waiter of this.waiters) waiter.finish(NO_CACHE_WRITER);
		for (const writer of this.writers) writer.release();
	}

	private drain(): void {
		for (const waiter of this.waiters) {
			// A writer's abort listener can drain before a waiter's listener runs.
			if (waiter.signal?.aborted) {
				waiter.finish();
				continue;
			}
			let blocked = false;
			for (const writer of this.writers) {
				for (const prefix of writer.marked) {
					if (waiter.prefixes.lookup.has(prefix) && !waiter.ready.has(prefix)) {
						blocked = true;
						break;
					}
				}
				if (blocked) break;
			}
			if (blocked) continue;
			const marked = new Set<string>();
			for (const prefix of waiter.prefixes.marked) {
				if (!waiter.ready.has(prefix)) marked.add(prefix);
			}
			if (!waiter.claim || marked.size === 0) waiter.finish(NO_CACHE_WRITER);
			else waiter.finish(this.startWriter(marked, waiter.signal));
		}
	}

	private startWriter(marked: Set<string>, signal: AbortSignal | undefined): OptChatCacheRelease {
		let active = true;
		const cancel = () => writer.release();
		const timer = setTimeout(cancel, this.failSafeMs);
		timer.unref?.();
		const writer: CacheWriter = {
			marked,
			release: (responseStarted = false) => {
				if (!active) return;
				active = false;
				clearTimeout(timer);
				signal?.removeEventListener("abort", cancel);
				this.writers.delete(writer);
				if (responseStarted) {
					for (const waiter of this.waiters) {
						for (const prefix of marked) {
							if (waiter.prefixes.lookup.has(prefix)) waiter.ready.add(prefix);
						}
					}
				}
				this.drain();
			},
		};
		this.writers.add(writer);
		signal?.addEventListener("abort", cancel, { once: true });
		if (signal?.aborted) cancel();
		return writer.release;
	}
}
