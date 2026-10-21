/**
 * The store lease on the real code, with real processes: kernel facts the TLA+ model assumes, the model's
 * guarantees replayed as races and kills, the findings still open (none now), and copies of src/store.ts
 * with a deliberate break that the guarantee checks must catch.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, renameSync, symlinkSync } from "node:fs";
import { appendFile, cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "../../src/store.ts";
import { judge, type Check, type Role } from "./check.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const CHILD = join(HERE, "child.ts");
const CONFLICT = "Store is already open by another writer";
const RACE_PROCESSES = 6;
const RACE_ROUNDS = 20;

interface Reply {
	event: string;
	ok?: boolean;
	name?: string;
	message?: string;
	directory?: string;
	messages?: number;
	i?: number;
	pid?: number;
	/** `archive`: where the store went, what another process's Store.open got at the rename, and the descriptors left into the archive. */
	archive?: string;
	during?: string;
	leaked?: number;
	/** `closed-sidecar`: the path a closed store gave out. */
	path?: string;
}

/** One child process (child.ts): a command in, one result line out. */
class Session {
	private readonly proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
	private readonly queue: Reply[] = [];
	private readonly waiters: Array<(reply: Reply) => void> = [];
	private ended = false;
	stderr = "";
	pid = 0;

	private constructor(src: string | undefined) {
		this.proc = Bun.spawn([process.execPath, CHILD], {
			cwd: ROOT,
			env: src ? { ...process.env, OPTCHAT_SRC: src } : process.env,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		void this.pump();
		void this.drainStderr();
	}

	static async start(src?: string): Promise<Session> {
		const session = new Session(src);
		const ready = await session.recv();
		if (ready.event !== "ready") throw new Error(`child did not start: ${session.stderr || JSON.stringify(ready)}`);
		session.pid = ready.pid ?? 0;
		return session;
	}

	private async pump(): Promise<void> {
		const decoder = new TextDecoder();
		let buffer = "";
		for await (const chunk of this.proc.stdout) {
			buffer += decoder.decode(chunk, { stream: true });
			for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				if (line) this.deliver(JSON.parse(line) as Reply);
			}
		}
		this.ended = true;
		for (const waiter of this.waiters.splice(0)) waiter({ event: "exit" });
	}

	private async drainStderr(): Promise<void> {
		const decoder = new TextDecoder();
		for await (const chunk of this.proc.stderr) this.stderr += decoder.decode(chunk, { stream: true });
	}

	private deliver(reply: Reply): void {
		const waiter = this.waiters.shift();
		if (waiter) waiter(reply);
		else this.queue.push(reply);
	}

	recv(): Promise<Reply> {
		const queued = this.queue.shift();
		if (queued) return Promise.resolve(queued);
		if (this.ended) return Promise.resolve({ event: "exit" });
		const { promise, resolve: wake } = Promise.withResolvers<Reply>();
		this.waiters.push(wake);
		return promise;
	}

	send(command: Record<string, unknown>): void {
		this.proc.stdin.write(`${JSON.stringify(command)}\n`);
		void this.proc.stdin.flush();
	}

	/** The reply to the last command sent. */
	async result(): Promise<Reply> {
		const reply = await this.recv();
		if (reply.event === "result") return reply;
		throw new Error(`child ${this.pid} sent ${reply.event} instead of a result${this.stderr ? `: ${this.stderr.slice(-400)}` : ""}`);
	}

	async call(command: Record<string, unknown>): Promise<Reply> {
		this.send(command);
		return this.result();
	}

	async kill(): Promise<void> {
		this.proc.kill("SIGKILL");
		await this.proc.exited;
	}
}

interface Outcome {
	/** The property broke (guarantee probes) or the harm reproduced (finding probes). */
	readonly violated: boolean;
	readonly detail: string;
}

interface Sandbox {
	readonly base: string;
	/** $OPTCHAT_SRC for the children: undefined for this repository's src/. */
	readonly src: string | undefined;
	readonly sessions: Session[];
	start(): Promise<Session>;
}

const isConflict = (reply: Reply): boolean => reply.ok === false && reply.name === "StoreLeaseConflictError" && reply.message === CONFLICT;

function describe(reply: Reply): string {
	return reply.ok ? "opened" : `${reply.name ?? "?"}: ${reply.message ?? "?"}`;
}

/** Thrown for a fixture that stopped proving what it claims; reported as a failure whatever the role. */
class FixtureError extends Error {}

/** Every file under `dir` as `type path size sha256`, sorted: two equal snapshots mean no byte moved. */
async function snapshot(dir: string): Promise<string[]> {
	const lines: string[] = [];
	const walk = async (current: string): Promise<void> => {
		for (const entry of await readdir(current, { withFileTypes: true })) {
			const path = join(current, entry.name);
			const rel = relative(dir, path);
			if (entry.isDirectory()) {
				lines.push(`dir ${rel}`);
				await walk(path);
			} else {
				const bytes = await readFile(path);
				lines.push(`file ${rel} ${bytes.length} ${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}`);
			}
		}
	};
	await walk(dir);
	return lines.sort();
}

const differences = (before: readonly string[], after: readonly string[]): string[] => [
	...before.filter((line) => !after.includes(line)).map((line) => `- ${line}`),
	...after.filter((line) => !before.includes(line)).map((line) => `+ ${line}`),
];

const message = (i: number): string =>
	`${JSON.stringify({ i, kind: "user", text: `message ${i}`, size: Buffer.byteLength(`user: message ${i}`, "utf8"), date: "2026-01-10T12:00:00.000Z" })}\n`;

interface Probe {
	readonly id: string;
	readonly claim: string;
	run(box: Sandbox): Promise<Outcome>;
}

/**
 * G1 (model: ExclusiveOpen). Six processes race Store.open on one directory, through its own path and
 * through a symlink to it; exactly one wins and the rest fail with StoreLeaseConflictError. Even rounds race
 * the creation of the directory itself.
 */
const raceOneWinner: Probe = {
	id: "race-one-winner",
	claim: `${RACE_PROCESSES} processes racing Store.open on one directory (path and symlink spellings): exactly one opens, the rest get StoreLeaseConflictError`,
	async run(box) {
		const racers = await Promise.all(Array.from({ length: RACE_PROCESSES }, () => box.start()));
		for (let round = 0; round < RACE_ROUNDS; round++) {
			const dir = join(box.base, `race-${round}`);
			const alias = join(box.base, `race-${round}-link`);
			const aliased = round % 2 === 1;
			if (aliased) {
				await mkdir(dir, { mode: 0o700 });
				symlinkSync(dir, alias);
			}
			const go = join(box.base, `race-${round}.go`);
			racers.forEach((racer, k) => racer.send({ cmd: "arm", dir: aliased && k % 2 === 1 ? alias : dir, go }));
			for (const racer of racers) await racer.recv();
			await writeFile(go, "");
			const replies = await Promise.all(racers.map((racer) => racer.result()));
			const opened = replies.filter((reply) => reply.ok).length;
			const conflicts = replies.filter(isConflict).length;
			if (opened !== 1 || conflicts !== RACE_PROCESSES - 1) {
				const seen = replies.map((reply, k) => `p${k}: ${describe(reply)}`).join("; ");
				return { violated: true, detail: `round ${round}: ${opened} of ${RACE_PROCESSES} processes opened ${dir}, ${conflicts} got the conflict error (${seen})` };
			}
			await Promise.all(racers.map((racer) => racer.call({ cmd: "close" })));
			// Released means released: the next process in line opens the directory at once.
			const next = racers[(round + 1) % RACE_PROCESSES];
			const again = await next?.call({ cmd: "open", dir });
			if (!again?.ok) return { violated: true, detail: `round ${round}: after every close, the next open of ${dir} failed: ${again ? describe(again) : "no session"}` };
			await next?.call({ cmd: "close" });
		}
		return {
			violated: false,
			detail: `${RACE_ROUNDS} rounds x ${RACE_PROCESSES} processes: one winner and ${RACE_PROCESSES - 1} "${CONFLICT}" each round, and an open right after close succeeded`,
		};
	},
};

/**
 * G2 (model: Acquire fails before any write). A rejected opener leaves the directory byte-identical: a torn
 * log tail, an orphan view temp file and an unreferenced image blob, all of which a successful open repairs or
 * collects, survive three rejected opens. The control is that the successful open afterwards does change them.
 */
const rejectedOpenerChangesNothing: Probe = {
	id: "rejected-opener-changes-nothing",
	claim: "an opener that gets StoreLeaseConflictError changes nothing in the directory (no torn-tail repair, no garbage collection)",
	async run(box) {
		const dir = join(box.base, "reject");
		const holder = await box.start();
		const opened = await holder.call({ cmd: "open", dir });
		if (!opened.ok) throw new FixtureError(`the holder could not open: ${describe(opened)}`);
		await holder.call({ cmd: "append", text: "alpha" });
		await holder.call({ cmd: "append", text: "beta" });
		const [log] = await readdir(join(dir, "main"));
		if (!log) throw new FixtureError("the holder wrote no log file");
		await appendFile(join(dir, "main", log), '{"i":2,"kind":"user","text":"torn');
		await writeFile(join(dir, `.view-${randomUUID()}.tmp`), "orphan view");
		await writeFile(join(dir, "images", `.image-${randomUUID()}.tmp`), "orphan image");
		await writeFile(join(dir, "images", "a".repeat(64)), "unreferenced blob");
		const before = await snapshot(dir);

		for (let attempt = 0; attempt < 3; attempt++) {
			const contender = await box.start();
			const reply = await contender.call({ cmd: "open", dir });
			if (!isConflict(reply)) {
				return { violated: true, detail: `a second opener of a held directory got ${describe(reply)} instead of the conflict error` };
			}
		}
		const changed = differences(before, await snapshot(dir));
		if (changed.length > 0) return { violated: true, detail: `rejected openers changed the directory: ${changed.join("; ")}` };

		await holder.call({ cmd: "close" });
		const successor = await box.start();
		const reopened = await successor.call({ cmd: "open", dir });
		if (!reopened.ok) throw new FixtureError(`the control open failed: ${describe(reopened)}`);
		const control = differences(before, await snapshot(dir));
		if (control.length < 3) throw new FixtureError(`the control open repaired too little (${control.length} changes): the fixture cannot see a repair`);
		return { violated: false, detail: `3 rejected opens changed 0 files; the successful open after them made ${control.length} changes (torn tail, orphans)` };
	},
};

/** G3 (model: Crash frees the lease). SIGKILL of the holder frees the lease at once; no lock file is left behind. */
const sigkillFreesLease: Probe = {
	id: "sigkill-frees-lease",
	claim: "SIGKILL of the holder frees the lease immediately, with no lock file, pid or timeout to clean up",
	async run(box) {
		const dir = join(box.base, "sigkill");
		const holder = await box.start();
		const opened = await holder.call({ cmd: "open", dir });
		if (!opened.ok) throw new FixtureError(`the holder could not open: ${describe(opened)}`);
		await holder.call({ cmd: "append", text: "durable before SIGKILL" });
		const blocked = await (await box.start()).call({ cmd: "open", dir });
		if (!isConflict(blocked)) throw new FixtureError(`the lease was not held before the kill: ${describe(blocked)}`);
		await holder.kill();
		const successor = await box.start();
		const recovered = await successor.call({ cmd: "open", dir });
		if (!recovered.ok) return { violated: true, detail: `after SIGKILL of the holder the next open failed: ${describe(recovered)}` };
		const extra = (await readdir(dir)).filter((name) => !["main", "tree", "images", "view.json"].includes(name));
		if (extra.length > 0) return { violated: true, detail: `the directory holds files beyond the store's own: ${extra.join(", ")}` };
		if (recovered.messages !== 1) return { violated: true, detail: `the recovered store holds ${recovered.messages} messages, not the 1 written before the kill` };
		return { violated: false, detail: "the next open succeeded straight after SIGKILL, saw the durable message, and found no lock file" };
	},
};

/**
 * G4 (model: OpenFails releases). An open that fails after the lease (a gap in the message ids) fails with its
 * own error, not a conflict, and the lease is gone: a second process, while the first is still alive, gets the
 * same error and not StoreLeaseConflictError.
 */
const failedOpenReleasesLease: Probe = {
	id: "failed-open-releases-lease",
	claim: "an open that fails after acquiring the lease releases it: the next opener reaches the same failure, not a conflict",
	async run(box) {
		const dir = join(box.base, "failed");
		await mkdir(join(dir, "main"), { recursive: true, mode: 0o700 });
		await writeFile(join(dir, "main", "2026-01-01.jsonl"), message(0) + message(2));
		const first = await box.start();
		const one = await first.call({ cmd: "open", dir });
		if (one.ok || isConflict(one)) throw new FixtureError(`the damaged store should fail its open for its own reason: ${describe(one)}`);
		const second = await box.start();
		const two = await second.call({ cmd: "open", dir });
		if (isConflict(two)) return { violated: true, detail: `the first open failed (${describe(one)}) and its process, still alive, kept the lease: the second open got the conflict error` };
		if (two.ok) return { violated: true, detail: "the second open of a damaged store succeeded" };
		return { violated: false, detail: `two processes, one alive after its failed open: both got "${one.message}", neither a conflict` };
	},
};

/** G5 (model: Release, StoreWrite). close() releases the lease and fences the store: a closed store refuses writes, and the directory reopens in another process and in the same one. */
const closeReleasesAndFences: Probe = {
	id: "close-releases-and-fences",
	claim: "after close() the store refuses writes and the lease is free for another process and for a reopen",
	async run(box) {
		const dir = join(box.base, "close");
		const one = await box.start();
		const opened = await one.call({ cmd: "open", dir });
		if (!opened.ok) throw new FixtureError(`the first open failed: ${describe(opened)}`);
		await one.call({ cmd: "append", text: "before close" });
		const closed = await one.call({ cmd: "close" });
		if (!closed.ok) return { violated: true, detail: `close failed: ${describe(closed)}` };
		const late = await one.call({ cmd: "append", text: "after close" });
		if (late.ok) return { violated: true, detail: "a closed store accepted a write" };
		const other = await (await box.start()).call({ cmd: "open", dir });
		if (!other.ok) return { violated: true, detail: `after close the lease was not free for another process: ${describe(other)}` };
		const mine = await one.call({ cmd: "open", dir });
		if (!isConflict(mine)) return { violated: true, detail: `while another process held the store, a reopen gave ${describe(mine)}` };
		return { violated: false, detail: `closed store refused the write ("${late.message}"); another process opened at once; a reopen while it held got the conflict error` };
	},
};

/** The text of every main log under `dir`, in file order. */
function mainLog(dir: string): string {
	const main = join(dir, "main");
	return existsSync(main) ? readdirSync(main).sort().map((name) => readFileSync(join(main, name), "utf8")).join("") : "";
}

const ARCHIVE_TIME = "2026-10-21T12:00:00.000Z";

/**
 * G6 (model: ArchiveHeld, ReleaseArchived; was F1). `/optchat new` archives through Store.archive (index.ts:1643, 1665;
 * store.ts:1113-1153). It keeps its lease through the rename: at the rename itself another process's Store.open of the
 * directory gets the conflict error. Afterwards a fresh store opens at the old path and the archive reopens the old chat.
 */
const archiveHoldsTheLease: Probe = {
	id: "archive-holds-the-lease",
	claim: "Store.archive keeps the lease through the rename, then frees it and every descriptor: a fresh store opens at the path and the archive reopens (F1, fixed)",
	async run(box) {
		const dir = join(box.base, "f1", "chat");
		await mkdir(dirname(dir), { recursive: true });
		const a = await box.start();
		const opened = await a.call({ cmd: "open", dir });
		if (!opened.ok) throw new FixtureError(`A could not open: ${describe(opened)}`);
		await a.call({ cmd: "append", text: "A's chat" });
		const done = await a.call({ cmd: "archive", text: ARCHIVE_TIME });
		if (!done.ok || done.archive === undefined) return { violated: true, detail: `Store.archive failed on an undisturbed store: ${describe(done)}` };
		if (done.during !== "StoreLeaseConflictError") {
			return { violated: true, detail: `at the rename another process's Store.open of the directory got "${done.during}", not the conflict error: the lease was already released` };
		}
		if (done.leaked !== 0) return { violated: true, detail: `after the archive ${done.leaked ?? "?"} descriptors of the archiving process still point into the archive` };
		const fresh = await (await box.start()).call({ cmd: "open", dir });
		if (!fresh.ok || fresh.messages !== 0) return { violated: true, detail: `after the archive a new open at the old path gave ${describe(fresh)} with ${fresh.messages ?? "?"} messages, not an empty store` };
		const old = await (await box.start()).call({ cmd: "open", dir: done.archive });
		if (!old.ok || old.messages !== 1) return { violated: true, detail: `the archive did not reopen with the old chat: ${describe(old)}, ${old.messages ?? "?"} messages` };
		return {
			violated: false,
			detail: `at the rename another process got the conflict error, no descriptor into the archive stayed open; then a fresh store opened at ${relative(box.base, dir)} (0 messages) and ${relative(box.base, done.archive)} reopened with the old message`,
		};
	},
};

/**
 * G7 (model: ArchiveHeld with the dev:ino check; was F1 with a user mv). Session A's directory is moved away and B opens
 * a store at the old path. A's `/optchat new` finds that the path no longer names the inode it leases and renames
 * nothing (store.ts:1128-1137); it still releases its lease, so A's own directory reopens.
 */
const archiveRefusesDisplacedPath: Probe = {
	id: "archive-refuses-a-displaced-path",
	claim: "Store.archive renames nothing when its path no longer names the leased store, and still frees the lease (F1, fixed)",
	async run(box) {
		const dir = join(box.base, "f1b", "chat");
		const moved = join(box.base, "f1b", "moved");
		await mkdir(dirname(dir), { recursive: true });
		const a = await box.start();
		const opened = await a.call({ cmd: "open", dir });
		if (!opened.ok) throw new FixtureError(`A could not open: ${describe(opened)}`);
		await a.call({ cmd: "append", text: "A's chat" });
		renameSync(dir, moved);
		const b = await box.start();
		const second = await b.call({ cmd: "open", dir });
		if (!second.ok) throw new FixtureError(`B could not open at the old path: ${describe(second)}`);
		await b.call({ cmd: "append", text: "B's chat" });
		const done = await a.call({ cmd: "archive", text: ARCHIVE_TIME });
		const siblings = readdirSync(dirname(dir)).sort();
		if (done.ok) return { violated: true, detail: `Store.archive renamed a path that names B's store: archive ${done.archive}, siblings now [${siblings.join(", ")}]` };
		if (siblings.join(",") !== "chat,moved") return { violated: true, detail: `a refused archive left [${siblings.join(", ")}] beside the store, not [chat, moved]` };
		const after = await b.call({ cmd: "append", text: "B after the refusal" });
		const log = mainLog(dir);
		if (!after.ok || !log.includes("B's chat") || !log.includes("B after the refusal")) {
			return { violated: true, detail: `B's directory lost data or its writes after A's refused archive (B's append: ${describe(after)})` };
		}
		const reopened = await (await box.start()).call({ cmd: "open", dir: moved });
		if (!reopened.ok) return { violated: true, detail: `after the refused archive A's process still holds the lease of its own directory: ${describe(reopened)}` };
		return { violated: false, detail: `the refusal ("${done.message}") renamed nothing, B kept writing at the old path, and A's moved directory reopened with ${reopened.messages} message` };
	},
};

/**
 * G8 (model: SidecarWrite; was F2). The rules ledger and the metrics sink resolve their file through
 * store.sidecarPath on every write (system1/ledger.ts:143-147, index.ts:677, 892-896, 2079), so after the directory
 * is moved, B's writes land in the directory B holds the lease of, not in whatever store is at the old path.
 */
const sidecarWritesFollowTheInode: Probe = {
	id: "sidecar-writes-follow-the-inode",
	claim: "rules-ledger and metrics writes land in the directory their writer holds the lease of (F2, fixed)",
	async run(box) {
		const dir = join(box.base, "f2", "chat");
		const moved = join(box.base, "f2", "moved");
		await mkdir(dirname(dir), { recursive: true });
		const b = await box.start();
		const opened = await b.call({ cmd: "open", dir });
		if (!opened.ok) throw new FixtureError(`B could not open: ${describe(opened)}`);
		await b.call({ cmd: "ledger" });
		// A user `mv` (store.ts:749-752 promises the store follows it).
		renameSync(dir, moved);
		const c = await Store.open(dir);
		try {
			const rule = await b.call({ cmd: "rule", text: "B's rule" });
			const metric = await b.call({ cmd: "metric" });
			const store = await b.call({ cmd: "append", text: "B's message" });
			const landed: string[] = [];
			if (existsSync(join(dir, "ledger.jsonl"))) landed.push("ledger.jsonl");
			if (existsSync(join(dir, "metrics.jsonl"))) landed.push("metrics.jsonl");
			const followed = ["ledger.jsonl", "metrics.jsonl"].filter((name) => existsSync(join(moved, name)));
			const where =
				`B holds the lease of the moved directory; C holds a fresh store at the old path. B's store write (${store.ok ? "ok" : describe(store)}), ` +
				`ledger write (${rule.ok ? "ok" : describe(rule)}) and metrics write (${metric.ok ? "ok" : describe(metric)}): ` +
				`C's directory has [${landed.join(", ") || "neither"}], the moved directory has [${followed.join(", ") || "neither"}]`;
			return { violated: landed.length > 0 || followed.length < 2, detail: where };
		} finally {
			await c.close();
		}
	},
};

/**
 * G9 (model: SidecarWrite needs an open store). A closed store gives out no sidecar path: its descriptor number may
 * belong to another store by now, and a path built from it would write into that one (store.ts:1098-1104, 818-826).
 */
const closedStoreHasNoSidecar: Probe = {
	id: "closed-store-has-no-sidecar",
	claim: "a closed store refuses to give out a sidecar path, even when another store in its process holds its old descriptor number",
	async run(box) {
		const base = join(box.base, "closed");
		await mkdir(base, { recursive: true });
		const child = await box.start();
		const reply = await child.call({ cmd: "closed-sidecar", dir: base });
		if (reply.ok) return { violated: true, detail: `a closed store gave out ${reply.path}, while another store of the process, ${reply.directory}, was open` };
		return { violated: false, detail: `a closed store refused its sidecar path: "${reply.message}"` };
	},
};

const GUARANTEES: readonly Probe[] = [
	raceOneWinner,
	rejectedOpenerChangesNothing,
	sigkillFreesLease,
	failedOpenReleasesLease,
	closeReleasesAndFences,
	archiveHoldsTheLease,
	archiveRefusesDisplacedPath,
	sidecarWritesFollowTheInode,
	closedStoreHasNoSidecar,
];

/** Findings still open: none. A probe the code violates goes here until it is fixed (skill: Update procedure). */
const FINDINGS: readonly Probe[] = [];

async function sandbox(src: string | undefined): Promise<Sandbox & { dispose(): Promise<void> }> {
	const base = await mkdtemp(join(tmpdir(), "verify-store-lease-"));
	const sessions: Session[] = [];
	return {
		base,
		src,
		sessions,
		async start() {
			const session = await Session.start(src);
			sessions.push(session);
			return session;
		},
		async dispose() {
			await Promise.all(sessions.map((session) => session.kill()));
			await rm(base, { recursive: true, force: true });
		},
	};
}

async function runProbe(probe: Probe, role: Role, src: string | undefined, id: string): Promise<Check> {
	const box = await sandbox(src);
	try {
		const outcome = await probe.run(box);
		return { id, role, claim: probe.claim, status: judge(role, outcome.violated), detail: outcome.detail };
	} catch (error) {
		const reason = error instanceof FixtureError ? "fixture stopped proving its claim" : "harness error";
		return { id, role, claim: probe.claim, status: "fail", detail: `${reason}: ${error instanceof Error ? error.message : String(error)}` };
	} finally {
		await box.dispose();
	}
}

/** One edit of src/store.ts, applied once. */
interface Edit {
	readonly anchor: string;
	readonly replacement: string;
}

/**
 * A deliberate break of src/store.ts that one guarantee probe must catch. The lease is a Linux abstract socket or a
 * macOS flock on the root descriptor (store.ts:acquireLease), so a break of the lease itself is written once per
 * mechanism: `anchor`/`replacement` is the Linux edit, `darwin` the same break of the flock path. A mutant without
 * `darwin` breaks code both platforms run. Every mutant keeps one id and one probe on both platforms.
 */
interface Mutant extends Edit {
	readonly id: string;
	readonly probe: Probe;
	readonly claim: string;
	readonly darwin?: Edit;
}

const MUTANTS: readonly Mutant[] = [
	{
		id: "lease-name-per-process",
		probe: raceOneWinner,
		claim: "a lease name that includes the pid excludes nobody: two processes both open the store",
		anchor: "`${identity.dev}:${identity.ino}`",
		replacement: "`${identity.dev}:${identity.ino}:${process.pid}`",
		// flock has no name to key: the equivalent is a lock call whose failure is never taken for a conflict.
		darwin: {
			anchor: "darwinLibc.symbols.flock(rootFd, LOCK_EX | LOCK_NB) === -1",
			replacement: "darwinLibc.symbols.flock(rootFd, LOCK_EX | LOCK_NB) === -2",
		},
	},
	{
		id: "failed-open-keeps-lease",
		probe: failedOpenReleasesLease,
		claim: "an open that fails after the lease and does not release it blocks the directory while its process lives",
		anchor: "await release(rootFd, streams, lease);\n      } catch (cleanupError)",
		replacement: "await release(rootFd, streams);\n      } catch (cleanupError)",
		// Closing the root descriptor is what frees a flock, so the break must leave that descriptor open.
		darwin: {
			anchor: "await release(rootFd, streams, lease);\n      } catch (cleanupError)",
			replacement: "closeStreams(streams, []);\n      } catch (cleanupError)",
		},
	},
	{
		id: "gc-before-lease",
		probe: rejectedOpenerChangesNothing,
		claim: "garbage collection ahead of the lease lets a rejected opener delete files of the live store",
		anchor: "  const identity = fstatSync(rootFd, { bigint: true });",
		replacement: "  for (const name of readdirSync(descriptorPath(rootFd))) if (viewTempName.test(name)) unlinkSync(at(rootFd, name));\n  const identity = fstatSync(rootFd, { bigint: true });",
		// On macOS acquireLease returns before that line, so the same break goes in front of the flock.
		darwin: {
			anchor: "async function acquireLease(rootFd: number): Promise<Lease> {\n",
			replacement: "async function acquireLease(rootFd: number): Promise<Lease> {\n  for (const name of readdirSync(descriptorPath(rootFd))) if (viewTempName.test(name)) unlinkSync(at(rootFd, name));\n",
		},
	},
	{
		id: "close-keeps-lease",
		probe: closeReleasesAndFences,
		claim: "a close that leaves the lease bound blocks every later opener while the process lives",
		anchor: "  if (!lease.server.listening) return Promise.resolve();",
		replacement: "  return Promise.resolve();",
		// The flock lives as long as the root descriptor, so the break leaves that descriptor open.
		darwin: {
			anchor: "  closeDescriptor(rootFd, errors);\n  // Release ownership",
			replacement: "  // Release ownership",
		},
	},
	{
		id: "archive-releases-before-rename",
		probe: archiveHoldsTheLease,
		claim: "an archive that frees the lease before it renames lets another session open the directory it is about to move",
		anchor: "      archive = moveToArchive(this.directory, now, report);",
		replacement: "      await release(this.rootFd, [], this.lease);\n      archive = moveToArchive(this.directory, now, report);",
	},
	{
		id: "archive-leaves-stream-descriptors-open",
		probe: archiveHoldsTheLease,
		claim: "an archive that leaves the stream descriptors open keeps the log and tree directories of the archived chat open in the process",
		anchor: "    closeStreams(this.openStreams(), errors);\n    let archive",
		replacement: "    let archive",
	},
	{
		id: "archive-skips-inode-check",
		probe: archiveRefusesDisplacedPath,
		claim: "an archive that renames whatever its path names now moves the live store of whoever opened it after a mv",
		anchor: "if (named?.dev !== held.dev || named.ino !== held.ino) {",
		replacement: "if (false) {",
	},
	{
		id: "refused-archive-keeps-lease",
		probe: archiveRefusesDisplacedPath,
		claim: "an archive that frees the lease only on success leaves a refused store holding its lease while the process lives",
		anchor: "      await release(this.rootFd, [], this.lease);\n    } catch (error) {\n      errors.push(error);",
		replacement: "      if (archive !== undefined) await release(this.rootFd, [], this.lease);\n    } catch (error) {\n      errors.push(error);",
	},
	{
		id: "sidecar-path-by-pathname",
		probe: sidecarWritesFollowTheInode,
		claim: "a sidecar path built from store.directory sends ledger and metrics into whichever store sits at the old path",
		anchor: "    return at(this.rootFd, name);",
		replacement: "    return join(this.directory, name);",
	},
	{
		id: "sidecar-path-without-writable-check",
		probe: closedStoreHasNoSidecar,
		claim: "a sidecar path that skips assertWritable gives a closed store a path through a descriptor number another store may hold",
		anchor: "    this.assertWritable();\n    return at(this.rootFd, name);",
		replacement: "    return at(this.rootFd, name);",
	},
];

/** A copy of src/ whose store.ts has the mutant's edit for this platform applied once; throws when the anchor is not found exactly once. */
async function mutate(mutant: Mutant): Promise<string> {
	const edit: Edit = process.platform === "darwin" && mutant.darwin ? mutant.darwin : mutant;
	const dir = join(ROOT, ".verify", `mutant-${mutant.id}`);
	await rm(dir, { recursive: true, force: true });
	await cp(join(ROOT, "src"), join(dir, "src"), { recursive: true });
	const path = join(dir, "src", "store.ts");
	const text = await readFile(path, "utf8");
	const parts = text.split(edit.anchor);
	if (parts.length !== 2) {
		throw new Error(`mutant ${mutant.id}: its anchor now matches ${parts.length - 1} places in src/store.ts, not 1; the lease code moved, so update the anchor in real.ts (maintain skill)`);
	}
	await writeFile(path, parts.join(edit.replacement));
	return join(dir, "src");
}

async function runMutant(mutant: Mutant): Promise<Check> {
	const id = `real/broken/${mutant.id}`;
	let src: string;
	try {
		src = await mutate(mutant);
	} catch (error) {
		return { id, role: "broken", claim: mutant.claim, status: "fail", detail: error instanceof Error ? error.message : String(error) };
	}
	try {
		const check = await runProbe(mutant.probe, "broken", src, id);
		return { ...check, claim: mutant.claim, detail: `${mutant.probe.id} caught it: ${check.detail}` };
	} finally {
		await rm(dirname(src), { recursive: true, force: true });
	}
}

/** The real-process harness: guarantees, then the open findings (none now), then the breaks. */
export async function runReal(): Promise<Check[]> {
	const checks: Check[] = [];
	for (const probe of GUARANTEES) checks.push(await runProbe(probe, "guarantee", undefined, `real/${probe.id}`));
	for (const probe of FINDINGS) checks.push(await runProbe(probe, "finding", undefined, `real/${probe.id}`));
	for (const mutant of MUTANTS) checks.push(await runMutant(mutant));
	return checks;
}
