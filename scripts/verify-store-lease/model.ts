/**
 * Runs the TLA+ model of the store writer lease (StoreLease.tla) under TLC: the current code, then
 * broken variants that must each violate the property they target, then fixed designs that must hold.
 */
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { judge, type Check, type Role } from "./check.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const WORK = join(ROOT, ".verify");
// TLC joins -config onto its working directory, so an absolute path is not found: hand it paths relative to HERE.
const SPEC = "StoreLease.tla";

const JAVA_MISE = "java@temurin-21.0.12+8.0.LTS";
const JAR_URL = "https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar";
const JAR_SHA256 = "936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88";
const CONCURRENCY = 4;

/** The model's bounds: two sessions, three directory inodes, the path D and a symlink spelling L of it. */
const BOUNDS = `    Procs = {p1, p2}
    Inodes = {i1, i2, i3}
    None = None
    Spellings = {"D", "L"}`;

interface Case {
	readonly id: string;
	readonly role: Role;
	readonly variant: string;
	readonly externalMove: boolean;
	readonly invariant: string;
	readonly claim: string;
}

const MOVE = true;
const CASES: readonly Case[] = [
	// The code as it is, with a user able to `mv` an open store directory away.
	{ id: "current/ExclusiveOpen", role: "guarantee", variant: "Current", externalMove: MOVE, invariant: "ExclusiveOpen", claim: "two sessions never both have the same store directory open" },
	{ id: "current/StoreWritesUnderLease", role: "guarantee", variant: "Current", externalMove: MOVE, invariant: "StoreWritesUnderLease", claim: "every store write (log, tree, images, view, open-time repair and GC) is made under the lease" },
	{ id: "current/NoOrphanLease", role: "guarantee", variant: "Current", externalMove: MOVE, invariant: "NoOrphanLease", claim: "a dead, closed or failed session never blocks the next opener" },
	{ id: "current/ArchiveOnlyClosed", role: "finding", variant: "Current", externalMove: MOVE, invariant: "ArchiveOnlyClosed", claim: "`/optchat new` never renames a store directory another session has open (F1)" },
	{ id: "current/SidecarWritesUnderLease", role: "finding", variant: "Current", externalMove: MOVE, invariant: "SidecarWritesUnderLease", claim: "rules-ledger and metrics writes land in the directory their writer holds the lease of (F2)" },
	// The findings need no user `mv`: the `/optchat new` window alone reaches them.
	{ id: "current-no-mv/ArchiveOnlyClosed", role: "finding", variant: "Current", externalMove: !MOVE, invariant: "ArchiveOnlyClosed", claim: "`/optchat new` never renames a store directory another session has open (F1), reached with two sessions and no user mv" },
	{ id: "current-no-mv/SidecarWritesUnderLease", role: "finding", variant: "Current", externalMove: !MOVE, invariant: "SidecarWritesUnderLease", claim: "rules-ledger and metrics writes land in the directory their writer holds the lease of (F2), reached with two sessions and no user mv" },
	// Each guarantee's checker must catch the break it exists to catch.
	{ id: "broken-NoLease/ExclusiveOpen", role: "broken", variant: "NoLease", externalMove: !MOVE, invariant: "ExclusiveOpen", claim: "EADDRINUSE treated as acquired lets two sessions open one store" },
	{ id: "broken-PathKey/ExclusiveOpen", role: "broken", variant: "PathKey", externalMove: !MOVE, invariant: "ExclusiveOpen", claim: "a lease keyed by path spelling lets a symlink spelling open the store twice" },
	{ id: "broken-WriteBeforeLease/StoreWritesUnderLease", role: "broken", variant: "WriteBeforeLease", externalMove: !MOVE, invariant: "StoreWritesUnderLease", claim: "open-time repair and GC before acquireLease write without the lease" },
	{ id: "broken-NoCrashRelease/NoOrphanLease", role: "broken", variant: "NoCrashRelease", externalMove: !MOVE, invariant: "NoOrphanLease", claim: "a lease that survives its holder's death blocks every later opener" },
	{ id: "broken-LeakOnFailedOpen/NoOrphanLease", role: "broken", variant: "LeakOnFailedOpen", externalMove: !MOVE, invariant: "NoOrphanLease", claim: "an open that fails after acquireLease and does not release it blocks the store for good" },
	// The fixes the findings point to: the same properties hold once they are applied.
	{ id: "fixed-ArchiveUnderLease/ArchiveOnlyClosed", role: "fixed", variant: "ArchiveUnderLease", externalMove: MOVE, invariant: "ArchiveOnlyClosed", claim: "archive while still holding the lease, and only the leased inode: F1 closes" },
	{ id: "fixed-LedgerAtInode/SidecarWritesUnderLease", role: "fixed", variant: "LedgerAtInode", externalMove: MOVE, invariant: "SidecarWritesUnderLease", claim: "ledger and metrics written relative to rootFd: F2 closes" },
];

export interface Toolchain {
	readonly java: string;
	readonly via: string;
	readonly jar: string;
}

/** `$JAVA`, then `mise where java@temurin-21.0.12+8.0.LTS`, then `java` on PATH. */
async function findJava(): Promise<{ path: string; via: string }> {
	const explicit = process.env.JAVA;
	if (explicit) {
		if (!existsSync(explicit)) throw new Error(`$JAVA is set to ${explicit}, which does not exist`);
		return { path: explicit, via: "$JAVA" };
	}
	if (Bun.which("mise")) {
		const result = Bun.spawnSync(["mise", "where", JAVA_MISE], { stdout: "pipe", stderr: "pipe" });
		const home = result.stdout.toString().trim();
		if (result.exitCode === 0 && home && existsSync(join(home, "bin", "java"))) return { path: join(home, "bin", "java"), via: `mise where ${JAVA_MISE}` };
	}
	const onPath = Bun.which("java");
	if (onPath) return { path: onPath, via: "PATH" };
	throw new Error(`no Java found: set $JAVA to a java binary, or run \`mise install ${JAVA_MISE}\`, or put java (21 recommended) on PATH`);
}

/** The TLA+ tools jar: `$TLA2TOOLS_JAR` or ~/.local/share/tlaplus/1.7.4; fetched and pinned by sha256 when absent. */
async function ensureJar(): Promise<string> {
	const jar = process.env.TLA2TOOLS_JAR || join(homedir(), ".local", "share", "tlaplus", "1.7.4", "tla2tools.jar");
	if (existsSync(jar)) {
		const have = createHash("sha256").update(await readFile(jar)).digest("hex");
		if (have !== JAR_SHA256) throw new Error(`${jar} has sha256 ${have}, expected ${JAR_SHA256} (TLA+ tools v1.7.4); delete it to fetch the pinned jar`);
		return jar;
	}
	console.log(`fetching ${JAR_URL}`);
	const response = await fetch(JAR_URL);
	if (!response.ok) throw new Error(`fetching ${JAR_URL} failed: HTTP ${response.status}`);
	const bytes = new Uint8Array(await response.arrayBuffer());
	const got = createHash("sha256").update(bytes).digest("hex");
	if (got !== JAR_SHA256) throw new Error(`downloaded tla2tools.jar has sha256 ${got}, expected ${JAR_SHA256}; not installed`);
	await mkdir(dirname(jar), { recursive: true });
	const partial = `${jar}.${process.pid}.part`;
	await writeFile(partial, bytes);
	await chmod(partial, 0o644);
	await rename(partial, jar);
	return jar;
}

export async function toolchain(): Promise<Toolchain> {
	const java = await findJava();
	return { java: java.path, via: java.via, jar: await ensureJar() };
}

function configFor(c: Case): string {
	return `SPECIFICATION Spec
CONSTANTS
${BOUNDS}
    ExternalMove = ${c.externalMove ? "TRUE" : "FALSE"}
    Variant = "${c.variant}"
VIEW View
INVARIANT TypeOK
INVARIANT ${c.invariant}
`;
}

interface Run {
	readonly output: string;
	readonly exit: number | null;
}

/**
 * TLC unpacks the standard modules (Naturals, TLC, ...) into java.io.tmpdir, and parallel runs that share
 * /tmp overwrite each other's copies mid-parse ("Module-Table lookup failure"): each run gets its own.
 */
function run(tools: Toolchain, tmp: string, args: readonly string[]): Promise<Run> {
	const { promise, resolve, reject } = Promise.withResolvers<Run>();
	const child = spawn(tools.java, ["-XX:+UseParallelGC", `-Djava.io.tmpdir=${tmp}`, "-cp", tools.jar, "tlc2.TLC", ...args], { cwd: HERE, stdio: ["ignore", "pipe", "pipe"] });
	let output = "";
	child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
	child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
	child.on("error", reject);
	child.on("close", (exit) => resolve({ output, exit }));
	return promise;
}

/** Each TLC state prints `/\ last = "..."`: the step in the code's words. */
function narration(output: string): string[] {
	const steps: string[] = [];
	for (const line of output.split("\n")) {
		const m = /^\/\\ last = (".*")$/.exec(line);
		if (m?.[1] === undefined) continue;
		const text = JSON.parse(m[1]) as string;
		if (text !== "init") steps.push(text);
	}
	return steps;
}

async function check(tools: Toolchain, c: Case): Promise<Check> {
	const dir = join(WORK, c.id.replaceAll("/", "__"));
	await rm(dir, { recursive: true, force: true });
	await mkdir(join(dir, "states"), { recursive: true });
	await mkdir(join(dir, "tmp"), { recursive: true });
	const config = join(dir, "model.cfg");
	await writeFile(config, configFor(c));
	try {
		const { output, exit } = await run(tools, join(dir, "tmp"), ["-config", relative(HERE, config), "-metadir", relative(HERE, join(dir, "states")), "-workers", "1", "-nowarning", SPEC]);
		const found = /(\d+) states generated, (\d+) distinct states found/.exec(output);
		const stats = found ? `${found[2]} states` : "no state count";
		const violated = new RegExp(`Invariant ${c.invariant} is violated`).test(output);
		const clean = exit === 0 && /Model checking completed\. No error has been found\./.test(output);
		if (!violated && !clean) {
			const detail = output.split("\n").filter((l) => /^Error|exception|Exception/.test(l)).slice(0, 3).join(" | ") || output.slice(-300);
			return { id: c.id, role: c.role, claim: c.claim, status: "fail", detail: `TLC did not finish cleanly (exit ${exit}): ${detail}` };
		}
		const steps = violated ? narration(output) : [];
		return {
			id: c.id,
			role: c.role,
			claim: c.claim,
			status: judge(c.role, violated),
			detail: violated ? `${c.invariant} violated after ${steps.length} steps (${stats})` : `${c.invariant} holds (${stats})`,
			trace: steps.length > 0 ? steps : undefined,
		};
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

/** All model cases, CONCURRENCY at a time, in table order. */
export async function runModel(tools: Toolchain): Promise<Check[]> {
	const results: Check[] = new Array(CASES.length);
	let next = 0;
	const worker = async (): Promise<void> => {
		for (let index = next++; index < CASES.length; index = next++) {
			const c = CASES[index];
			if (c) results[index] = await check(tools, c);
		}
	};
	await Promise.all(Array.from({ length: CONCURRENCY }, worker));
	return results;
}
