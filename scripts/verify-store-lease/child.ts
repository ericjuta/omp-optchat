/**
 * One OMP session, as a real process: it opens, writes to and closes OptChat stores on command.
 * real.ts spawns several of these and drives them with JSON lines on stdin; each command gets exactly
 * one reply line on stdout (`arm` first sends `{"event":"armed"}`). The source tree under test is
 * $OPTCHAT_SRC (a mutated copy for real.ts's break checks), else this repository's src/.
 */
import { spyOn } from "bun:test";
import * as fs from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type * as Metrics from "../../src/metrics.ts";
import type * as Store from "../../src/store.ts";
import type * as Ledger from "../../src/system1/ledger.ts";

// The source tree is chosen at run time ($OPTCHAT_SRC: a mutated copy), so these cannot be static imports.
const SRC = resolve(process.env.OPTCHAT_SRC ?? join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src"));
const { Store: StoreClass } = (await import(join(SRC, "store.ts"))) as typeof Store;
const { LEDGER_FILE, RuleLedger: LedgerClass } = (await import(join(SRC, "system1", "ledger.ts"))) as typeof Ledger;
const { appendMetric, METRICS_FILE } = (await import(join(SRC, "metrics.ts"))) as typeof Metrics;

interface Command {
	readonly cmd: string;
	readonly dir?: string;
	readonly go?: string;
	readonly text?: string;
}

let store: Store.Store | undefined;
let ledger: Ledger.RuleLedger | undefined;

const send = (value: Record<string, unknown>): void => {
	process.stdout.write(`${JSON.stringify(value)}\n`);
};

const failure = (error: unknown): Record<string, unknown> => {
	const e = error instanceof Error ? error : new Error(String(error));
	return { ok: false, name: e.name, message: e.message };
};

async function openStore(dir: string): Promise<Record<string, unknown>> {
	try {
		store = await StoreClass.open(dir);
		return { ok: true, directory: store.directory, messages: store.messages.length };
	} catch (error) {
		return failure(error);
	}
}

/** Spins until the go file exists, so every armed child calls Store.open within microseconds of the others. */
function waitFor(go: string): void {
	const deadline = Date.now() + 15_000;
	while (!fs.existsSync(go)) {
		if (Date.now() > deadline) throw new Error(`barrier ${go} never opened`);
	}
}

/** Another process's Store.open of `directory`: "opened" (it closes again at once) or the error's name. */
function openFromAnotherProcess(directory: string): string {
	const code = `import { Store } from ${JSON.stringify(join(SRC, "store.ts"))};
try { const opened = await Store.open(${JSON.stringify(directory)}); await opened.close(); console.log("opened"); }
catch (error) { console.log(error.name); }`;
	return Bun.spawnSync([process.execPath, "-e", code], { stdin: "ignore" }).stdout.toString().trim();
}

/**
 * index.ts:1665 archives through Store.archive. At the rename (store.ts:661) another process tries to open the
 * directory: `during` is what it got. The hook only observes; the rename itself runs unchanged.
 */
async function archiveHeld(command: Command): Promise<Record<string, unknown>> {
	const held = store;
	if (!held) return { ok: false, name: "Error", message: "no store is open" };
	const directory = held.directory;
	const native = fs.renameSync;
	let during = "no rename ran";
	const spy = spyOn(fs, "renameSync").mockImplementation(((source: fs.PathLike, destination: fs.PathLike) => {
		if (String(destination).startsWith(`${directory}.`)) during = openFromAnotherProcess(directory);
		return native(source, destination);
	}) as typeof fs.renameSync);
	try {
		const archive = await held.archive(new Date(command.text ?? ""));
		// Descriptors of this process that still point into the archive: Store.archive must have closed them all.
		const leaked = fs.readdirSync("/proc/self/fd").filter((name) => {
			try {
				return fs.readlinkSync(`/proc/self/fd/${name}`).startsWith(archive);
			} catch {
				return false;
			}
		}).length;
		return { ok: true, archive, during, leaked };
	} catch (error) {
		return { ...failure(error), during };
	} finally {
		spy.mockRestore();
	}
}

/** A closed store whose descriptor number another store in the same process now holds must not give out a path. */
async function closedSidecar(base: string): Promise<Record<string, unknown>> {
	const closed = await StoreClass.open(join(base, "closed"));
	await closed.close();
	const other = await StoreClass.open(join(base, "other"));
	try {
		return { ok: true, path: closed.sidecarPath("x.jsonl"), directory: other.directory };
	} catch (error) {
		return failure(error);
	} finally {
		await other.close();
	}
}

async function handle(command: Command): Promise<Record<string, unknown>> {
	switch (command.cmd) {
		case "open":
			return openStore(command.dir ?? "");
		case "arm": {
			send({ event: "armed" });
			waitFor(command.go ?? "");
			return openStore(command.dir ?? "");
		}
		case "append":
			try {
				return { ok: true, i: store?.append("user", command.text ?? "").i };
			} catch (error) {
				return failure(error);
			}
		case "close":
			try {
				await store?.close();
				return { ok: true };
			} catch (error) {
				return failure(error);
			}
		case "archive":
			return archiveHeld(command);
		case "closed-sidecar":
			return closedSidecar(command.dir ?? "");
		case "ledger":
			// index.ts:677 opens the rules ledger right after Store.open, through the store's descriptor.
			ledger = LedgerClass.open(() => store?.sidecarPath(LEDGER_FILE) ?? "");
			return { ok: true };
		case "rule":
			try {
				ledger?.add(0, command.text ?? "", Date.now());
				return { ok: true };
			} catch (error) {
				return failure(error);
			}
		case "metric":
			// index.ts:2079 builds the metric sink as store.sidecarPath(METRICS_FILE); index.ts:896 resolves it per row.
			try {
				appendMetric(store?.sidecarPath(METRICS_FILE) ?? "", { type: "rules", at: new Date().toISOString(), pRule: null, pSentenceMax: null, sentences: 0, cutoff: 0.5, added: false });
				return { ok: true };
			} catch (error) {
				return failure(error);
			}
		case "exit":
			process.exit(0);
			return { ok: true };
		default:
			return { ok: false, name: "Error", message: `unknown command ${command.cmd}` };
	}
}

send({ event: "ready", pid: process.pid });
for await (const line of createInterface({ input: process.stdin })) {
	send({ event: "result", ...(await handle(JSON.parse(line) as Command)) });
}
