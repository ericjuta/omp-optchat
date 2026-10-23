/** Read-only source sampling and a fresh, isolated loopback host capture. No paid calls. */
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	appendFileSync,
	chmodSync,
	constants,
	copyFileSync,
	createReadStream,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import {
	compactNode,
	coversUser,
	isStandIn,
	keyedPrng,
	loadSnapshot,
	loadStore,
	nodeKey,
	NODE_BYTES,
	nodesBefore,
	PAGE_BYTES,
	ROOT,
	RUNS_DIR,
	runDir,
	sha256,
	shuffled,
	snapshotCache,
	sourceOf,
	storeDirectories,
	utf8Bytes,
	type LoadedStore,
	type Snapshot,
	type StoreRow,
} from "../lib.ts";

/** The wire artifact written by capture.ts, not a synthesized host prompt. */
export interface HostPrefix {
	readonly model: string;
	readonly systemPrompt: string[];
	readonly system: unknown;
	readonly tools: unknown[];
}

/** Frozen inputs shared by fresh preparation and unpaid immutable-input reuse. */
export interface PreparedInputs {
	readonly snapshot: PreparedSnapshot;
	readonly tasks: FrozenMergeTask[];
	readonly host: HostPrefix;
	readonly capture: object;
	readonly exclusions: object;
}

export interface FrozenMergePrefix {
	readonly systemPrompt: string[];
	readonly tools?: unknown[];
	readonly systemHash: string;
	readonly toolsHash: string;
	readonly capturedHash: string;
	readonly policy: string;
}

/** Only these old manifest fields may seed the next manifest; code/models are re-frozen separately. */
export interface FrozenMergeOrigin {
	readonly prefix: FrozenMergePrefix;
	readonly sourceBasis: string;
	readonly requestedRev: string;
	readonly capture: object;
	readonly exclusions: object;
	readonly models: { readonly main: unknown; readonly compressor: unknown; readonly judge: unknown };
}

export interface ReusedPreparedInputs extends PreparedInputs {
	readonly originManifestSha256: string;
	readonly hooksAlreadyPresent: true;
	readonly originManifest: FrozenMergeOrigin;
}

/** WORKTREE sha is a content digest, never a claim that dirty source equals its parent commit. */
export interface PreparedSnapshot extends Snapshot {
	readonly sourceBasis: "git-commit" | "working-tree";
	readonly parentCommit: string;
	/** Original src inventory digest, before the eval-only export is appended. */
	readonly sourceDigest: string;
}

export interface FrozenMergeTask {
	readonly id: string;
	readonly l: number;
	readonly i: number;
	readonly start: number;
	/** Exclusive message endpoint. */
	readonly end: number;
	readonly user: boolean;
	readonly third: "early" | "middle" | "late";
	readonly input: string;
	readonly inputSha256: string;
	readonly context: string;
	readonly instruction: string;
	readonly stored: string;
	/** Private artifact only: the complete message prefix, never reread during a run. */
	readonly store: LoadedStore;
	readonly nodes: Array<[string, StoreRow]>;
	/** Original, unflattened child rows for blind meaning-preservation judgments. */
	readonly children: [StoreRow, StoreRow];
	readonly provenance: {
		readonly sourceRevision: string;
		readonly storeId: string;
		readonly row: number;
		readonly node: string;
		readonly children: Array<{ node: string; row: number; textSha256: string }>;
		readonly sourceSha256: string;
		readonly messagePrefixSha256: string;
		readonly nodesSha256: string;
		readonly endDate: string;
		/** N: transcript record count at preparation, before slicing the replay prefix. */
		readonly transcriptLength: number;
		/** E: covered exclusive endpoint used for the within-transcript position bucket. */
		readonly coveredEnd: number;
		readonly chronologicalRank: number;
		readonly eligibleCount: number;
	};
}

type Third = FrozenMergeTask["third"];
interface Candidate {
	store: LoadedStore;
	storeId: string;
	row: number;
	l: number;
	i: number;
	start: number;
	end: number;
	endDate: string;
	time: number;
	input: string;
	inputSha256: string;
	sourceSha256: string;
	children: [StoreRow, StoreRow];
	childRows: [number, number];
}

type JsonObject = Record<string, unknown>;
const object = (value: unknown): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value);
const digest = (value: unknown): string => sha256(JSON.stringify(value));
const bytesHash = (value: Uint8Array): string => createHash("sha256").update(value).digest("hex");
const chronological = (a: Candidate, b: Candidate): number =>
	a.time - b.time || (a.storeId < b.storeId ? -1 : a.storeId > b.storeId ? 1 : 0) || a.l - b.l || a.i - b.i || a.row - b.row;

function privateWrite(path: string, value: unknown): void {
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
}

function existingRun(run: string): string {
	if (!/^[\w.-]+$/.test(run) || run === "." || run === "..") throw new Error("run names must be plain directory names, not . or ..");
	const path = join(RUNS_DIR, run);
	if (existsSync(path) && (lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory())) {
		throw new Error("run directory must be a real directory, not a symlink");
	}
	return path;
}

const REPLY_HEAD_EXPORT = "\nexport { replyHead as __replyHead };\n";

/** Sorted raw-byte inventory; optional copying uses those same bytes, never a second file read. */
function sourceInventory(root: string, target?: string, stripReplyHeadExport = false): Array<{ path: string; sha256: string }> {
	const files: Array<{ path: string; sha256: string }> = [];
	const visit = (directory: string): void => {
		const source = join(root, directory);
		if (lstatSync(source).isSymbolicLink()) throw new Error("snapshot source directories must not be symlinks");
		if (target) mkdirSync(join(target, directory), { recursive: true, mode: 0o700 });
		const entries = readdirSync(source, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
		for (const entry of entries) {
			const path = directory ? `${directory}/${entry.name}` : entry.name;
			if (entry.isDirectory()) { visit(path); continue; }
			if (!entry.isFile()) throw new Error("snapshot source must contain only regular files and directories");
			let bytes = readFileSync(join(root, path));
			if (stripReplyHeadExport && path === "memory.ts") {
				const suffix = Buffer.from(REPLY_HEAD_EXPORT);
				if (!bytes.subarray(-suffix.length).equals(suffix)) throw new Error("commit snapshot lacks the expected eval-only export");
				bytes = bytes.subarray(0, bytes.length - suffix.length);
			}
			files.push({ path, sha256: bytesHash(bytes) });
			if (target) writeFileSync(join(target, path), bytes, { mode: 0o600, flag: "wx" });
		}
	};
	visit("");
	if (!files.some((file) => file.path === "memory.ts") || !files.some((file) => file.path === "index.ts")) {
		throw new Error("snapshot source is missing Memory or the host entrypoint");
	}
	return files;
}

/**
 * WORKTREE creates a new exact-content snapshot. A 64-hex revision only reopens that run's existing snapshot;
 * it never falls back to the live tree. Commit revisions retain lib.ts's source-commit loader.
 * The owner verifies final snapshot tree hashes (including its additional export hooks) before replay.
 */
export async function loadPreparedSnapshot(run: string, sourceRev: string): Promise<PreparedSnapshot> {
	existingRun(run);
	const runRoot = runDir(run);
	const metadataPath = join(runRoot, "source-provenance.json");
	let revision = sourceRev;
	if (sourceRev === "WORKTREE") {
		if (existsSync(metadataPath)) throw new Error("source provenance already exists; choose a fresh run");
		const parentCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
		const source = join(ROOT, "src");
		const before = sourceInventory(source);
		const staging = mkdtempSync(join(runRoot, "snapshot-copy-"));
		const copied = sourceInventory(source, join(staging, "src"));
		const after = sourceInventory(source);
		const sourceDigest = digest(copied);
		const afterCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
		if (sourceDigest !== digest(before) || sourceDigest !== digest(after) || parentCommit !== afterCommit) {
			throw new Error("source changed during snapshot copy; preparation requires settled source and a fresh run");
		}
		revision = sourceDigest;
		const destination = join(runRoot, `snapshot-${revision}`);
		if (existsSync(destination)) throw new Error("content snapshot already exists; refusing to reuse stale preparation output");
		appendFileSync(join(staging, "src/memory.ts"), REPLY_HEAD_EXPORT);
		renameSync(staging, destination);
		privateWrite(metadataPath, { sourceBasis: "working-tree", sourceRevision: revision, parentCommit, sourceDigest,
			files: copied, evalOnlyExport: REPLY_HEAD_EXPORT, meaning: "exact current src bytes, not parent-commit equivalence" });
	}
	if (!/^[a-f0-9]{64}$/.test(revision)) {
		const snapshot = await loadSnapshot(run, revision);
		if (!existsSync(metadataPath)) {
			const files = sourceInventory(join(snapshot.dir, "src"), undefined, true);
			privateWrite(metadataPath, { sourceBasis: "git-commit", sourceRevision: snapshot.sha, parentCommit: snapshot.sha,
				sourceDigest: digest(files), files, evalOnlyExport: REPLY_HEAD_EXPORT });
		}
		const info: unknown = JSON.parse(readFileSync(metadataPath, "utf8"));
		if (!object(info) || info.sourceBasis !== "git-commit" || info.sourceRevision !== snapshot.sha ||
			typeof info.parentCommit !== "string" || typeof info.sourceDigest !== "string") throw new Error("commit snapshot provenance does not match");
		return { ...snapshot, sourceBasis: "git-commit", parentCommit: info.parentCommit, sourceDigest: info.sourceDigest };
	}
	const dir = join(runRoot, `snapshot-${revision}`);
	if (!existsSync(metadataPath) || !existsSync(dir) || lstatSync(dir).isSymbolicLink()) {
		throw new Error("frozen working-tree snapshot is unavailable; live source cannot replace it");
	}
	const info: unknown = JSON.parse(readFileSync(metadataPath, "utf8"));
	if (!object(info) || info.sourceBasis !== "working-tree" || info.sourceRevision !== revision ||
		info.sourceDigest !== revision || typeof info.parentCommit !== "string") throw new Error("working-tree snapshot provenance does not match");
	// Old immutable source predates the in-module cache declaration. Its old manifest's explicit
	// contract may be carried by hash-bound reuse provenance, never inferred from returned payloads.
	const reusePath = join(runRoot, "source-reuse-provenance.json");
	let historicalCacheShape: "payload" | "outcome" | undefined;
	if (existsSync(reusePath)) {
		const reuse: unknown = JSON.parse(readFileSync(frozenPath(runRoot, "source-reuse-provenance.json"), "utf8"));
		if (!object(reuse) || reuse.version !== 1 || reuse.sourceRevision !== revision || reuse.snapshotDirectory !== `snapshot-${revision}` ||
			typeof reuse.originManifestSha256 !== "string" || !/^[a-f0-9]{64}$/.test(reuse.originManifestSha256) ||
			!frozenHashes(reuse.originalArtifacts) || !frozenHashes(reuse.sourceHashes) ||
			reuse.originalArtifacts["source-provenance.json"] !== bytesHash(readFileSync(frozenPath(runRoot, "source-provenance.json"))) ||
			!object(reuse.cacheContract) || reuse.cacheContract.originManifestSha256 !== reuse.originManifestSha256 ||
			reuse.cacheContract.sourceHashesSha256 !== digest(reuse.sourceHashes) ||
			(reuse.cacheContract.returnShape !== "payload" && reuse.cacheContract.returnShape !== "outcome")) {
			throw new Error("reused snapshot lacks a hash-bound historical cache contract");
		}
		const hashes = Object.fromEntries(sourceInventory(frozenPath(runRoot, `snapshot-${revision}/src`, true)).map((file) => [file.path, file.sha256]));
		if (!sameFrozenValue(hashes, reuse.sourceHashes)) throw new Error("historical cache contract source hashes differ");
		historicalCacheShape = reuse.cacheContract.returnShape;
	}
	// The content-addressed run directory is chosen at runtime; a static specifier cannot name this snapshot.
	const memory = await import(join(dir, "src/memory.ts"));
	if (typeof memory.hasUserSpeaker !== "function") throw new Error("WORKTREE snapshot lacks the required exported speaker guard");
	const prompts = await import(join(dir, "src/prompts.ts"));
	const index = await import(join(dir, "src/index.ts"));
	const cache = await import(join(dir, "src/cache.ts"));
	const dialect = await import(join(dir, "src/dialect.ts"));
	const declaredCacheShape = Object.hasOwn(cache, "OPTCHAT_CACHE_RESULT_CONTRACT") ? snapshotCache(cache).cacheReturnShape : undefined;
	if (historicalCacheShape !== undefined && declaredCacheShape !== undefined && historicalCacheShape !== declaredCacheShape) {
		throw new Error("historical and source-declared cache contracts disagree");
	}
	if (historicalCacheShape === undefined && declaredCacheShape === undefined) throw new Error("working-tree snapshot has no explicit cache result contract");
	const cacheAdapter = historicalCacheShape === "outcome" && declaredCacheShape === undefined
		? snapshotCache({ applyOptChatCache: cache.applyOptChatCache, OPTCHAT_CACHE_RESULT_CONTRACT: "payload-mode-v1" })
		: snapshotCache(cache);
	return { sha: revision, dir, sourceBasis: "working-tree", parentCommit: info.parentCommit, sourceDigest: revision,
		Memory: memory.Memory, CompressorRefusedError: memory.CompressorRefusedError, replyHead: memory.__replyHead,
		SYSTEM_BLOCK: index.SYSTEM_BLOCK, COMPACT: prompts.COMPACT, compressorReasoning: index.compressorReasoning,
		viewBlocks: cache.viewBlocks, ...cacheAdapter, sharedToolsAllowed: dialect.sharedToolsAllowed };
}

/** The legacy instructions embed the exact flattened merge input, including any XML-like source text. */
function legacyInput(task: JsonObject): string | undefined {
	if (typeof task.instruction !== "string" || typeof task.l !== "number" || !Number.isInteger(task.l) || task.l < 1 || task.l > 52 ||
		typeof task.i !== "number" || !Number.isSafeInteger(task.i) || task.i < 0) return undefined;
	const start = task.i * 2 ** task.l;
	const end = (task.i + 1) * 2 ** task.l;
	const half = 2 ** (task.l - 1);
	if (!Number.isSafeInteger(end) || task.start !== start || task.end !== end) return undefined;
	// This exact single-page frame is shared by the two earlier datasets' frozen Memory implementations.
	const prefix = `Compaction: merge lines ${start}+${half} and ${start + half}+${half}, adjacent, into one line of at most 512 bytes\n` +
		`(about 70 words), the length of this ruler:\n${"-".repeat(512)}\n` +
		`<chat> may hold their messages, ${start} to ${end - 1}, in more detail: take details\nof them from there too.\n<input>\n`;
	const suffix = "\n</input>";
	if (!task.instruction.startsWith(prefix) || !task.instruction.endsWith(suffix)) return undefined;
	const input = task.instruction.slice(prefix.length, -suffix.length);
	// Remove only the fixed outer frame: literal XML-like source text is data, not another delimiter.
	return input.split("\n").length === 2 && !input.includes("\r") && utf8Bytes(input) === task.inputBytes &&
		utf8Bytes(input) <= PAGE_BYTES ? input : undefined;
}

function priorExclusions(runs: string[]): { hashes: Set<string>; sourceHashes: Set<string>; report: object } {
	const hashes = new Set<string>();
	const sourceHashes = new Set<string>();
	const evidence: object[] = [];
	for (const run of [...new Set(runs)]) {
		const dir = existingRun(run);
		const tasksFile = join(dir, "tasks.jsonl");
		const manifestFile = join(dir, "manifest.json");
		const file = existsSync(tasksFile) ? tasksFile : manifestFile;
		if (!existsSync(file)) throw new Error(`excluded run ${run} has no tasks.jsonl or manifest.json; exclusions cannot be proven`);
		const bytes = readFileSync(file);
		const artifactSha256 = bytesHash(bytes);
		let rows: unknown[];
		if (file === tasksFile) {
			rows = bytes.toString("utf8").split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
		} else {
			const manifest: unknown = JSON.parse(bytes.toString("utf8"));
			if (!object(manifest) || !Array.isArray(manifest.tasks)) throw new Error(`excluded run ${run} has no exact inline task inventory`);
			rows = manifest.tasks;
		}
		const frozenFile = join(dir, "frozen.json");
		let binding: { artifact: string; sha256: string; sourceRevision: unknown } | undefined;
		if (file === tasksFile && existsSync(frozenFile)) {
			const frozenBytes = readFileSync(frozenFile);
			const frozen: unknown = JSON.parse(frozenBytes.toString("utf8"));
			if (!object(frozen) || frozen.tasksSha256 !== artifactSha256) throw new Error(`excluded run ${run} does not match its frozen task binding`);
			binding = { artifact: relative(ROOT, frozenFile), sha256: bytesHash(frozenBytes), sourceRevision: frozen.sourceRev ?? null };
		}
		let merges = 0;
		const methods: Record<string, number> = {};
		for (const value of rows) {
			if (!object(value)) throw new Error(`excluded run ${run} contains a malformed task`);
			if (value.node === "leaf" || value.l === 0) continue;
			if (value.node !== "merge" && !(typeof value.l === "number" && Number.isInteger(value.l) && value.l > 0)) {
				throw new Error(`excluded run ${run} has an unidentifiable task kind`);
			}
			let input = typeof value.input === "string" ? value.input : undefined;
			let method = "frozen-input";
			if (input === undefined) {
				input = legacyInput(value);
				method = "exact-legacy-instruction-input";
			}
			const declared = value.inputSha256;
			if (declared !== undefined && (typeof declared !== "string" || !/^[a-f0-9]{64}$/.test(declared))) {
				throw new Error(`excluded run ${run} has an invalid input hash`);
			}
			if (input !== undefined && declared !== undefined && sha256(input) !== declared) {
				throw new Error(`excluded run ${run} input does not match its hash`);
			}
			if (input === undefined && declared === undefined) {
				throw new Error(`excluded run ${run} lacks exact input evidence; refusing reconstruction from a drifting live store`);
			}
			if (input !== undefined) hashes.add(sha256(input));
			else if (typeof declared === "string") hashes.add(declared);
			const sourceHash = value.sourceSha256 ?? (object(value.provenance) ? value.provenance.sourceSha256 : undefined);
			if (sourceHash !== undefined) {
				if (typeof sourceHash !== "string" || !/^[a-f0-9]{64}$/.test(sourceHash)) throw new Error(`excluded run ${run} has an invalid original-source hash`);
				sourceHashes.add(sourceHash);
			}
			if (input === undefined) method = "frozen-input-hash";
			methods[method] = (methods[method] ?? 0) + 1;
			merges++;
		}
		if (merges === 0) throw new Error(`excluded run ${run} contains no merge evidence`);
		evidence.push({ run, artifact: relative(ROOT, file), artifactSha256, binding: binding ?? null, merges, methods });
	}
	return { hashes, sourceHashes, report: { semantics: "union of earlier complete two-child merge-input hashes, plus original-source hashes where recorded", runs: evidence,
		uniqueInputHashes: hashes.size, uniqueOriginalSourceHashes: sourceHashes.size,
		limitations: "legacy artifacts prove saved build-time inputs, not historical wire bytes (old runs reread live stores); excludes identical pairs, not partial child overlap, paraphrases, or context reuse" } };
}

function eligible(stores: LoadedStore[], excluded: Set<string>, excludedSources: Set<string>): { candidates: Candidate[]; counts: Record<string, number> } {
	const candidates: Candidate[] = [];
	const counts: Record<string, number> = {};
	const reject = (reason: string): void => { counts[reason] = (counts[reason] ?? 0) + 1; };
	for (const store of stores) {
		const nodes = new Map<string, StoreRow>();
		const rowIndices = new Map<string, number>();
		const storeId = sha256(store.directory);
		for (const [rowIndex, row] of store.rows.entries()) {
			if (!object(row) || !Number.isInteger(row.l) || row.l < 0 || row.l > 52 || !Number.isSafeInteger(row.i) || row.i < 0) {
				reject("malformedNode");
				continue;
			}
			const key = nodeKey(row.l, row.i);
			const leftKey = nodeKey(row.l - 1, row.i * 2);
			const rightKey = nodeKey(row.l - 1, row.i * 2 + 1);
			const left = nodes.get(leftKey);
			const right = nodes.get(rightKey);
			const childRows: [number, number] = [rowIndices.get(leftKey) ?? -1, rowIndices.get(rightKey) ?? -1];
			nodes.set(key, row);
			rowIndices.set(key, rowIndex);
			if (row.l === 0) continue;
			counts.mergeRows = (counts.mergeRows ?? 0) + 1;
			const validText = (value: StoreRow | undefined): value is StoreRow => value !== undefined &&
				typeof value.text === "string" && value.text.trim().length > 0 &&
				Number.isSafeInteger(value.size) && value.size >= 0 && value.size === utf8Bytes(value.text);
			if (!validText(left) || !validText(right) || !validText(row)) { reject("missingOrMalformedChildrenOrRow"); continue; }
			if ([left, right, row].some((value) => isStandIn(value.text))) { reject("standIn"); continue; }
			const start = row.i * 2 ** row.l;
			const end = (row.i + 1) * 2 ** row.l;
			if (!Number.isSafeInteger(end) || end > store.messages.length) { reject("missingMessages"); continue; }
			const endDate = store.messages[end - 1]?.date;
			const time = typeof endDate === "string" ? Date.parse(endDate) : NaN;
			if (!Number.isFinite(time) || typeof endDate !== "string") { reject("missingEndDate"); continue; }
			const source = sourceOf(store, nodes, row.l, row.i)!;
			// Memory.build stores shorter sources verbatim; those are not compressor tasks.
			if (utf8Bytes(source.source) <= NODE_BYTES) { reject("productionVerbatimMerge"); continue; }
			if (utf8Bytes(source.input) > PAGE_BYTES) { reject("multiPageInput"); continue; }
			const inputSha256 = sha256(source.input);
			if (excluded.has(inputSha256)) { reject("priorInput"); continue; }
			const sourceSha256 = sha256(source.source);
			if (excludedSources.has(sourceSha256)) { reject("priorOriginalSource"); continue; }
			candidates.push({ store, storeId, row: rowIndex, l: row.l, i: row.i, start, end, endDate, time,
				input: source.input, inputSha256, sourceSha256, children: [left, right], childRows });
		}
	}
	candidates.sort(chronological);
	const seen = new Set<string>();
	return { candidates: candidates.filter((candidate) => {
		if (seen.has(candidate.inputSha256)) { reject("duplicateInput"); return false; }
		seen.add(candidate.inputSha256);
		return true;
	}), counts };
}

/** Stream executable hashes: the installed compiled host can be much larger than its capture artifact. */
async function executableHash(path: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return hash.digest("hex");
}

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

async function captureHost(options: { run: string; omp?: string; mainModel: string }, snapshot: PreparedSnapshot, dir: string): Promise<{ host: HostPrefix; capture: object }> {
	// capture-extension redirects ONLY this provider. Never allow an unredirected model or inherited auth.
	if (!/^anthropic\/[^\s/]+$/.test(options.mainModel)) throw new Error("isolated host capture supports only anthropic/<model>");
	const requestedOmp = options.omp ?? join(process.env.HOME ?? "", ".bun/bin/omp");
	const omp = isAbsolute(requestedOmp) || requestedOmp.includes("/") ? resolve(requestedOmp) : Bun.which(requestedOmp);
	if (!omp || !existsSync(omp)) throw new Error("installed omp executable is unavailable");
	const ompExecutable = realpathSync(omp);
	const captureRuntime = realpathSync(process.execPath);
	const ompExecutableSha256 = await executableHash(ompExecutable);
	const captureRuntimeSha256 = await executableHash(captureRuntime);
	const out = join(dir, "host-prefix.json");
	if (existsSync(out)) throw new Error("host-prefix.json already exists; fresh preparation requires a new run directory");
	const scratch = mkdtempSync(join(dir, "capture-"));
	const homes = { HOME: join(scratch, "home"), PI_CODING_AGENT_DIR: join(scratch, "agent"),
		XDG_CONFIG_HOME: join(scratch, "config"), XDG_CACHE_HOME: join(scratch, "cache"),
		XDG_DATA_HOME: join(scratch, "data"), XDG_STATE_HOME: join(scratch, "state"), TMPDIR: join(scratch, "tmp") };
	for (const path of Object.values(homes)) mkdirSync(path, { recursive: true, mode: 0o700 });
	const workspace = join(scratch, "workspace");
	mkdirSync(workspace, { mode: 0o700 });
	const launcher = join(scratch, "omp-isolated");
	// capture.ts sets cwd=ROOT. Move the host before startup so project dotenv, MCP and tools cannot load there.
	// Only the two explicit extension FILES load; directories would enable package discovery.
	const launcherText = `#!/bin/sh\ncd ${shellQuote(workspace)} || exit 1\nexec ${shellQuote(ompExecutable)} --no-extensions -e ${shellQuote(join(snapshot.dir, "src/index.ts"))} "$@"\n`;
	writeFileSync(launcher, launcherText, { mode: 0o700, flag: "wx" });
	const sourceFiles = ["evals/compressor/capture.ts", "evals/compressor/capture-extension.ts", "evals/compressor/lib.ts"];
	const sources = sourceFiles.map((path) => ({ path, sha256: bytesHash(readFileSync(join(ROOT, path))) }));
	const captureSourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
	const args = ["--no-env-file", join(ROOT, "evals/compressor/capture.ts"), "--run", options.run, "--omp", launcher, "--model", options.mainModel];
	const env: NodeJS.ProcessEnv = { ...homes, PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8",
		ANTHROPIC_API_KEY: "optchat-loopback-capture-not-a-provider-key", NO_COLOR: "1", TERM: "dumb" };
	// A git boundary stops ancestor project discovery; an empty subdirectory alone does not.
	execFileSync("git", ["init", "--quiet", "--template=", workspace], { cwd: scratch, env, timeout: 10_000 });
	const startedAt = new Date().toISOString();
	const { stdout, stderr } = await promisify(execFile)(captureRuntime, args, {
		cwd: workspace, env, timeout: 150_000, maxBuffer: 1024 * 1024, encoding: "utf8",
	});
	privateWrite(join(scratch, "driver-output.json"), { stdout, stderr });
	for (const source of sources) {
		if (bytesHash(readFileSync(join(ROOT, source.path))) !== source.sha256) throw new Error("capture source changed during preparation");
	}
	if (await executableHash(ompExecutable) !== ompExecutableSha256 || await executableHash(captureRuntime) !== captureRuntimeSha256) {
		throw new Error("capture executable bytes changed during preparation");
	}
	if (!existsSync(out) || lstatSync(out).isSymbolicLink()) throw new Error("fresh host capture produced no regular artifact");
	const bytes = readFileSync(out);
	const parsed: unknown = JSON.parse(bytes.toString("utf8"));
	if (!object(parsed) || parsed.model !== options.mainModel || !Array.isArray(parsed.systemPrompt) ||
		parsed.systemPrompt.length === 0 || !parsed.systemPrompt.every((block) => typeof block === "string") ||
		!("system" in parsed) || !Array.isArray(parsed.tools) || parsed.tools.length === 0) {
		throw new Error("fresh host capture has an invalid model, system prefix, or tools");
	}
	const host: HostPrefix = { model: parsed.model, systemPrompt: parsed.systemPrompt, system: parsed.system, tools: parsed.tools };
	const capture = {
		command: [captureRuntime, ...args], cwd: workspace, startedAt, completedAt: new Date().toISOString(),
		sourceCommit: captureSourceCommit, sourceCommitMeaning: "checkout HEAD, not a claim that working files equal HEAD",
		sources, sourceSha256: digest(sources), snapshotRevision: snapshot.sha,
		sourceBasis: snapshot.sourceBasis, parentCommit: snapshot.parentCommit, snapshotSourceDigest: snapshot.sourceDigest,
		launcher: relative(dir, launcher), launcherSha256: sha256(launcherText), omp: ompExecutable,
		ompExecutableSha256, captureRuntime, captureRuntimeSha256,
		artifact: "host-prefix.json", artifactSha256: bytesHash(bytes),
		prefixSha256: digest([host.systemPrompt, host.system, host.tools]),
		isolation: { ...homes, workspace, inheritedEnvironment: ["PATH"], automaticExtensions: false,
			credentials: "dummy Anthropic key only", provider: "anthropic redirected to a fresh 127.0.0.1 endpoint by capture-extension.ts",
			limitation: "isolated API-key host prefix, not live OAuth/project context; no inherited user extensions, auth, settings, or live stores; not a network sandbox" },
	};
	privateWrite(join(dir, "capture-provenance.json"), capture);
	return { host, capture };
}

/**
 * Freeze twelve real two-child merge requests (four per within-transcript position third).
 * All source reads happen here. Replays must use task.store/task.nodes, never loadStore.
 * Missing prior evidence, insufficient strata, or a failed fresh capture abort preparation.
 */
export async function prepareInputs(options: {
	run: string;
	rev: string;
	seed: number;
	exclude: string[];
	omp?: string;
	mainModel: string;
}): Promise<PreparedInputs> {
	if (!Number.isSafeInteger(options.seed)) throw new Error("seed must be a safe integer");
	existingRun(options.run);
	if (options.exclude.includes(options.run)) throw new Error("a run cannot exclude itself");
	const dir = runDir(options.run);
	for (const file of ["manifest.json", "frozen.json", "tasks.jsonl", "eligibility.json", "host-prefix.json", "source-provenance.json", "capture-provenance.json"]) {
		if (existsSync(join(dir, file))) throw new Error("preparation artifacts already exist; choose a new run name");
	}
	if (readdirSync(dir).some((name) => name.startsWith("snapshot-"))) throw new Error("a source snapshot already exists; choose a new run name rather than reusing potentially stale bytes");
	const excluded = priorExclusions(options.exclude);
	const snapshot = await loadPreparedSnapshot(options.run, options.rev);
	const stores = storeDirectories().map(loadStore);
	if (stores.length === 0) throw new Error("no source stores are available; merge inputs cannot be fabricated");
	for (const store of stores) {
		if (store.messages.some((message) => typeof message.text !== "string" || typeof message.kind !== "string" ||
			typeof message.date !== "string" || !Number.isFinite(Date.parse(message.date)))) {
			throw new Error("a source store has malformed message-prefix records");
		}
	}
	const { candidates, counts } = eligible(stores, excluded.hashes, excluded.sourceHashes);
	const thirds: Third[] = ["early", "middle", "late"];
	const ranked = candidates.map((candidate, rank) => {
		const n = candidate.store.messages.length;
		const third: Third = 3 * candidate.end <= n ? "early" : 3 * candidate.end <= 2 * n ? "middle" : "late";
		return { candidate, rank, third };
	});
	const chosen = thirds.flatMap((third) => {
		const pool = ranked.filter((entry) => entry.third === third);
		if (pool.length < 4) throw new Error(`insufficient ${third} merge inputs (${pool.length}); strata and exclusions are not relaxed`);
		return shuffled(pool, keyedPrng(options.seed, `merge-sample:${third}`)).slice(0, 4);
	}).sort((a, b) => chronological(a.candidate, b.candidate));
	const tasks: FrozenMergeTask[] = [];
	for (const { candidate, rank, third } of chosen) {
		const { store, l, i, start, end, row } = candidate;
		const frozenStore: LoadedStore = { directory: store.directory, messages: store.messages.slice(0, end), rows: store.rows.slice(0, row) };
		const nodes = nodesBefore(frozenStore, row);
		const source = sourceOf(frozenStore, nodes, l, i);
		if (!source || source.input !== candidate.input) throw new Error("selected source cannot be reconstructed from its frozen prefix");
		let captured: { context: string; instruction: string } | undefined;
		const sentinel = new Error("private merge preparation capture sentinel");
		try {
			await compactNode(snapshot, frozenStore, nodes, { l, i, start, end }, async (request) => {
				if (captured) throw new Error("request capture unexpectedly retried");
				if (request.feedback.length !== 0 || !request.instruction.endsWith(`<input>\n${candidate.input}\n</input>`)) {
					throw new Error("snapshot did not produce the complete first-pass merge input");
				}
				captured = { context: request.context, instruction: request.instruction };
				throw sentinel;
			}, new AbortController().signal);
		} catch (error) {
			if (error !== sentinel) throw error;
		}
		if (!captured) throw new Error("selected merge did not produce a first request");
		const frozenNodes = [...nodes.entries()];
		tasks.push({
			id: `merge-${candidate.inputSha256}`, l, i, start, end, user: coversUser(frozenStore, start, end - 1), third,
			input: candidate.input, inputSha256: candidate.inputSha256, ...captured, stored: store.rows[row]!.text,
			store: frozenStore, nodes: frozenNodes, children: candidate.children,
			provenance: { sourceRevision: snapshot.sha, storeId: candidate.storeId, row, node: nodeKey(l, i),
				children: candidate.children.map((child, at) => ({ node: nodeKey(child.l, child.i), row: candidate.childRows[at]!, textSha256: sha256(child.text) })),
				sourceSha256: candidate.sourceSha256, messagePrefixSha256: digest(frozenStore.messages), nodesSha256: digest(frozenNodes),
				endDate: candidate.endDate, transcriptLength: store.messages.length, coveredEnd: end,
				chronologicalRank: rank, eligibleCount: candidates.length },
		});
	}
	const { host, capture } = await captureHost(options, snapshot, dir);
	const exclusions = { ...excluded.report, rejected: counts, stores: stores.length, eligible: candidates.length,
		eligibility: "two nonempty valid historical children and stored merge, no stand-ins; unflattened source exceeds Memory.build's node budget so production actually invokes the compressor; input fits one Memory page; no additional child-length floor",
		sourceBytesExclusiveMinimum: NODE_BYTES, maxInputBytes: PAGE_BYTES,
		deduplication: "exact flattened two-child input SHA-256; earliest occurrence wins",
		stratification: "per-transcript frozen record count N and covered exclusive end E: early iff 3E<=N; middle iff N<3E<=2N; late iff 2N<3E<=3N",
		ordering: "ascending last source-message timestamp, then store-path SHA-256, level, index, tree-row; seeded shuffle independently within each bucket; final chronological sort",
		perThird: Object.fromEntries(thirds.map((third) => [third, ranked.filter((entry) => entry.third === third).length])),
		selectedPerThird: 4, seed: options.seed,
	};
	privateWrite(join(dir, "eligibility.json"), { ...exclusions, candidates: ranked.map(({ candidate, rank, third }) => ({
		storeId: candidate.storeId, node: nodeKey(candidate.l, candidate.i), row: candidate.row,
		endDate: candidate.endDate, inputSha256: candidate.inputSha256, sourceSha256: candidate.sourceSha256,
		transcriptLength: candidate.store.messages.length, coveredEnd: candidate.end,
		rank, third, selected: tasks.some((task) => task.inputSha256 === candidate.inputSha256),
	})) });
	return { snapshot, tasks, host, capture, exclusions };
}

const FROZEN_INPUT_FILES = ["merge-inputs.json", "host-prefix.json", "source-provenance.json", "capture-provenance.json", "eligibility.json"] as const;
const MERGE_MEMORY_EXPORT = "\nexport { MARK_TEXT as __mergeMarkerText };\n";
const MERGE_INDEX_EXPORT = "\nexport { OptChat as __mergeOptChat };\n";
const FROZEN_DESIGN_FIELDS = ["capUsd", "suffix", "treatmentPolicy", "finalOutputPolicy", "stratification", "rubric", "scorer", "repetitions", "compressorOutputPolicy"] as const;
const ORIGINAL_CHAT_OUTPUT_SUFFIX = '\nReturn ONLY JSON with exactly these keys: {"A":0|0.5|1,"B":0|0.5|1}. No prose or extra keys.';

/** All paths are relative to a trusted root; never follow a symlink in an artifact path. */
function frozenPath(root: string, path: string, directory = false): string {
	const parts = path.split("/");
	if (!path || isAbsolute(path) || parts.some((part) => !part || part === "." || part === ".." || part.includes("\\"))) {
		throw new Error("frozen input path must be a contained relative path");
	}
	let current = root;
	for (const [index, part] of parts.entries()) {
		current = join(current, part);
		const stat = lstatSync(current);
		if (stat.isSymbolicLink() || (index < parts.length - 1 || directory ? !stat.isDirectory() : !stat.isFile())) {
			throw new Error("frozen input path contains a symlink or an unexpected file type");
		}
	}
	if (relative(realpathSync(root), realpathSync(current)) !== path) throw new Error("frozen input path escaped its root");
	return current;
}

function frozenHashes(value: unknown): value is Record<string, string> {
	return object(value) && Object.keys(value).length > 0 && Object.values(value).every((hash) => typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash));
}

function sameFrozenValue(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

/** Fail closed on unknown run outputs, including empty result/ledger files left by an attempted paid run. */
function assertUnpaidOrigin(dir: string, snapshotDirectory: string): void {
	const allowed = new Set<string>([...FROZEN_INPUT_FILES, "merge-manifest.json", "merge-manifest-sha.json", snapshotDirectory]);
	for (const name of readdirSync(dir)) {
		if (allowed.has(name)) continue;
		if (/^merge-check-\d+\.json$/.test(name)) { frozenPath(dir, name); continue; }
		// Captured launchers and isolated homes are historical evidence, not inputs to a new capture.
		if (/^capture-[A-Za-z0-9]+$/.test(name)) { frozenPath(dir, name, true); continue; }
		throw new Error("source run contains paid, failed, or unrecognized artifacts; only an unpaid preparation can be cloned");
	}
}

/**
 * Clone a blocked unpaid working-tree preparation, never sampling stores or capturing another host.
 * Original provenance (including historical private paths) is copied verbatim, not rebound to this run.
 * Only Snapshot.dir denotes the new local runtime path. The caller freezes new code/model identities,
 * preserves originManifest.prefix, binds source-reuse-provenance.json and originManifestSha256, and
 * must not append export hooks or rewrite inputs. No original manifest/check/billing/report is copied.
 */
export async function prepareInputsFromRun(options: {
	run: string;
	fromRun: string;
	seed: number;
	mainModel: string;
	expectedDesign: Record<string, unknown>;
	expectedSchedule: (tasks: FrozenMergeTask[]) => unknown;
}): Promise<ReusedPreparedInputs> {
	if (options.run === options.fromRun || options.seed !== 20261023) throw new Error("clone requires a distinct run and the preregistered seed");
	// Reject redirected eval/run ancestors as well as redirected individual files.
	frozenPath(ROOT, "evals/compressor/runs", true);
	const origin = existingRun(options.fromRun);
	const destination = existingRun(options.run);
	const originStat = lstatSync(origin);
	if (!originStat.isDirectory() || (originStat.mode & 0o077) !== 0 || (process.getuid && originStat.uid !== process.getuid())) {
		throw new Error("source run must be an owner-only directory");
	}
	if (existsSync(destination)) {
		const stat = lstatSync(destination);
		if ((stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid()) || readdirSync(destination).length !== 0) {
			throw new Error("clone destination must be a fresh owner-only run");
		}
	}
	const manifestPath = frozenPath(origin, "merge-manifest.json");
	const manifestBytes = readFileSync(manifestPath);
	const originManifestSha256 = bytesHash(manifestBytes);
	const hashFile: unknown = JSON.parse(readFileSync(frozenPath(origin, "merge-manifest-sha.json"), "utf8"));
	const manifest: unknown = JSON.parse(manifestBytes.toString("utf8"));
	if (!object(hashFile) || hashFile.sha256 !== originManifestSha256 || !object(manifest) || manifest.version !== 1 ||
		manifest.run !== options.fromRun || manifest.seed !== options.seed || manifest.capUsd !== 4.5 ||
		typeof manifest.sourceRev !== "string" || !/^[a-f0-9]{64}$/.test(manifest.sourceRev) ||
		manifest.snapshotDirectory !== `snapshot-${manifest.sourceRev}` || !frozenHashes(manifest.artifacts) || !frozenHashes(manifest.sourceHashes) ||
		(manifest.cacheReturnShape !== "payload" && manifest.cacheReturnShape !== "outcome")) {
		throw new Error("original manifest or SHA file does not describe a valid frozen working-tree run");
	}
	const snapshotDirectory = `snapshot-${manifest.sourceRev}`;
	assertUnpaidOrigin(origin, snapshotDirectory);
	if (!sameFrozenValue(Object.keys(manifest.artifacts).sort(), [...FROZEN_INPUT_FILES].sort())) throw new Error("original artifact inventory differs from the frozen preparation contract");
	for (const field of FROZEN_DESIGN_FIELDS) {
		if (!Object.hasOwn(options.expectedDesign, field)) throw new Error(`missing expected treatment design field: ${field}`);
	}
	for (const [field, expected] of Object.entries(options.expectedDesign)) {
		let original = manifest[field];
		if (field === "rubric") {
			if (typeof original !== "string" || !original.endsWith(ORIGINAL_CHAT_OUTPUT_SUFFIX)) throw new Error("original rubric lacks the exact chat-output instruction");
			// Native Decisions changes the output transport, not a single byte of the meaning-preservation rubric.
			original = original.slice(0, -ORIGINAL_CHAT_OUTPUT_SUFFIX.length);
		}
		if (!Object.hasOwn(manifest, field) || !sameFrozenValue(original, expected)) throw new Error(`original treatment design differs: ${field}`);
	}
	if (manifest.repetitions !== 2 || manifest.judgeMaxTokens !== 400 ||
		!sameFrozenValue(manifest.schema, { type: "object", additionalProperties: false, required: ["A", "B"], properties: { A: { enum: [0, 0.5, 1] }, B: { enum: [0, 0.5, 1] } } }) ||
		!object(manifest.selectors) || manifest.selectors.main !== options.mainModel) {
		throw new Error("original repetition, judge-output, or captured main-model design differs");
	}
	const artifacts = manifest.artifacts;
	const readArtifact = (file: typeof FROZEN_INPUT_FILES[number]): unknown => {
		const bytes = readFileSync(frozenPath(origin, file));
		if (bytesHash(bytes) !== artifacts[file]) throw new Error("original frozen artifact hash mismatch");
		return JSON.parse(bytes.toString("utf8"));
	};
	const sourceRoot = frozenPath(origin, `${snapshotDirectory}/src`, true);
	const inventory = sourceInventory(sourceRoot);
	const sourceHashes = Object.fromEntries(inventory.map((file) => [file.path, file.sha256]));
	if (!sameFrozenValue(sourceHashes, manifest.sourceHashes)) throw new Error("original source snapshot hashes differ");
	const provenance = readArtifact("source-provenance.json");
	if (!object(provenance) || provenance.sourceBasis !== "working-tree" || provenance.sourceRevision !== manifest.sourceRev ||
		provenance.sourceDigest !== manifest.originalSourceDigest || provenance.sourceDigest !== manifest.sourceRev ||
		provenance.parentCommit !== manifest.parentCommit || provenance.evalOnlyExport !== REPLY_HEAD_EXPORT) {
		throw new Error("original source provenance differs from manifest");
	}
	// Prove that the only bytes added to the content-addressed source are the known eval exports.
	const originalInventory = inventory.map((file) => {
		if (file.path !== "memory.ts" && file.path !== "index.ts") return file;
		const bytes = readFileSync(frozenPath(sourceRoot, file.path));
		const suffix = Buffer.from(file.path === "memory.ts" ? REPLY_HEAD_EXPORT + MERGE_MEMORY_EXPORT : MERGE_INDEX_EXPORT);
		if (!bytes.subarray(-suffix.length).equals(suffix)) throw new Error("frozen source lacks the exact existing merge export hooks");
		return { path: file.path, sha256: bytesHash(bytes.subarray(0, bytes.length - suffix.length)) };
	});
	if (!sameFrozenValue(originalInventory, provenance.files) || digest(originalInventory) !== manifest.sourceRev) {
		throw new Error("source inventory does not reproduce its original content identity");
	}
	const tasks = readArtifact("merge-inputs.json") as FrozenMergeTask[];
	if (!Array.isArray(tasks) || tasks.length !== 12 || new Set(tasks.map((task) => task.id)).size !== 12 ||
		!sameFrozenValue(tasks.map((task) => task.id), manifest.taskIds)) throw new Error("original twelve task ids differ");
	for (const task of tasks) {
		if (typeof task.input !== "string" || task.inputSha256 !== sha256(task.input) || task.id !== `merge-${task.inputSha256}` ||
			!Number.isInteger(task.l) || task.l < 1 || task.l > 52 || !Number.isSafeInteger(task.i) || task.i < 0 ||
			task.start !== task.i * 2 ** task.l || task.end !== (task.i + 1) * 2 ** task.l || !Number.isSafeInteger(task.end) ||
			!object(task.provenance) || task.provenance.sourceRevision !== manifest.sourceRev || task.provenance.coveredEnd !== task.end ||
			!Number.isSafeInteger(task.provenance.transcriptLength) || task.provenance.transcriptLength < task.end ||
			!object(task.store) || !Array.isArray(task.store.messages) || task.store.messages.length !== task.end ||
			!Array.isArray(task.nodes) || !Array.isArray(task.children) || task.children.length !== 2 ||
			digest(task.store.messages) !== task.provenance.messagePrefixSha256 || digest(task.nodes) !== task.provenance.nodesSha256 ||
			typeof task.context !== "string" || typeof task.instruction !== "string" ||
			!task.instruction.endsWith(`<input>\n${task.input}\n</input>`)) throw new Error("original task content/provenance differs");
		const third = 3 * task.end <= task.provenance.transcriptLength ? "early" : 3 * task.end <= 2 * task.provenance.transcriptLength ? "middle" : "late";
		const nodes = new Map(task.nodes);
		const source = sourceOf(task.store, nodes, task.l, task.i);
		if (task.third !== third || source?.input !== task.input || sha256(source.source) !== task.provenance.sourceSha256 ||
			!sameFrozenValue(task.children, [nodes.get(nodeKey(task.l - 1, task.i * 2)), nodes.get(nodeKey(task.l - 1, task.i * 2 + 1))])) {
			throw new Error("original task source or transcript stratum differs");
		}
	}
	if (["early", "middle", "late"].some((third) => tasks.filter((task) => task.third === third).length !== 4) ||
		!sameFrozenValue(options.expectedSchedule(tasks), manifest.schedule)) throw new Error("original balanced schedule differs");
	const captured = readArtifact("host-prefix.json");
	if (!object(captured) || captured.model !== options.mainModel || !Array.isArray(captured.systemPrompt) || captured.systemPrompt.length === 0 ||
		!captured.systemPrompt.every((block) => typeof block === "string") || !Array.isArray(captured.tools) || !("system" in captured)) {
		throw new Error("original host prefix is malformed");
	}
	const host: HostPrefix = { model: options.mainModel, systemPrompt: captured.systemPrompt, system: captured.system, tools: captured.tools };
	const capture = readArtifact("capture-provenance.json");
	const eligibility = readArtifact("eligibility.json");
	if (!object(capture) || !sameFrozenValue(capture, manifest.capture) || capture.snapshotRevision !== manifest.sourceRev ||
		capture.artifactSha256 !== manifest.artifacts["host-prefix.json"] || capture.prefixSha256 !== digest([host.systemPrompt, host.system, host.tools]) ||
		!object(manifest.exclusions) || !object(eligibility) || eligibility.seed !== options.seed || eligibility.selectedPerThird !== 4 ||
		!Object.entries(manifest.exclusions).every(([key, value]) => sameFrozenValue(eligibility[key], value)) ||
		!object(manifest.prefix) || !Array.isArray(manifest.prefix.systemPrompt) || !manifest.prefix.systemPrompt.every((block) => typeof block === "string") ||
		(manifest.prefix.tools !== undefined && !Array.isArray(manifest.prefix.tools)) || typeof manifest.prefix.policy !== "string" ||
		typeof manifest.prefix.capturedHash !== "string" || typeof manifest.prefix.systemHash !== "string" || typeof manifest.prefix.toolsHash !== "string" ||
		manifest.prefix.capturedHash !== digest(host) || manifest.prefix.systemHash !== digest(manifest.prefix.systemPrompt) ||
		manifest.prefix.toolsHash !== digest(manifest.prefix.tools ?? null) || typeof manifest.sourceBasis !== "string" ||
		typeof manifest.requestedRev !== "string" || !object(manifest.models) ||
		!object(manifest.models.main) || !object(manifest.models.compressor) || !object(manifest.models.judge)) {
		throw new Error("original host prefix or capture/eligibility provenance differs");
	}
	// Copy only the frozen input allowlist. Never inherit manifests, checks, billing, or reports.
	if (!existsSync(destination)) mkdirSync(destination, { mode: 0o700 });
	const copiedRoot = join(destination, snapshotDirectory, "src");
	const copied = sourceInventory(sourceRoot, copiedRoot);
	if (!sameFrozenValue(copied, inventory) || !sameFrozenValue(sourceInventory(copiedRoot), inventory)) throw new Error("copied source bytes differ");
	for (const file of FROZEN_INPUT_FILES) {
		const target = join(destination, file);
		copyFileSync(frozenPath(origin, file), target, constants.COPYFILE_EXCL);
		chmodSync(target, 0o400);
		if (bytesHash(readFileSync(frozenPath(destination, file))) !== manifest.artifacts[file]) throw new Error("copied artifact hash mismatch");
	}
	for (const file of inventory) chmodSync(frozenPath(copiedRoot, file.path), 0o400);
	// Detect source mutation during copy without rewriting the original or accepting a paid-run race.
	assertUnpaidOrigin(origin, snapshotDirectory);
	if (bytesHash(readFileSync(manifestPath)) !== originManifestSha256 || !sameFrozenValue(sourceInventory(sourceRoot), inventory)) {
		throw new Error("original immutable preparation changed during cloning");
	}
	privateWrite(join(destination, "source-reuse-provenance.json"), {
		version: 1, fromRun: options.fromRun, originManifestSha256, originalArtifacts: artifacts,
		sourceRevision: manifest.sourceRev, snapshotDirectory, sourceHashes,
		cacheContract: { returnShape: manifest.cacheReturnShape, sourceHashesSha256: digest(sourceHashes), originManifestSha256,
			meaning: "Explicit cacheReturnShape recorded in the original hash-verified manifest; adapter declaration only, never payload-shape inference or source rewriting." },
		pathPolicy: "Original task/store and capture provenance paths are historical evidence, copied verbatim and never used for replay reads. Runtime source paths resolve relative to this new run; source-provenance files remain relative to snapshot src.",
		hooksAlreadyPresent: true, capturePolicy: "Reused exact original host-prefix bytes; no new capture or source sampling.",
	});
	chmodSync(join(destination, "source-reuse-provenance.json"), 0o400);
	const snapshot = await loadPreparedSnapshot(options.run, manifest.sourceRev);
	if (snapshot.dir !== join(destination, snapshotDirectory) || snapshot.sourceDigest !== manifest.originalSourceDigest ||
		snapshot.parentCommit !== manifest.parentCommit || snapshot.cacheReturnShape !== manifest.cacheReturnShape) {
		throw new Error("copied source snapshot cannot reproduce its frozen metadata");
	}
	const originManifest: FrozenMergeOrigin = {
		prefix: { systemPrompt: manifest.prefix.systemPrompt, ...(manifest.prefix.tools === undefined ? {} : { tools: manifest.prefix.tools }),
			systemHash: manifest.prefix.systemHash, toolsHash: manifest.prefix.toolsHash, capturedHash: manifest.prefix.capturedHash, policy: manifest.prefix.policy },
		sourceBasis: manifest.sourceBasis, requestedRev: manifest.requestedRev, capture, exclusions: manifest.exclusions,
		models: { main: manifest.models.main, compressor: manifest.models.compressor, judge: manifest.models.judge },
	};
	return { snapshot, tasks, host, capture, exclusions: manifest.exclusions, originManifestSha256, hooksAlreadyPresent: true, originManifest };
}
