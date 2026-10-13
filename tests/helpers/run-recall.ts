import { resolve } from "node:path";

/** Repository root, resolved from this helper so every evidence test shares one CLI path. */
export const REPO_ROOT = resolve(import.meta.dir, "../..");

/** Runs `scripts/evidence-recall.ts` with the given arguments and returns its exit code and combined output. */
export async function runRecall(args: readonly string[]): Promise<{ exitCode: number; output: string }> {
	const proc = Bun.spawn(["bun", "scripts/evidence-recall.ts", ...args], { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" });
	const [exitCode, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	return { exitCode, output: `${stdout}${stderr}` };
}
