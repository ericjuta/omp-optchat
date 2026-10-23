/**
 * Offline publication counterfactual. Only this eval's read model is deferred:
 * real Memory still constructs, coarsens and durably publishes every completion.
 * Neither Memory nor Store methods are replaced. Host hooks are NOT exercised.
 *
 * bun evals/compressor/proposals/runner.ts cache-replay --run cache-replay-20261023
 * Artifacts are private, synthetic, and confined to the existing ignored runs/.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setImmediate as nextEventLoop } from "node:timers/promises";
import type { Model, Tool } from "@oh-my-pi/pi-ai";
import { type AnthropicOptions, streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import { getBundledModels } from "@oh-my-pi/pi-catalog";
import type * as CacheModule from "../../../src/cache.ts";
import type { CompactionRequest, Memory, Summarize, ViewPart } from "../../../src/memory.ts";
import type { Store } from "../../../src/store.ts";

const ROOT = resolve(import.meta.dir, "../../..");
const RUNS = join(ROOT, "evals/compressor/runs");
const DATE = new Date("2026-01-01T00:00:00.000Z");
const REPEATS = 3;
const DEFAULT_SEED = 20261023;
const OPTIONS = { nodeBytes: 128, viewBytes: 1_000, compactionViewBytes: 512, pageBytes: 16_384, jobs: 8, tries: 1 };
const POLICIES = ["each-completion", "deferred-all-pass"] as const;
type Policy = (typeof POLICIES)[number];
const hash = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
const json = (value: unknown): string => JSON.stringify(value);
const bytes = (value: string): number => Buffer.byteLength(value, "utf8");
const key = ({ l, i }: ViewPart): string => `${l}:${i}`;
const fail = (message: string): never => { throw new Error(`cache-replay: ${message}`); };
function check(condition: unknown, message: string): asserts condition { if (!condition) fail(message); }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function privateJson(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
}
function padded(text: string, size: number): string {
	check(bytes(text) <= size, "fixture text exceeds its exact byte budget");
	return text + ".".repeat(size - bytes(text));
}

interface SourceFile { path: string; sha256: string; bytes: number }
/** Never imports index.ts, host settings, credential stores, or real chats. */
function copySource(from: string, to: string | undefined, prefix = "src"): SourceFile[] {
	if (to) mkdirSync(to, { recursive: true, mode: 0o700 });
	const manifest: SourceFile[] = [];
	for (const name of readdirSync(from).sort()) {
		const input = join(from, name);
		const output = to ? join(to, name) : undefined;
		const stat = lstatSync(input);
		check(!stat.isSymbolicLink(), "source snapshot must not follow symlinks");
		if (stat.isDirectory()) manifest.push(...copySource(input, output, `${prefix}/${name}`));
		else {
			check(stat.isFile(), "source snapshot contains a non-file");
			const data = readFileSync(input);
			if (output) writeFileSync(output, data, { mode: 0o600, flag: "wx" });
			manifest.push({ path: `${prefix}/${name}`, sha256: hash(data), bytes: data.length });
		}
	}
	return manifest;
}
interface Runtime {
	Memory: typeof Memory;
	Store: typeof Store;
	cache: typeof CacheModule;
}

/** Fail closed on the exact endpoint correction, then exercise it through public APIs. */
async function endpointCheck(runtime: Runtime, directory: string, source: string) {
	const compact = source.replace(/\s/g, "");
	const guards = {
		mainUsesLogEnd: compact.includes("this.coarsen(view,bytes,this.target,length)"),
		compactorUsesBuiltPrefixEnd: compact.includes("this.coarsen(next.parts,next.bytes,this.compactionTarget,next.length)"),
		ageUsesPassedEnd: compact.includes("(end-((a.i+2)*width-1))/width"),
	};
	check(Object.values(guards).every(Boolean), "corrected coarsen endpoint source guard failed; wait for MemoryCore source to settle");
	const store = await runtime.Store.open(directory);
	let memory: Memory | undefined;
	let unexpectedCalls = 0;
	try {
		for (let i = 0; i < 18; i++) store.append("user", `Endpoint guard synthetic record ${i}`, DATE);
		for (let l = 0, width = 1; width <= 10; l++, width *= 2) {
			for (let i = 0; (i + 1) * width <= 10; i++) {
				const text = l === 2 ? (i === 0 ? "AA" : "BB")
					: l === 0 && i >= 8 ? (i === 8 ? "eeee" : "ffff")
					: l === 1 && i === 4 ? "N" : l === 3 ? "O" : "x";
				store.saveNode({ l, i, text, size: bytes(text) });
			}
		}
		store.saveView({
			version: 2, length: 18, compacting: false,
			parts: [[2, 0], [2, 1], [0, 8], [0, 9], ...Array.from({ length: 8 }, (_, i): readonly [number, number] => [0, i + 10])],
			compactor: { length: 0, parts: [], compacting: false },
		});
		memory = new runtime.Memory(store, async () => { unexpectedCalls++; return fail("endpoint guard unexpectedly summarized"); }, {
			viewBytes: 100_000, compactionViewBytes: 10,
		});
		const snapshot = store.viewSnapshot;
		check(snapshot && "compactor" in snapshot, "endpoint guard has no joint snapshot");
		const actual = snapshot.compactor.parts;
		const expected = [[2, 0], [2, 1], [1, 4]];
		check(snapshot.compactor.length === 10 && json(actual) === json(expected), "built-prefix endpoint behavioral guard failed");
		// close() stops the queued pump synchronously, before any leaf admission.
		await memory.close();
		check(unexpectedCalls === 0, "endpoint guard ran unexpected background work");
		return { guards, passed: true, totalLogEnd: 18, builtPrefixEnd: 10, expected, actual, summarizeCalls: unexpectedCalls };
	} finally {
		await memory?.close();
		await store.close();
	}
}

interface Merge extends ViewPart { tick: number }
type Event = { tick: number; kind: "complete"; merge: Merge } | { tick: number; kind: "open" | "repeat" | "close"; turn: number };
interface Schedule { name: string; completions: Merge[]; events: Event[] }
function schedules(): Schedule[] {
	const merges: Merge[] = [
		{ l: 1, i: 8, tick: 2 }, { l: 1, i: 9, tick: 5 }, { l: 1, i: 10, tick: 8 },
		{ l: 2, i: 4, tick: 12 }, { l: 1, i: 11, tick: 31 }, { l: 2, i: 5, tick: 33 }, { l: 3, i: 2, tick: 35 },
	];
	const make = (name: string, windows: readonly (readonly [number, number, number])[], outOfOrder = false): Schedule => {
		const completions = merges.map((merge, i) => ({ ...merge, tick: outOfOrder && i < 3 ? [8, 2, 5][i]! : merge.tick })).sort((a, b) => a.tick - b.tick);
		const events: Event[] = completions.map((merge) => ({ kind: "complete", tick: merge.tick, merge }));
		for (const [turn, window] of windows.entries()) {
			for (const [index, kind] of (["open", "repeat", "close"] as const).entries()) events.push({ kind, tick: window[index]!, turn });
		}
		// Completions win equal-tick ties: a next turn never gets a silent grace interval.
		events.sort((a, b) => a.tick - b.tick || (a.kind === "complete" ? -1 : b.kind === "complete" ? 1 : 0));
		return { name, completions, events };
	};
	return [
		make("completed-before-turn-control", [[36, 37, 38], [39, 40, 41]]),
		make("one-interleaving-long-final", [[1, 32, 34], [36, 37, 38]]),
		make("multiple-interleavings", [[1, 3, 4], [6, 9, 10], [13, 32, 32], [34, 36, 37], [38, 39, 40]]),
		make("out-of-order-interleavings", [[1, 3, 4], [6, 9, 10], [13, 32, 32], [34, 36, 37], [38, 39, 40]], true),
	];
}
interface ChatRecord { kind: "user"; text: string }
function fixture(seed: number): ChatRecord[] {
	return Array.from({ length: 24 }, (_, i) => ({
		kind: "user" as const,
		text: padded(`Synthetic chat ${i}: user requests caf\u00e9 ledger ${hash(`${seed}:${i}`).slice(0, 24)}.`, 122),
	}));
}
function seedStore(store: Store, chat: readonly ChatRecord[], seed: number): void {
	for (const message of chat) {
		const saved = store.append(message.kind, message.text, DATE);
		const text = `${message.kind}: ${message.text}`;
		store.saveNode({ l: 0, i: saved.i, text, size: bytes(text) });
	}
	// A fully materialized older prefix; only the last eight leaves need new merges.
	for (let l = 1, width = 2; width <= 16; l++, width *= 2) {
		for (let i = 0; (i + 1) * width <= 16; i++) {
			const text = padded(`User requested archived synthetic facts ${hash(`${seed}:archive:${l}:${i}`).slice(0, 24)}.`, 128);
			store.saveNode({ l, i, text, size: bytes(text) });
		}
	}
	store.saveView({
		version: 2, length: chat.length, compacting: false,
		parts: [[4, 0], ...Array.from({ length: 8 }, (_, i): readonly [number, number] => [0, i + 16])],
		compactor: { length: 0, parts: [], compacting: false },
	});
}
interface Pending { request: CompactionRequest; resolve(value: string): void; reject(reason: Error): void }
class ControlledSummaries {
	readonly pending = new Map<string, Pending>();
	readonly requests: Array<{ key: string; request: CompactionRequest }> = [];
	readonly summarize: Summarize = (request, signal) => {
		check(request.meta.node === "merge" && request.meta.attempt === 1, "fixture must require exactly one callback per scheduled merge");
		const match = /merge lines (\d+)\+(\d+) and (\d+)\+(\d+),/.exec(request.instruction);
		check(match, "public merge instruction no longer identifies its source pair");
		const start = Number(match[1]);
		const half = Number(match[2]);
		check(Number(match[3]) === start + half && Number(match[4]) === half, "unexpected merge adjacency");
		const address = { l: Math.log2(half) + 1, i: start / (2 * half) };
		check(Number.isInteger(address.l) && Number.isInteger(address.i), "invalid merge address");
		const id = key(address);
		check(!this.pending.has(id), "duplicate controlled merge");
		const deferred = Promise.withResolvers<string>();
		const abort = () => deferred.reject(new Error("synthetic merge cancelled"));
		this.pending.set(id, { request, resolve: deferred.resolve, reject: deferred.reject });
		this.requests.push({ key: id, request });
		if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
		return deferred.promise.finally(() => { signal.removeEventListener("abort", abort); this.pending.delete(id); });
	};
	complete(merge: Merge): void {
		const pending = this.pending.get(key(merge));
		check(pending, `scheduled merge ${key(merge)} not admitted`);
		// The reply depends only on the children, never request context/publication policy.
		const input = /<input>\n([\s\S]*?)\n<\/input>/.exec(pending.request.instruction)?.[1];
		check(input, "merge source envelope is missing");
		pending.resolve(padded(`User requested synthetic facts ${hash(input).slice(0, 32)}.`, 80));
	}
}
/** Event-loop progress only, never a wall-clock grace window or provider latency. */
async function until(condition: () => boolean, description: string): Promise<void> {
	for (let round = 0; round < 5_000; round++) {
		if (condition()) return;
		await (round % 100 === 99 ? nextEventLoop() : Promise.resolve());
	}
	fail(`background lifecycle did not reach ${description}`);
}
interface Visible { rendered: string; parts: ReadonlyArray<ViewPart>; digest: string }
function visible(memory: Memory): Visible {
	const rendered = memory.render();
	return { rendered, parts: memory.viewParts(), digest: hash(rendered) };
}
function represents(view: Visible, merge: ViewPart): boolean {
	const start = merge.i * 2 ** merge.l;
	const end = start + 2 ** merge.l;
	return view.parts.some((part) => part.l >= merge.l && part.i * 2 ** part.l <= start && (part.i + 1) * 2 ** part.l >= end);
}

interface Span { start: number; end: number }
interface Marker { path: string; transportBlockBytes: Span; cacheOrderPrefixBytes: number; cacheOrderPrefixSha256: string }
interface Wire {
	cacheMode: CacheModule.OptChatCacheMode;
	serialized: string;
	payload: Record<string, unknown>;
	payloadBytes: number;
	payloadSha256: string;
	cacheOrder: string;
	markers: Marker[];
	components: Record<string, { bytes: number; sha256: string }>;
}
/** Locate block boundaries in the actual JSON serialization, not UTF-16 offsets. */
function serializedSpans(payload: Record<string, unknown>): { serialized: string; spans: Map<string, Span> } {
	const chunks: string[] = [];
	const spans = new Map<string, Span>();
	let offset = 0;
	const emit = (text: string) => { chunks.push(text); offset += bytes(text); };
	const visit = (value: unknown, path: string): void => {
		const start = offset;
		if (Array.isArray(value)) {
			emit("[");
			value.forEach((child, i) => { if (i) emit(","); visit(child, `${path}/${i}`); });
			emit("]");
		} else if (record(value)) {
			emit("{");
			let count = 0;
			for (const [name, child] of Object.entries(value)) {
				if (child === undefined) continue;
				if (count++) emit(",");
				emit(`${json(name)}:`);
				visit(child, `${path}/${name}`);
			}
			emit("}");
		} else {
			check(value !== undefined, "unsupported undefined array value in provider payload");
			emit(json(value));
		}
		spans.set(path, { start, end: offset });
	};
	visit(payload, "");
	const serialized = chunks.join("");
	check(serialized === json(payload), "transport span traversal differs from JSON.stringify");
	return { serialized, spans };
}
function withoutMarker(value: Record<string, unknown>): Record<string, unknown> {
	const { cache_control: _marker, ...rest } = value;
	return rest;
}
function measureWire(payload: Record<string, unknown>, view: Visible, cacheMode: CacheModule.OptChatCacheMode): Wire {
	const { serialized, spans } = serializedSpans(payload);
	const markers: Marker[] = [];
	let cacheOrder = "";
	const mark = (block: Record<string, unknown>, path: string) => {
		if (block.cache_control === undefined) return;
		const transportBlockBytes = spans.get(path);
		check(transportBlockBytes, "marked block missing from serialized payload");
		markers.push({ path, transportBlockBytes, cacheOrderPrefixBytes: bytes(cacheOrder), cacheOrderPrefixSha256: hash(cacheOrder) });
	};
	// This explicitly labeled projection follows provider tools/system/messages order.
	// It is NOT Anthropic's tokenization, server cache identity, or the coordinator hash.
	for (const field of ["tools", "system"] as const) {
		cacheOrder += `${field}:[`;
		const blocks = payload[field];
		check(Array.isArray(blocks), `encoded payload lacks ${field}`);
		blocks.forEach((block, i) => {
			check(record(block), "non-object head block");
			cacheOrder += `${json(withoutMarker(block))},`;
			mark(block, `/${field}/${i}`);
		});
		cacheOrder += "]";
	}
	cacheOrder += `controls:${json({ model: payload.model, tool_choice: payload.tool_choice, thinking: payload.thinking, context_management: payload.context_management })}`;
	const messages = payload.messages;
	check(Array.isArray(messages), "encoded payload lacks messages");
	messages.forEach((message, i) => {
		check(record(message) && Array.isArray(message.content), "unexpected encoded message shape");
		const { content, ...header } = message;
		cacheOrder += `${json(header)}:[`;
		for (const [j, block] of content.entries()) {
			check(record(block), "non-object message block");
			cacheOrder += `${json(withoutMarker(block))},`;
			mark(block, `/messages/${i}/content/${j}`);
		}
		cacheOrder += "]";
	});
	const components: Wire["components"] = {};
	for (const [name, text] of Object.entries({
		tools: json(payload.tools), system: json(payload.system),
		stableArchivedViewLine: view.rendered.split("\n")[1] ?? "",
		batchView: view.rendered, messages: json(payload.messages),
	})) components[name] = { bytes: bytes(text), sha256: hash(text) };
	return { cacheMode, serialized, payload, payloadBytes: bytes(serialized), payloadSha256: hash(serialized), cacheOrder, markers, components };
}
function sharedPrefix(a: string, b: string): number {
	const left = Buffer.from(a, "utf8");
	const right = Buffer.from(b, "utf8");
	let i = 0;
	while (i < Math.min(left.length, right.length) && left[i] === right[i]) i++;
	return i;
}
function comparison(previous: Wire | undefined, current: Wire) {
	if (!previous) return null;
	const previousMarks = new Set(previous.markers.map((marker) => marker.cacheOrderPrefixSha256));
	const reused = current.markers.filter((marker) => previousMarks.has(marker.cacheOrderPrefixSha256));
	return {
		serializedPayloadSharedPrefixBytes: sharedPrefix(previous.serialized, current.serialized),
		cacheOrderProjectionSharedPrefixBytes: sharedPrefix(previous.cacheOrder, current.cacheOrder),
		exactPreviouslyMarkedProjectionBytes: Math.max(0, ...reused.map((marker) => marker.cacheOrderPrefixBytes)),
		exactPreviouslyMarkedBoundaries: reused.map((marker) => marker.path),
		stableHeadEqual: previous.components.tools?.sha256 === current.components.tools?.sha256 && previous.components.system?.sha256 === current.components.system?.sha256,
		batchViewEqual: previous.components.batchView?.sha256 === current.components.batchView?.sha256,
	};
}

const SYSTEM = ["Synthetic cache replay host. Keep the tools and this system head fixed.", "Read the synthetic chat view, then answer the current turn. This is an offline encoder fixture, not the installed host prompt."];
const TOOLS: Tool[] = [{
	name: "zoom", description: "Open a synthetic view line to its source.",
	parameters: { type: "object", properties: { id: { type: "number" }, n: { type: "number" } }, required: ["id", "n"] },
}];
type Encode = (view: Visible, turn: number) => Promise<Wire>;
function encoder(cache: typeof CacheModule) {
	const bundled = getBundledModels("anthropic").filter(
		(candidate): candidate is Model<"anthropic-messages"> => candidate.api === "anthropic-messages" && candidate.kind === undefined && candidate.input.includes("image"),
	).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)[0];
	check(bundled, "installed catalog lacks an Anthropic vision-capable chat encoder fixture");
	const { transport: _transport, headers: _headers, ...safeModel } = bundled;
	const model: Model<"anthropic-messages"> = { ...safeModel, provider: "anthropic", baseUrl: "https://api.anthropic.com", compat: { ...bundled.compat, officialEndpoint: true } };
	let clientCreateCalls = 0;
	let captures = 0;
	const encode: Encode = async (view, turn) => {
		let captured: Record<string, unknown> | undefined;
		const stop = new AbortController();
		// Caller-supplied client is the public injection seam: it has NO transport.
		const client: NonNullable<AnthropicOptions["client"]> = {
			baseURL: "https://api.anthropic.com",
			messages: { create: () => { clientCreateCalls++; return fail("provider client create reached the offline veto"); } },
		};
		const options: AnthropicOptions = {
			apiKey: "synthetic-offline-not-a-credential", client, signal: stop.signal,
			cacheRetention: "short", maxTokens: 32, thinkingEnabled: false,
			onPayload: (payload) => {
				check(captured === undefined, "encoder unexpectedly retried a captured payload");
				const applied = cache.applyOptChatCache(payload, model);
				check(applied.mode === "anthropic-breakpoints" && record(applied.payload), "production cache marker application did not run");
				captured = applied.payload;
				captures++;
				stop.abort();
				throw new Error("cache-replay: captured before transport");
			},
		};
		const result = await streamAnthropic(model, {
			systemPrompt: SYSTEM, tools: TOOLS,
			messages: [
				{ role: "user", content: cache.viewBlocks(view.rendered, model), timestamp: DATE.getTime() },
				{ role: "user", content: `Synthetic turn ${turn}: report ledger status.`, timestamp: DATE.getTime() },
			],
		}, options).result();
		check(captured && clientCreateCalls === 0 && result.stopReason === "aborted", "encoder failed to stop at the pre-transport capture boundary");
		return measureWire(captured, view, "anthropic-breakpoints");
	};
	return { encode, model, counters: () => ({ payloadCaptures: captures, clientCreateCalls, networkRequests: 0 }) };
}

interface MergeLatency {
	key: string;
	completedTick: number;
	baselinePublishedTick: number | null;
	deferredPublishedTick: number | null;
	baselineNextTurnTick: number | null;
	deferredNextTurnTick: number | null;
}
interface FrozenTurn { id: number; completedAtOpen: number; views: Record<Policy, Visible>; wire: Record<Policy, Wire> }
async function replay(runtime: Runtime, encode: Encode, directory: string, schedule: Schedule, chat: readonly ChatRecord[], seed: number) {
	const store = await runtime.Store.open(join(directory, "store"));
	const model = new ControlledSummaries();
	let memory: Memory | undefined;
	try {
		seedStore(store, chat, seed);
		memory = new runtime.Memory(store, model.summarize, OPTIONS);
		check(await memory.settle(), "seeded leaves must be ready without waiting for background merges");
		const live = memory;
		const initial = visible(live);
		let baseline = initial;
		let deferred = initial;
		let turn: FrozenTurn | undefined;
		let passCompleteTick: number | null = null;
		let batchTargetReachedTick: number | null = null;
		const completed: Merge[] = [];
		const latencies: MergeLatency[] = [];
		const previousOpen: Partial<Record<Policy, Wire>> = {};
		const observations: Record<string, unknown>[] = [];
		const privateEvents: Record<string, unknown>[] = [];
		const partialProgress: Array<{ tick: number; turn: number; readyBaseline: number; missingDeferred: number; passed: boolean }> = [];
		const frozen: Array<{ tick: number; turn: number; policy: Policy; equal: boolean; completedDuringTurn: number }> = [];
		const bytesByPolicy: Record<Policy, number> = { "each-completion": 0, "deferred-all-pass": 0 };
		const prefixByPolicy: Record<Policy, number> = { "each-completion": 0, "deferred-all-pass": 0 };
		const markedByPolicy: Record<Policy, number> = { "each-completion": 0, "deferred-all-pass": 0 };
		for (const event of schedule.events) {
			if (event.kind === "complete") {
				await until(() => model.pending.has(key(event.merge)), `scheduled merge ${key(event.merge)}`);
				model.complete(event.merge);
				await until(() => store.nodes.has(key(event.merge)) && !model.pending.has(key(event.merge)), `durable merge ${key(event.merge)}`);
				completed.push(event.merge);
				latencies.push({ key: key(event.merge), completedTick: event.tick, baselinePublishedTick: null, deferredPublishedTick: null, baselineNextTurnTick: null, deferredNextTurnTick: null });
				baseline = visible(live);
				if (batchTargetReachedTick === null && live.status().viewBytes <= OPTIONS.viewBytes / 2) batchTargetReachedTick = event.tick;
				if (completed.length === schedule.completions.length) {
					await until(() => live.status().pending === 0, "the fixed seven-merge pass to settle");
					check(model.requests.length === schedule.completions.length, "background work escaped the finite scheduled pass");
					passCompleteTick = event.tick;
					deferred = baseline;
				}
				for (const [index, merge] of completed.entries()) {
					const latency = latencies[index]!;
					if (represents(baseline, merge)) latency.baselinePublishedTick ??= event.tick;
					if (represents(deferred, merge)) latency.deferredPublishedTick ??= event.tick;
				}
			} else if (event.kind === "open") {
				check(!turn, "schedule opens a second simultaneous turn");
				const views = { "each-completion": baseline, "deferred-all-pass": deferred };
				const wires = { "each-completion": await encode(baseline, event.turn), "deferred-all-pass": await encode(deferred, event.turn) };
				turn = { id: event.turn, completedAtOpen: completed.length, views, wire: wires };
				const ready = completed.filter((merge) => represents(baseline, merge));
				const missing = ready.filter((merge) => !represents(deferred, merge));
				partialProgress.push({ tick: event.tick, turn: event.turn, readyBaseline: ready.length, missingDeferred: missing.length, passed: missing.length === 0 && (ready.length === 0 || baseline.digest === deferred.digest) });
				for (const [index, merge] of completed.entries()) {
					if (represents(baseline, merge)) latencies[index]!.baselineNextTurnTick ??= event.tick;
					if (represents(deferred, merge)) latencies[index]!.deferredNextTurnTick ??= event.tick;
				}
				for (const policy of POLICIES) {
					const wire = wires[policy];
					const diff = comparison(previousOpen[policy], wire);
					bytesByPolicy[policy] += wire.payloadBytes;
					prefixByPolicy[policy] += diff?.serializedPayloadSharedPrefixBytes ?? 0;
					markedByPolicy[policy] += diff?.exactPreviouslyMarkedProjectionBytes ?? 0;
					observations.push({ kind: "turn-open", tick: event.tick, turn: event.turn, policy, cacheMode: wire.cacheMode, payloadBytes: wire.payloadBytes, payloadSha256: wire.payloadSha256, markers: wire.markers, components: wire.components, versusPreviousTurn: diff });
					writeFileSync(join(directory, `${policy}-turn-${event.turn}-open.json`), wire.serialized, { mode: 0o600, flag: "wx" });
					previousOpen[policy] = wire;
				}
			} else if (event.kind === "repeat") {
				check(turn && turn.id === event.turn, "schedule repeats outside its open turn");
				for (const policy of POLICIES) {
					// Freeze the selected rendered snapshot, not the mutable Memory object.
					const wire = await encode(turn.views[policy], event.turn);
					const equal = wire.serialized === turn.wire[policy].serialized;
					frozen.push({ tick: event.tick, turn: event.turn, policy, equal, completedDuringTurn: completed.length - turn.completedAtOpen });
					observations.push({ kind: "same-open-turn", tick: event.tick, turn: event.turn, policy, cacheMode: wire.cacheMode, payloadBytes: wire.payloadBytes, payloadSha256: wire.payloadSha256, frozenEqual: equal, versusTurnOpen: comparison(turn.wire[policy], wire) });
					writeFileSync(join(directory, `${policy}-turn-${event.turn}-repeat.json`), wire.serialized, { mode: 0o600, flag: "wx" });
				}
			} else {
				check(turn && turn.id === event.turn, "schedule closes outside its open turn");
				turn = undefined;
			}
			const ready = completed.filter((merge) => represents(baseline, merge));
			privateEvents.push({ event, completed: completed.map(key), baseline, deferred, pendingReadyUnpublished: ready.filter((merge) => !represents(deferred, merge)).map(key), durableView: store.viewSnapshot });
			observations.push({ kind: "boundary", event: event.kind, tick: event.tick, completedMerges: completed.length, pendingReadyUnpublished: ready.filter((merge) => !represents(deferred, merge)).length, baselineViewSha256: baseline.digest, deferredViewSha256: deferred.digest });
		}
		check(!turn && passCompleteTick !== null && batchTargetReachedTick !== null, "schedule did not complete and close");
		const finalBaseline = await encode(baseline, 999);
		const finalDeferred = await encode(deferred, 999);
		const summary = {
			schedule: schedule.name, scheduleSha256: hash(json(schedule)), sourceChatSha256: hash(json(chat)),
			mergeRequestsSha256: hash(json(model.requests)), initialViewSha256: initial.digest, finalViewSha256: baseline.digest,
			batchTargetReachedTick, passCompleteTick, completedMerges: completed.length,
			firstProgressPublication: {
				baseline: latencies.find((row) => row.baselinePublishedTick !== null)?.baselinePublishedTick ?? null,
				deferred: latencies.find((row) => row.deferredPublishedTick !== null)?.deferredPublishedTick ?? null,
			},
			mergeVisibility: latencies.map((row) => ({ ...row,
				baselinePublishDelayTicks: row.baselinePublishedTick === null ? null : row.baselinePublishedTick - row.completedTick,
				deferredPublishDelayTicks: row.deferredPublishedTick === null ? null : row.deferredPublishedTick - row.completedTick,
				baselineNextTurnDelayTicks: row.baselineNextTurnTick === null ? null : row.baselineNextTurnTick - row.completedTick,
				deferredNextTurnDelayTicks: row.deferredNextTurnTick === null ? null : row.deferredNextTurnTick - row.completedTick,
				selectedByRealMainTiling: row.baselinePublishedTick !== null,
			})),
			partialProgress, frozenTurnChecks: frozen,
			gates: {
				partialProgress: partialProgress.every((row) => row.passed), frozenTurnEquality: frozen.every((row) => row.equal),
				batchEventualConvergence: baseline.digest === deferred.digest && finalBaseline.serialized === finalDeferred.serialized,
				finitePass: completed.length === schedule.completions.length && model.requests.length === schedule.completions.length,
			},
			turnOpenWireTotals: { payloadBytes: bytesByPolicy, consecutivePayloadSharedPrefixBytes: prefixByPolicy, exactPreviouslyMarkedProjectionBytes: markedByPolicy },
			observations,
		};
		privateJson(join(directory, "requests.json"), model.requests);
		privateJson(join(directory, "events.json"), privateEvents);
		privateJson(join(directory, "summary.json"), summary);
		return summary;
	} finally {
		await memory?.close();
		await store.close();
	}
}

/** Implementation-only entry point; the parent runs this after source settles. */
export async function runCacheReplay(args: string[]): Promise<void> {
	let run: string | undefined;
	let seed = DEFAULT_SEED;
	const seen = new Set<string>();
	for (let i = 0; i < args.length; i += 2) {
		const name = args[i]!;
		const value = args[i + 1];
		check((name === "--run" || name === "--seed") && value !== undefined && !seen.has(name), "expected --run <new-name> [--seed <uint32>]");
		seen.add(name);
		if (name === "--run") run = value;
		else {
			check(/^\d+$/.test(value), "seed must be an unsigned integer");
			seed = Number(value);
			check(Number.isSafeInteger(seed) && seed >= 0 && seed <= 0xffff_ffff, "seed must fit uint32");
		}
	}
	check(run && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,80}$/.test(run), "run must be a new plain directory name");
	check(!lstatSync(RUNS).isSymbolicLink(), "runs directory must not be a symlink");
	const directory = join(RUNS, run);
	execFileSync("git", ["check-ignore", "--quiet", relative(ROOT, directory)], { cwd: ROOT });
	// Refuse overwrite/resume: three repetitions always start with new stores.
	mkdirSync(directory, { mode: 0o700 });
	const sourceHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
	const snapshot = join(directory, "snapshot");
	const files = copySource(join(ROOT, "src"), join(snapshot, "src"));
	const sourceSha256 = hash(json(files));
	check(sourceSha256 === hash(json(copySource(join(ROOT, "src"), undefined))), "source changed while snapshotting; use a fresh run after edits settle");
	const codeFiles = ["evals/compressor/proposals/cache.ts", "evals/compressor/proposals/runner.ts"].map((path) => {
		const data = readFileSync(join(ROOT, path));
		const output = join(snapshot, path);
		mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
		writeFileSync(output, data, { mode: 0o600, flag: "wx" });
		return { path, sha256: hash(data), bytes: data.length };
	});
	const codeSha256 = hash(json(codeFiles));
	const lockfileSha256 = hash(readFileSync(join(ROOT, "bun.lock")));
	const dependencyPaths = [
		"@oh-my-pi/pi-ai/providers/anthropic", "@oh-my-pi/pi-ai/providers/anthropic-client",
		"@oh-my-pi/pi-ai/providers/anthropic-wire", "@oh-my-pi/pi-ai/providers/transform-messages", "@oh-my-pi/pi-catalog",
	];
	const dependencyFiles = dependencyPaths.map((module) => ({ module, path: fileURLToPath(import.meta.resolve(module)) }));
	const dependencies = dependencyFiles.map(({ module, path }) => ({ module, sha256: hash(readFileSync(path)) }));
	const scheduleSet = schedules();
	const chat = fixture(seed);
	const preregistration = {
		version: 1, seed, repeats: REPEATS, sourceHead, sourceSha256, codeSha256, lockfileSha256,
		sourceBinding: "HEAD is provenance only; sourceSha256 binds the copied working-tree bytes, including uncommitted endpoint corrections.",
		files, codeFiles, dependencies, options: OPTIONS,
		sourceChatSha256: hash(json(chat)), schedulesSha256: hash(json(scheduleSet)),
		schedules: scheduleSet, simulatedCostUsd: 0, budgetUsd: 0,
		adoptionRule: "Reject deferred if ANY next turn omits ready baseline merge progress; no grace. Also require all frozen-turn checks, eventual convergence, exact three-repeat reproducibility, endpoint guards and zero client calls. Passing this offline screen alone never authorizes adoption.",
	};
	privateJson(join(directory, "manifest.json"), preregistration);
	privateJson(join(directory, "synthetic-chat.json"), chat);
	// These are genuine runtime-resolved paths to a byte-for-byte source snapshot.
	const memoryModule = await import(pathToFileURL(join(snapshot, "src/memory.ts")).href);
	const storeModule = await import(pathToFileURL(join(snapshot, "src/store.ts")).href);
	const cacheModule = await import(pathToFileURL(join(snapshot, "src/cache.ts")).href);
	const runtime: Runtime = { Memory: memoryModule.Memory, Store: storeModule.Store, cache: cacheModule };
	const endpoint = await endpointCheck(runtime, join(directory, "endpoint-store"), readFileSync(join(snapshot, "src/memory.ts"), "utf8"));
	privateJson(join(directory, "endpoint-check.json"), endpoint);
	const wireEncoder = encoder(runtime.cache);
	privateJson(join(directory, "encoder-fixture.json"), { model: wireEncoder.model, system: SYSTEM, tools: TOOLS });
	const firstDigests = new Map<string, string>();
	const results: Record<string, unknown>[] = [];
	let reproducible = true;
	let partialProgressPassed = true;
	let frozenPassed = true;
	let convergencePassed = true;
	let repeatedAfterBackground = 0;
	for (let repetition = 0; repetition < REPEATS; repetition++) {
		for (const schedule of scheduleSet) {
			const child = join(directory, `repeat-${repetition + 1}`, schedule.name);
			mkdirSync(child, { recursive: true, mode: 0o700 });
			const result = await replay(runtime, wireEncoder.encode, child, schedule, chat, seed);
			const digest = hash(json(result));
			const first = firstDigests.get(schedule.name);
			const repeatMatchesFirst = first === undefined || first === digest;
			firstDigests.set(schedule.name, first ?? digest);
			reproducible &&= repeatMatchesFirst;
			partialProgressPassed &&= result.gates.partialProgress;
			frozenPassed &&= result.gates.frozenTurnEquality;
			convergencePassed &&= result.gates.batchEventualConvergence;
			repeatedAfterBackground += result.frozenTurnChecks.filter((row) => row.completedDuringTurn > 0).length;
			results.push({ repetition: repetition + 1, schedule: schedule.name, replaySha256: digest, repeatMatchesFirst,
				gates: result.gates, firstProgressPublication: result.firstProgressPublication,
				batchTargetReachedTick: result.batchTargetReachedTick, passCompleteTick: result.passCompleteTick,
				partialProgress: result.partialProgress, mergeVisibility: result.mergeVisibility,
				turnOpenWireTotals: result.turnOpenWireTotals,
				safeDetail: `${relative(directory, child)}/summary.json`,
			});
		}
	}
	const snapshotUnchanged = sourceSha256 === hash(json(copySource(join(snapshot, "src"), undefined)));
	const codeUnchanged = codeFiles.every((file) => hash(readFileSync(join(ROOT, file.path))) === file.sha256);
	const dependenciesUnchanged = dependencyFiles.every(({ path }, i) => hash(readFileSync(path)) === dependencies[i]!.sha256);
	const transport = wireEncoder.counters();
	const valid = snapshotUnchanged && codeUnchanged && dependenciesUnchanged && reproducible && frozenPassed && convergencePassed && repeatedAfterBackground > 0 && transport.clientCreateCalls === 0;
	const summary = {
		version: 1, experiment: "cache-replay", seed, repeats: REPEATS, schedules: scheduleSet.length,
		sourceHead, sourceSha256, codeSha256, lockfileSha256, modelSha256: hash(json(wireEncoder.model)), schedulesSha256: preregistration.schedulesSha256,
		sourceChatSha256: preregistration.sourceChatSha256, dependencies, endpoint,
		runtime: { bun: Bun.version, node: process.version, platform: process.platform, arch: process.arch },
		transport, cost: { simulatedUsd: 0, providerCalls: 0, billedSavingsUsd: null, meaning: "No requests sent; wire-cache opportunity is not a billed saving." },
		gates: { validReplay: valid, sameSnapshotBothPolicies: true, snapshotUnchanged, codeUnchanged, dependenciesUnchanged,
			reproducible, partialProgress: partialProgressPassed, frozenTurnEquality: frozenPassed, eventualConvergence: convergencePassed, repeatsAfterBackgroundCompletion: repeatedAfterBackground },
		adoption: { decision: !valid ? "invalid-replay" : !partialProgressPassed ? "reject" : "not-established",
			reason: !valid ? "A replay integrity or frozen/convergence gate failed." : !partialProgressPassed ? "Deferred publication withholds ready baseline progress at a next turn; hard gate fails without any grace window." : "Only an isolated read-publication screen passed, not a production lifecycle or billing proof." },
		boundary: {
			real: ["public Store append/saveNode/saveView and durable snapshots", "public Memory constructor/settle/render/viewParts/close, real coarsen and background merge DAG", "production streamAnthropic request encoder, viewBlocks and applyOptChatCache"],
			simulated: ["synthetic seeded history and deterministic summary replies", "explicit logical completion ticks", "read-side deferred publication until all seven scheduled merges settle", "eval-owned turn snapshot freeze", "static fixture system head and one tool, not installed-host prefix or full tool registry"],
			notTested: ["deferring Memory.commit or Store durability, restart/crash recovery", "changing compressor context visibility, scheduling or dependent summary results", "real host hooks, tool-loop/steering lifecycle, cache coordinator leases", "provider cache admission, twenty-block lookback, TTL, tokenization, usage or billing", "wall-clock/provider latency and live quality"],
		},
		measurement: {
			payloadBytes: "UTF-8 JSON.stringify of the real encoded payload after production cache marker application; private per-request files preserve it.",
			sharedPrefixBytes: "Exact consecutive turn-open serialized-body byte prefix; same-turn repeats are excluded from opportunity totals.",
			cacheOrderProjection: "Explicit tools/system/messages serialized-block projection omitting owning cache_control fields; exact marked-prefix equality is a diagnostic opportunity, NOT server cache identity or cache-hit proof.",
			markerBoundaries: "Actual cache_control block paths and exclusive UTF-8 transport offsets, plus separately labeled cache-order projection bytes/hashes.",
			latency: "Logical event ticks, not milliseconds. A completed merge never selected by real main coarsening has null visibility, not invented latency.",
			pending: "Completed merges represented by baseline's current main tiling but not by the deferred read snapshot; no delay allowance.",
			pass: "One fixed seven-merge dependency DAG. Main half-target completion is recorded separately from all-pass settlement; ancestors built afterward need not appear in the main view.",
		},
		results,
	};
	privateJson(join(directory, "summary.json"), summary);
	console.log(JSON.stringify(summary, null, 2));
}
