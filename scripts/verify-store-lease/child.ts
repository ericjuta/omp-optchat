/**
 * One OMP session, as a real process: it opens, writes to and closes OptChat stores on command.
 * real.ts spawns several of these and drives them with JSON lines on stdin; each command gets exactly
 * one reply line on stdout (`arm` first sends `{"event":"armed"}`). The source tree under test is
 * $OPTCHAT_SRC (a mutated copy for real.ts's break checks), else this repository's src/.
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type * as Metrics from "../../src/metrics.ts";
import type * as Store from "../../src/store.ts";
import type * as Ledger from "../../src/system1/ledger.ts";

// The source tree is chosen at run time ($OPTCHAT_SRC: a mutated copy), so these cannot be static imports.
const SRC = resolve(process.env.OPTCHAT_SRC ?? join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src"));
const { Store: StoreClass } = (await import(join(SRC, "store.ts"))) as typeof Store;
const { RuleLedger: LedgerClass } = (await import(join(SRC, "system1", "ledger.ts"))) as typeof Ledger;
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
	while (!existsSync(go)) {
		if (Date.now() > deadline) throw new Error(`barrier ${go} never opened`);
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
		case "ledger":
			// index.ts:677 opens the rules ledger at join(store.directory, "ledger.jsonl") right after Store.open.
			ledger = LedgerClass.open(store?.directory ?? "");
			return { ok: true };
		case "rule":
			try {
				ledger?.add(0, command.text ?? "", Date.now());
				return { ok: true };
			} catch (error) {
				return failure(error);
			}
		case "metric":
			// index.ts:2066 builds the metric sink as join(store.directory, METRICS_FILE); index.ts:895 appends to it.
			try {
				appendMetric(join(store?.directory ?? "", METRICS_FILE), { type: "rules", at: new Date().toISOString(), pRule: null, pSentenceMax: null, sentences: 0, cutoff: 0.5, added: false });
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
