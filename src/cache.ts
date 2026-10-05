import { isOfficialCodexApiUrl, resolveCacheRetention, type Model, type TextContent } from "@oh-my-pi/pi-ai";

/**
 * Provider prompt-cache metadata for the OptChat view.
 *
 * The view is sent as text blocks cut at the last line end before fixed
 * offsets, so a cut stays put while the view only appends. This module marks
 * those cuts with each supported vendor's real wire field, after the host has
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

/** `chat`: the main-session view message. `compactor`: the compressor's `<chat>` context, which has no id labels. */
export type OptChatCacheKind = "chat" | "compactor";
type WireObject = Record<string, unknown>;

function object(value: unknown): value is WireObject {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Cut offsets: the last line end at or before each mark, never at the first line's end. */
function viewCuts(view: string): number[] {
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

/** Split a view into text blocks at its stable cuts; joining the texts gives the view back. */
export function viewBlocks(view: string): TextContent[] {
	const blocks: TextContent[] = [];
	let from = 0;
	for (const cut of viewCuts(view)) {
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
 * ending `\n</chat>`. A `<chat>` pasted elsewhere is never considered.
 */
function leadingView(messages: unknown[], textType: string, kind: OptChatCacheKind): LeadingView | undefined {
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
		if (!block.text.endsWith("\n</chat>")) continue;
		const view = texts.join("");
		if (kind === "chat" && !CHAT_VIEW.test(view)) return;
		const cuts = viewCuts(view);
		const marks: number[] = [];
		for (let i = 0; i < ends.length; i++) {
			if (cuts.includes(ends[i]!)) marks.push(i);
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
 * Anthropic Messages: cache_control on the view's stable cuts plus the host's
 * request-end breakpoint; the host's system/tools breakpoints keep what budget
 * remains, latest first. Every kept marker is a 5-minute ephemeral one.
 */
function cacheAnthropic(payload: WireObject, kind: OptChatCacheKind): unknown {
	const messages = payload.messages;
	if (!Array.isArray(messages)) return payload;
	const view = leadingView(messages, "text", kind);
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
	const endInView = end?.message === view.index && view.marks.includes(end.block);
	const allowedHead = Math.max(0, MAX_BREAKPOINTS - view.marks.length - (end && !endInView ? 1 : 0));
	const keep = head.slice(Math.max(0, head.length - allowedHead));
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
		(i === view.index && view.marks.includes(j)) || (i === end?.message && j === end.block)
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
function cacheResponses(payload: WireObject, compat: WireObject, kind: OptChatCacheKind): unknown {
	if (payload.previous_response_id != null) return payload;
	const input = payload.input;
	if (!Array.isArray(input)) return payload;
	const view = leadingView(input, "input_text", kind);
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
function cacheCodex(payload: WireObject, kind: OptChatCacheKind): unknown {
	if (payload.previous_response_id != null || !Array.isArray(payload.input)) return payload;
	const reasoning = payload.reasoning;
	if (!object(reasoning) || reasoning.context !== undefined) return payload;
	if (!leadingView(payload.input, "input_text", kind)) return payload;
	return { ...payload, reasoning: { ...reasoning, context: "all_turns" } };
}

/**
 * Add cache metadata to an encoded provider request that starts with the
 * OptChat view. Use from `before_provider_request` (main chat) or the
 * compressor's `onPayload` with kind `compactor`. Supported:
 * official Anthropic Messages, official OpenAI Responses models whose host
 * compat enables explicit breakpoints, and official Codex `reasoning.context`.
 */
export function applyOptChatCache(payload: unknown, model: Model, kind: OptChatCacheKind = "chat"): unknown {
	const compat: unknown = model.compat;
	if (!object(payload) || !object(compat) || model.transport === "pi-native") return payload;
	if (model.api === "anthropic-messages") {
		return model.provider === "anthropic" && compat.officialEndpoint === true &&
			officialAnthropicEndpoint(model.baseUrl)
			? cacheAnthropic(payload, kind)
			: payload;
	}
	if (model.api === "openai-responses") {
		return model.provider === "openai" && compat.supportsPromptCacheBreakpoints === true &&
			officialOpenAIEndpoint(model.baseUrl)
			? cacheResponses(payload, compat, kind)
			: payload;
	}
	if (model.api === "openai-codex-responses") {
		return model.provider === "openai-codex" && compat.supportsAllTurnsReasoningContext === true &&
			isOfficialCodexApiUrl(model.baseUrl)
			? cacheCodex(payload, kind)
			: payload;
	}
	return payload;
}
