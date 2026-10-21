/**
 * Builds the task set for the compressor system-prompt A/B: about 40 real compaction tasks (leaves and merges) sampled
 * with seed 20261021 from the real stores, each with the request `Memory` builds for it. The stores are read, never
 * written. The tasks hold real chat text, so they live only under evals/compressor/runs/ (gitignored).
 *
 * Usage: bun evals/compressor/build.ts [--run ab-20261021] [--rev HEAD] [--leaves 20] [--merges 20] [--per-store 6]
 * Output: runs/<run>/tasks.jsonl and runs/<run>/sample.json (composition only, no text).
 */
import { writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
	compactNode,
	coversUser,
	DEFAULT_RUN,
	flag,
	isStandIn,
	keyedPrng,
	loadSnapshot,
	loadStore,
	nodeKey,
	NODE_BYTES,
	nodesBefore,
	PAGE_BYTES,
	runDir,
	SEED,
	shuffled,
	sourceOf,
	storeDirectories,
	type LoadedStore,
	type Task,
	utf8Bytes,
} from "./lib.ts";

interface Candidate {
	readonly store: LoadedStore;
	readonly row: number;
	readonly l: number;
	readonly i: number;
	/** Whether a user record lies in the covered messages. */
	readonly user: boolean;
}

/** Tree rows a compressor wrote: sources longer than the node budget (shorter ones are stored verbatim). */
function candidates(store: LoadedStore): Candidate[] {
	const found: Candidate[] = [];
	const nodes = new Map<string, (typeof store.rows)[number]>();
	store.rows.forEach((row, k) => {
		const key = nodeKey(row.l, row.i);
		const first = !nodes.has(key);
		const source = sourceOf(store, nodes, row.l, row.i);
		nodes.set(key, row);
		if (!first || !source || isStandIn(row.text)) return;
		const bytes = utf8Bytes(source.source);
		if (bytes <= NODE_BYTES || row.text === source.source) return;
		// A leaf over one page takes several compressor calls and several reductions: not a single task.
		if (row.l === 0 && utf8Bytes(source.input) > PAGE_BYTES) return;
		const lo = row.i * 2 ** row.l;
		const hi = row.l === 0 ? lo : lo + 2 ** row.l - 1;
		found.push({ store, row: k, l: row.l, i: row.i, user: coversUser(store, lo, hi) });
	});
	return found;
}

/**
 * `count` candidates in seeded order, at most `perStore` per store. The first `userMin` come from the candidates that
 * cover a user record, so the user's own words (the compaction's first priority) are tested, not only tool output.
 */
function pick(pool: Candidate[], count: number, perStore: number, userMin: number, random: () => number): Candidate[] {
	const taken: Candidate[] = [];
	const perDirectory = new Map<string, number>();
	const order = shuffled(pool, random);
	const take = (candidate: Candidate): boolean => {
		const used = perDirectory.get(candidate.store.directory) ?? 0;
		if (used >= perStore) return false;
		perDirectory.set(candidate.store.directory, used + 1);
		taken.push(candidate);
		return true;
	};
	for (const candidate of order) {
		if (taken.length >= userMin) break;
		if (candidate.user) take(candidate);
	}
	for (const candidate of order) {
		if (taken.length === count) break;
		if (!taken.includes(candidate)) take(candidate);
	}
	return taken;
}

async function main(args: string[]): Promise<void> {
	const run = flag(args, "--run", DEFAULT_RUN);
	const rev = flag(args, "--rev", "HEAD");
	const wantLeaves = Number(flag(args, "--leaves", "20"));
	const wantMerges = Number(flag(args, "--merges", "20"));
	const perStore = Number(flag(args, "--per-store", "6"));
	const userMin = Number(flag(args, "--user-min", "5"));
	const dir = runDir(run);
	const snapshot = await loadSnapshot(run, rev);
	const stores = storeDirectories().map(loadStore);
	const all = stores.flatMap(candidates);
	const leafPool = all.filter((candidate) => candidate.l === 0);
	const mergePool = all.filter((candidate) => candidate.l > 0);
	const random = keyedPrng(SEED, "sample");
	const chosen = [
		...pick(leafPool, wantLeaves, perStore, userMin, random).map((candidate) => ({ candidate, node: "leaf" as const })),
		...pick(mergePool, wantMerges, perStore, userMin, random).map((candidate) => ({ candidate, node: "merge" as const })),
	];
	const tasks: Task[] = [];
	for (const [position, { candidate, node }] of shuffled(chosen, random).entries()) {
		const { store, row, l, i } = candidate;
		const width = 2 ** l;
		const start = i * width;
		const end = (i + 1) * width;
		const nodes = nodesBefore(store, row);
		let captured: { context: string; instruction: string } | undefined;
		const stop = new Error("captured");
		await compactNode(snapshot, store, nodes, { l, i, start, end }, async (request) => {
			captured = { context: request.context, instruction: request.instruction };
			throw stop;
		}, new AbortController().signal).catch((error: unknown) => {
			if (error !== stop) throw error;
		});
		if (!captured) throw new Error(`no request captured for ${basename(store.directory)} ${l}+${i}`);
		const lo = node === "leaf" ? i : start;
		const hi = node === "leaf" ? i : end - 1;
		tasks.push({
			id: `t${String(position + 1).padStart(2, "0")}`,
			store: basename(store.directory),
			node,
			l,
			i,
			row,
			start,
			end,
			user: coversUser(store, lo, hi),
			kind: node === "leaf" ? store.messages[i]!.kind : undefined,
			inputBytes: utf8Bytes(sourceOf(store, nodes, l, i)!.input),
			contextBytes: utf8Bytes(captured.context),
			context: captured.context,
			instruction: captured.instruction,
			stored: store.rows[row]!.text,
		});
	}
	writeFileSync(join(dir, "tasks.jsonl"), `${tasks.map((task) => JSON.stringify(task)).join("\n")}\n`, { mode: 0o600 });
	const tally = <K extends string>(key: (task: Task) => K): Record<string, number> => {
		const counts: Record<string, number> = {};
		for (const task of tasks) counts[key(task)] = (counts[key(task)] ?? 0) + 1;
		return counts;
	};
	const sample = {
		seed: SEED,
		sourceRev: snapshot.sha,
		stores: stores.length,
		eligible: { leaves: leafPool.length, merges: mergePool.length },
		eligibleWithUser: { leaves: leafPool.filter((c) => c.user).length, merges: mergePool.filter((c) => c.user).length },
		userStratumMinPerNode: userMin,
		tasks: tasks.length,
		byNode: tally((task) => task.node),
		byStore: tally((task) => task.store),
		leafKinds: tally((task) => (task.kind ?? "merge") as string),
		withUserRecord: tasks.filter((task) => task.user).length,
		inputBytes: { min: Math.min(...tasks.map((t) => t.inputBytes)), max: Math.max(...tasks.map((t) => t.inputBytes)) },
		contextBytes: { min: Math.min(...tasks.map((t) => t.contextBytes)), max: Math.max(...tasks.map((t) => t.contextBytes)) },
	};
	writeFileSync(join(dir, "sample.json"), JSON.stringify(sample, null, 2), { mode: 0o600 });
	console.log(JSON.stringify(sample, null, 2));
}

if (import.meta.main) await main(process.argv.slice(2));
