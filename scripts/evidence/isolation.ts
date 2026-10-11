import { existsSync } from "node:fs";
import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { type AuthCredential, AuthStorage } from "@oh-my-pi/pi-ai";

/** Every directory the host can read or write during a run: nothing lives under the operator's home. */
export interface IsolatedDirs {
	readonly root: string;
	readonly home: string;
	readonly agentDir: string;
	readonly workspace: string;
	readonly tmp: string;
	readonly xdgConfig: string;
	readonly xdgCache: string;
	readonly xdgData: string;
	readonly xdgState: string;
	readonly sessions: string;
}

export function isolatedDirs(root: string): IsolatedDirs {
	return {
		root,
		home: join(root, "home"),
		agentDir: join(root, "agent"),
		workspace: join(root, "workspace"),
		tmp: join(root, "tmp"),
		xdgConfig: join(root, "xdg", "config"),
		xdgCache: join(root, "xdg", "cache"),
		xdgData: join(root, "xdg", "data"),
		xdgState: join(root, "xdg", "state"),
		sessions: join(root, "sessions"),
	};
}

/**
 * Makes the workspace its own git repository root, the discovery boundary for SDK 18.9.0 project
 * context. `repoRoot` is the nearest directory with a `.git` entry (src/capability/fs.ts:84-95, used
 * by src/capability/index.ts:336). Project SYSTEM.md discovery walks ancestors from cwd only through
 * `repoRoot ?? home` (src/discovery/builtin.ts:78-106, 275-278). Without this marker the walk runs
 * from the workspace through the run root and past it to `/`, reading ambient files such as
 * `/tmp/.omp/SYSTEM.md`. The git binary runs with no global or system config and no network access.
 */
async function initWorkspaceBoundary(dirs: IsolatedDirs): Promise<void> {
	const child = Bun.spawn(["git", "init", "--quiet", dirs.workspace], {
		stdin: "ignore",
		stdout: "ignore",
		stderr: "ignore",
		env: {
			PATH: process.env.PATH ?? "",
			HOME: dirs.home,
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_TERMINAL_PROMPT: "0",
		},
	});
	const code = await child.exited;
	if (code !== 0) throw new Error(`git init for the isolated workspace failed with exit code ${code}`);
}

/**
 * Preflight for the workspace boundary: fails unless the workspace carries its own `.git` marker and
 * no SYSTEM.md or SYSTEM_TEMPLATE.md sits in its project config directory (`.omp`, CONFIG_DIR_NAME in
 * pi-utils/src/dirs.ts:28), which the SDK's project scope would read (builtin.ts:275-278).
 */
export function assertWorkspaceBoundary(dirs: IsolatedDirs): void {
	if (!existsSync(join(dirs.workspace, ".git"))) {
		throw new Error("isolated workspace is not a discovery boundary: missing .git marker");
	}
	for (const name of ["SYSTEM.md", "SYSTEM_TEMPLATE.md"]) {
		const file = join(dirs.workspace, ".omp", name);
		if (existsSync(file)) throw new Error(`ambient system prompt discovered in isolated workspace: ${name}`);
	}
}

/** Creates the isolated tree and the workspace discovery boundary (see initWorkspaceBoundary). */
export async function createIsolatedDirs(root: string): Promise<IsolatedDirs> {
	const dirs = isolatedDirs(root);
	for (const dir of [dirs.home, dirs.agentDir, dirs.workspace, dirs.tmp, dirs.xdgConfig, dirs.xdgCache, dirs.xdgData, dirs.xdgState, dirs.sessions]) {
		await mkdir(dir, { recursive: true, mode: 0o700 });
	}
	await initWorkspaceBoundary(dirs);
	return dirs;
}

/** Only these host-essential variables are inherited; everything else is absent unless explicitly allowed. */
export const INHERITED_ESSENTIALS = ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ"] as const;

/**
 * The complete child environment: essentials, then explicitly allowed credential variables, then
 * isolation paths last so no allowance can override them. A missing allowed variable throws.
 */
export function childEnvironment(parent: Readonly<Record<string, string | undefined>>, dirs: IsolatedDirs, allowed: readonly string[]): Record<string, string> {
	const env: Record<string, string> = {};
	for (const name of INHERITED_ESSENTIALS) {
		const value = parent[name];
		if (value !== undefined) env[name] = value;
	}
	for (const name of allowed) {
		const value = parent[name];
		if (value === undefined || value === "") throw new Error(`allowed environment variable ${name} is not set in the runner`);
		env[name] = value;
	}
	return {
		...env,
		HOME: dirs.home,
		PI_CODING_AGENT_DIR: dirs.agentDir,
		XDG_CONFIG_HOME: dirs.xdgConfig,
		XDG_CACHE_HOME: dirs.xdgCache,
		XDG_DATA_HOME: dirs.xdgData,
		XDG_STATE_HOME: dirs.xdgState,
		TMPDIR: dirs.tmp,
	};
}

export interface CopiedAuth {
	/** Providers whose stored credentials were copied into the isolated store. */
	readonly copied: string[];
	/** Providers with no stored credential in the source store. */
	readonly missing: string[];
}

/**
 * Copies only the selected providers' stored credentials into an isolated 0600 auth store, through
 * the SDK's AuthStorage credential API. Sessions, settings, models, and other rows are never read
 * into the target, and credential values are never returned or printed.
 */
export async function copySelectedAuth(sourceAgentDir: string, targetAgentDir: string, providers: readonly string[]): Promise<CopiedAuth> {
	const sourceDb = join(sourceAgentDir, "agent.db");
	const unique = [...new Set(providers)];
	if (!existsSync(sourceDb)) return { copied: [], missing: unique };
	const selected = new Map<string, AuthCredential[]>();
	const source = await AuthStorage.create(sourceDb);
	try {
		// The store loads lazily; list() is empty until the first reload.
		await source.reload();
		for (const provider of unique) selected.set(provider, readCredentials(source, provider));
	} finally {
		source.close();
	}
	const targetDb = join(targetAgentDir, "agent.db");
	const target = await AuthStorage.create(targetDb);
	const copied: string[] = [];
	const missing: string[] = [];
	try {
		for (const provider of unique) {
			const credentials = selected.get(provider) ?? [];
			if (credentials.length === 0) {
				missing.push(provider);
				continue;
			}
			for (const credential of credentials) await target.credentials.upsert(provider, credential);
			copied.push(provider);
		}
	} finally {
		target.close();
	}
	for (const path of [targetDb, `${targetDb}-wal`, `${targetDb}-shm`]) {
		if (existsSync(path)) await chmod(path, 0o600);
	}
	return { copied, missing };
}

/** Active credentials for one provider from an open store; values stay in memory only. */
function readCredentials(store: AuthStorage, provider: string): AuthCredential[] {
	return store.credentials.list(provider).map((row) => row.credential);
}
