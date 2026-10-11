import type { Price } from "./artifact.ts";

/**
 * Credential-free discovery through public host surfaces only. Availability is the host's own
 * `get_available_models` answer; the runner never reads credential rows or derives account identity.
 */
export function providerOf(selector: string): string {
	const slash = selector.indexOf("/");
	if (slash <= 0) throw new Error(`model selector must be provider/id: ${selector}`);
	return selector.slice(0, slash);
}

/** Whether the host lists `selector` as an available (authenticated) model. */
export function isAvailable(models: readonly { readonly provider: string; readonly id: string }[], selector: string): boolean {
	return models.some((model) => `${model.provider}/${model.id}` === selector);
}

export interface CatalogEntry {
	readonly selector: string;
	readonly found: boolean;
	readonly pricingStatus: string | null;
	readonly contextWindow: number | null;
	readonly price: Price | null;
}

/**
 * Local catalog lookup through the installed host under the isolated environment; no provider request is made.
 * Runs in the isolated workspace `cwd` with `--no-extensions`: in 18.9.0 `omp models` otherwise loads project
 * settings and executes discovered extension factories before any confirmation (cli/models-cli.ts:329-339,
 * 394-419). `--no-extensions` sets disableExtensionDiscovery (cli/models-cli.ts:419), which passes
 * `ambient: false` and drops settings-declared extensions (cli/models-cli.ts:329-339). stdin is closed and
 * stderr is discarded; a failed run or non-JSON output throws with the exit code only, never stderr content.
 */
export async function readCatalogEntry(omp: string, selector: string, env: Readonly<Record<string, string>>, cwd: string): Promise<CatalogEntry> {
	const process = Bun.spawn([omp, "models", "--json", "--no-extensions"], {
		cwd,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "ignore",
		env: { ...env },
	});
	const text = await new Response(process.stdout).text();
	const code = await process.exited;
	if (code !== 0) throw new Error(`omp models --json failed with exit code ${code}`);
	let parsed: { models?: { selector?: string; pricingStatus?: string; contextWindow?: number; cost?: Record<string, number> }[] };
	try {
		parsed = JSON.parse(text) as typeof parsed;
	} catch {
		throw new Error(`omp models --json produced non-JSON output (exit code ${code})`);
	}
	const entry = (parsed.models ?? []).find((model) => model.selector === selector);
	if (!entry) return { selector, found: false, pricingStatus: null, contextWindow: null, price: null };
	const cost = entry.cost;
	const price = cost && [cost.input, cost.output, cost.cacheRead, cost.cacheWrite].every((value) => typeof value === "number")
		? { input: cost.input!, output: cost.output!, cacheRead: cost.cacheRead!, cacheWrite: cost.cacheWrite! }
		: null;
	return {
		selector,
		found: true,
		pricingStatus: entry.pricingStatus ?? null,
		contextWindow: typeof entry.contextWindow === "number" ? entry.contextWindow : null,
		price,
	};
}

/** Installed host version string (e.g. "omp/18.9.0"); no credentials are involved. */
export async function hostVersion(omp: string, env: Readonly<Record<string, string>>, cwd: string): Promise<string> {
	const process = Bun.spawn([omp, "--version"], { cwd, stdin: "ignore", stdout: "pipe", stderr: "ignore", env: { ...env } });
	const text = await new Response(process.stdout).text();
	await process.exited;
	return text.trim().split("\n")[0] ?? "unknown";
}

/** Plugin source revision for artifact binding; null when the checkout is not a git worktree. */
export async function pluginRevision(root: string): Promise<{ commit: string; dirtyFiles: number } | null> {
	const head = Bun.spawn(["git", "-C", root, "rev-parse", "HEAD"], { stdout: "pipe", stderr: "ignore" });
	const commit = (await new Response(head.stdout).text()).trim();
	if ((await head.exited) !== 0 || commit.length === 0) return null;
	const status = Bun.spawn(["git", "-C", root, "status", "--porcelain"], { stdout: "pipe", stderr: "ignore" });
	const dirty = (await new Response(status.stdout).text()).split("\n").filter((line) => line.trim()).length;
	await status.exited;
	return { commit, dirtyFiles: dirty };
}
