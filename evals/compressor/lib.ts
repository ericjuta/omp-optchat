/**
 * Shared pieces of the compressor system-prompt A/B (plans/optchat-jev.md, Decision 2026-10-21, item 3b): a frozen
 * source snapshot, the seeded PRNG, read-only readers for real stores, and the fake store that lets the real
 * `Memory` rebuild one compaction request. Nothing here writes outside evals/compressor/runs/.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { applyOptChatCache, viewBlocks } from "../../src/cache.ts";
import type { sharedToolsAllowed } from "../../src/dialect.ts";
import type { compressorReasoning } from "../../src/index.ts";
import type { CompressorRefusedError, Memory, Summarize } from "../../src/memory.ts";
import type { Store } from "../../src/store.ts";

export const ROOT = resolve(import.meta.dir, "../..");
export const RUNS_DIR = join(ROOT, "evals/compressor/runs");
/** The first run's seed; a later run sets its own with build.ts `--seed`. */
export const SEED = 20261021;
export const DEFAULT_RUN = "ab-20261021";
export const NODE_BYTES = 512;
/** `Memory`'s default page size: a leaf whose source is longer takes several compressor calls and is not a task. */
export const PAGE_BYTES = 16_384;
export const BUDGET_USD = 5;

export const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

export function runDir(run: string): string {
	if (!/^[\w.-]+$/.test(run)) throw new Error("--run must be a plain directory name");
	const dir = join(RUNS_DIR, run);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	return dir;
}

/** Which replies the hard rules score: the compressor's first reply, or the line OptChat's retry path stores. */
export type Basis = "first" | "stored";

export interface Design {
	readonly seed: number;
	readonly basis: Basis;
}

/** A run's seed and scoring basis as build.ts froze them in sample.json; runs built before `basis` existed score first replies. */
export function designOf(dir: string): Design {
	const file = join(dir, "sample.json");
	if (!existsSync(file)) throw new Error("no sample.json: run build.ts first");
	const sample = JSON.parse(readFileSync(file, "utf8")) as { seed?: unknown; basis?: unknown };
	if (typeof sample.seed !== "number") throw new Error(`${file} has no seed`);
	if (sample.basis !== undefined && sample.basis !== "first" && sample.basis !== "stored") throw new Error(`${file} has an unknown basis`);
	return { seed: sample.seed, basis: sample.basis ?? "first" };
}

export function flag(args: string[], name: string, fallback: string): string {
	const at = args.indexOf(name);
	return at >= 0 && args[at + 1] !== undefined ? args[at + 1]! : fallback;
}

/** mulberry32: a small seeded generator; the same seed always gives the same sequence. */
export function prng(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
	};
}

/** A per-key generator: independent of any other key's draws. */
export function keyedPrng(seed: number, key: string): () => number {
	return prng((seed ^ parseInt(sha256(key).slice(0, 8), 16)) >>> 0);
}

export function shuffled<T>(items: readonly T[], random: () => number): T[] {
	const out = items.slice();
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(random() * (i + 1));
		[out[i], out[j]] = [out[j]!, out[i]!];
	}
	return out;
}

export interface StoreMessage {
	i: number;
	kind: string;
	text: string;
	size: number;
	date: string;
}

export interface StoreRow {
	l: number;
	i: number;
	text: string;
	size: number;
}

/** The real stores, read-only: `~/.omp/agent/optchat`, `~/.omp/agent/optchat-worktrees/*` and `~/.omp/agent/optchat-dirs/*`. */
export function storeDirectories(): string[] {
	const agent = join(homedir(), ".omp/agent");
	const dirs = [join(agent, "optchat")];
	for (const group of ["optchat-worktrees", "optchat-dirs"]) {
		const parent = join(agent, group);
		if (existsSync(parent)) for (const name of readdirSync(parent).sort()) dirs.push(join(parent, name));
	}
	return dirs.filter((dir) => existsSync(join(dir, "main")) && existsSync(join(dir, "tree")));
}

function jsonLines<T>(directory: string): T[] {
	const rows: T[] = [];
	for (const name of readdirSync(directory).filter((file) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(file)).sort()) {
		for (const line of readFileSync(join(directory, name), "utf8").split("\n")) {
			if (line.trim()) rows.push(JSON.parse(line));
		}
	}
	return rows;
}

export interface LoadedStore {
	readonly directory: string;
	readonly messages: StoreMessage[];
	/** Tree rows in build (file) order. */
	readonly rows: StoreRow[];
}

export function loadStore(directory: string): LoadedStore {
	const messages = jsonLines<StoreMessage>(join(directory, "main"));
	messages.forEach((message, index) => {
		if (message.i !== index) throw new Error(`${directory}: message ids are not dense at ${index}`);
	});
	return { directory, messages, rows: jsonLines<StoreRow>(join(directory, "tree")) };
}

export const nodeKey = (l: number, i: number): string => `${l}:${i}`;
export const utf8Bytes = (text: string): number => Buffer.byteLength(text, "utf8");
export const flatten = (text: string): string => text.replace(/\r\n|\r|\n/g, " ");

/** The tree as it stood just before row `k` was written. */
export function nodesBefore(store: LoadedStore, k: number): Map<string, StoreRow> {
	const nodes = new Map<string, StoreRow>();
	for (let at = 0; at < k; at++) {
		const row = store.rows[at]!;
		nodes.set(nodeKey(row.l, row.i), row);
	}
	return nodes;
}

/** What a task's source is, as `Memory.build` forms it, or undefined when the node's children are not yet built. */
export function sourceOf(
	store: LoadedStore,
	nodes: ReadonlyMap<string, StoreRow>,
	l: number,
	i: number,
): { source: string; input: string } | undefined {
	if (l === 0) {
		const message = store.messages[i];
		if (!message) return undefined;
		const source = `${message.kind}: ${message.text}`;
		return { source, input: source };
	}
	const left = nodes.get(nodeKey(l - 1, i * 2));
	const right = nodes.get(nodeKey(l - 1, i * 2 + 1));
	if (!left || !right) return undefined;
	return { source: `${left.text}\n${right.text}`, input: `${flatten(left.text)}\n${flatten(right.text)}` };
}

/** A stand-in is a source excerpt the code wrote, never compressor output. */
export const isStandIn = (text: string): boolean => text.startsWith("[unsummarized");

/**
 * The source tree of `rev` as a frozen snapshot under the run directory, with the head detector exported, so the A/B
 * runs the same `Memory`, cache layout and system block whatever other work changes src/ meanwhile.
 */
export async function loadSnapshot(run: string, rev: string) {
	const sha = execFileSync("git", ["rev-parse", "--verify", `${rev}^{commit}`], { cwd: ROOT, encoding: "utf8" }).trim();
	const dir = join(runDir(run), `snapshot-${sha.slice(0, 12)}`);
	if (!existsSync(join(dir, "src/memory.ts"))) {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		const archive = execFileSync("git", ["archive", sha, "src"], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
		execFileSync("tar", ["-x", "-C", dir], { input: archive });
		appendFileSync(join(dir, "src/memory.ts"), "\nexport { replyHead as __replyHead };\n");
	}
	// The specifier is the run-time path of a frozen snapshot, so a static import cannot name it.
	const memory = await import(join(dir, "src/memory.ts"));
	const prompts = await import(join(dir, "src/prompts.ts"));
	const index = await import(join(dir, "src/index.ts"));
	const cache = await import(join(dir, "src/cache.ts"));
	const dialect = await import(join(dir, "src/dialect.ts"));
	const snapshot: Snapshot = {
		sha,
		dir,
		Memory: memory.Memory,
		CompressorRefusedError: memory.CompressorRefusedError,
		replyHead: memory.__replyHead,
		SYSTEM_BLOCK: index.SYSTEM_BLOCK,
		COMPACT: prompts.COMPACT,
		compressorReasoning: index.compressorReasoning,
		viewBlocks: cache.viewBlocks,
		applyOptChatCache: cache.applyOptChatCache,
		sharedToolsAllowed: dialect.sharedToolsAllowed,
	};
	return snapshot;
}

export interface Snapshot {
	readonly sha: string;
	readonly dir: string;
	readonly Memory: typeof Memory;
	readonly CompressorRefusedError: typeof CompressorRefusedError;
	readonly replyHead: (reply: string, own: { lo: number; hi: number }) => number;
	readonly SYSTEM_BLOCK: string;
	readonly COMPACT: string;
	readonly compressorReasoning: typeof compressorReasoning;
	readonly viewBlocks: typeof viewBlocks;
	readonly applyOptChatCache: typeof applyOptChatCache;
	readonly sharedToolsAllowed: typeof sharedToolsAllowed;
}

/** The minimal store surface `Memory` reads, filled from a real store's prefix. Nothing is ever written. */
export function fakeStore(store: LoadedStore, length: number, nodes: ReadonlyMap<string, StoreRow>) {
	return {
		messages: store.messages.slice(0, length),
		nodes: new Map(nodes),
		viewSnapshot: undefined,
		saveNode: () => {},
		saveView: () => {},
		append: () => {
			throw new Error("the A/B never appends");
		},
	};
}

export interface Task {
	readonly id: string;
	readonly store: string;
	readonly node: "leaf" | "merge";
	readonly l: number;
	readonly i: number;
	/** Index of the tree row that stored this node in its store's file order. */
	readonly row: number;
	readonly start: number;
	readonly end: number;
	/** Whether a user record lies in the covered range. */
	readonly user: boolean;
	readonly kind?: string;
	readonly inputBytes: number;
	readonly contextBytes: number;
	/** The request `Memory` builds for the first attempt. Real chat text: gitignored under runs/ only. */
	readonly context: string;
	readonly instruction: string;
	/** The line production stored (historical, from the store). */
	readonly stored: string;
}

/** The private surface of `Memory` the A/B drives: one node's compaction without the scheduler. */
interface MemoryInternals {
	stopped: boolean;
	summarizeLong(part: { l: number; i: number }, input: string, signal: AbortSignal): Promise<string | undefined>;
}

/**
 * Runs the real `Memory` compaction path (request construction, retries, head cutting) for one node of a real
 * store's prefix, with `summarize` as the compressor. The scheduler never runs, so only `summarize`'s own calls
 * can reach a provider, and nothing is written.
 */
export async function compactNode(
	snapshot: Snapshot,
	store: LoadedStore,
	nodes: ReadonlyMap<string, StoreRow>,
	node: { l: number; i: number; start: number; end: number },
	summarize: Summarize,
	signal: AbortSignal,
): Promise<string | undefined> {
	const length = node.l === 0 ? node.i + 1 : node.end;
	// The fake carries only what Memory reads; Memory's constructor type names the real Store.
	const standIn = fakeStore(store, length, nodes) as unknown as Store;
	const memory = new snapshot.Memory(standIn, summarize, { nodeBytes: NODE_BYTES, report: () => {} });
	// Memory's constructor schedules its pump; stop it for one tick so no node is built behind the A/B's back.
	// The A/B reaches summarizeLong, which Memory declares private, through this narrow view.
	const internals = memory as unknown as MemoryInternals;
	internals.stopped = true;
	await Promise.resolve();
	internals.stopped = false;
	const input = sourceOf(store, nodes, node.l, node.i)!.input;
	return internals.summarizeLong({ l: node.l, i: node.i }, input, signal);
}

/** Whether a user record lies in the node's covered messages. */
export function coversUser(store: LoadedStore, lo: number, hi: number): boolean {
	for (let i = lo; i <= hi && i < store.messages.length; i++) if (store.messages[i]!.kind === "user") return true;
	return false;
}
