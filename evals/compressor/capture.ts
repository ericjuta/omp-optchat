/**
 * Captures the host system prompt and encoded tool list a real main request carries, for arm H of the compressor A/B.
 *
 * It launches the installed `omp` over RPC in this repository (so the project's context files, skills and the user's
 * other extensions shape the prompt as in a real session) with OptChat opted out and a throwaway store, loads
 * capture-extension.ts, and points the `anthropic` provider at a loopback endpoint that never answers. OMP's own
 * encoder and credential handling produce the request; the extension writes its system and tools to disk, and this
 * driver then kills OMP. No provider call is made and no real chat store is opened.
 *
 * Usage: bun evals/compressor/capture.ts [--run ab-20261021] [--omp ~/.bun/bin/omp] [--model anthropic/claude-opus-5-5]
 * Output (gitignored): evals/compressor/runs/<run>/host-prefix.json
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { DEFAULT_RUN, flag, ROOT, runDir, sha256 } from "./lib.ts";

interface HostPrefix {
	readonly model: string;
	readonly systemPrompt: string[];
	readonly system: unknown;
	readonly tools: unknown[];
}

async function main(args: string[]): Promise<void> {
	const run = flag(args, "--run", DEFAULT_RUN);
	const omp = flag(args, "--omp", join(process.env.HOME ?? "", ".bun/bin/omp"));
	const model = flag(args, "--model", "anthropic/claude-opus-5-5");
	const dir = runDir(run);
	const out = join(dir, "host-prefix.json");
	const scratch = mkdtempSync(join(tmpdir(), "optchat-capture-"));
	const file = join(scratch, "capture.json");
	// The endpoint accepts requests and never answers; the capture happens before the request is sent.
	const never = Promise.withResolvers<Response>();
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => never.promise });
	const env = {
		...process.env,
		OPTCHAT_CAPTURE_FILE: file,
		OPTCHAT_CAPTURE_BASE_URL: `http://127.0.0.1:${server.port}`,
	};
	const child = spawn(omp, [
		"--mode", "rpc", "--no-ui", "--no-session", "--no-title", "--no-prewalk",
		"--no-optchat", "--optchat-dir", join(scratch, "store"),
		"--model", model,
		"-e", join(ROOT, "evals/compressor/capture-extension.ts"),
	], { cwd: ROOT, env, stdio: ["pipe", "pipe", "pipe"], detached: true });
	let diagnostics = "";
	child.stderr.on("data", (chunk: Buffer) => { diagnostics = (diagnostics + chunk.toString()).slice(-4000); });
	let sent = false;
	createInterface({ input: child.stdout }).on("line", (line) => {
		if (sent) return;
		let event: unknown;
		try {
			event = JSON.parse(line);
		} catch {
			return;
		}
		if (typeof event !== "object" || event === null || !("type" in event) || event.type !== "ready") return;
		sent = true;
		child.stdin.write(`${JSON.stringify({ id: "capture-1", type: "prompt", message: "capture probe" })}\n`);
	});
	const exit = Promise.withResolvers<string>();
	child.once("exit", (code, signal) => exit.resolve(`omp exited early (${code ?? signal})`));
	const exited = exit.promise;
	const deadline = Date.now() + 120_000;
	try {
		for (;;) {
			if (existsSync(file)) break;
			if (Date.now() > deadline) throw new Error(`no request captured within 120 s${diagnostics ? `; stderr: ${diagnostics}` : ""}`);
			const early = await Promise.race([exited, Bun.sleep(100).then(() => undefined)]);
			if (early) throw new Error(`${early}${diagnostics ? `; stderr: ${diagnostics}` : ""}`);
		}
		await Bun.sleep(200);
		// The file is the capture extension's own output, written by this driver's child process.
		const captured: HostPrefix = JSON.parse(readFileSync(file, "utf8"));
		if (!Array.isArray(captured.systemPrompt) || !Array.isArray(captured.tools) || captured.tools.length === 0) {
			throw new Error("captured request has no system prompt blocks or tools");
		}
		writeFileSync(out, JSON.stringify(captured), { mode: 0o600 });
		console.log(JSON.stringify({
			out,
			model: captured.model,
			systemPromptBlocks: captured.systemPrompt.length,
			systemPromptBytes: captured.systemPrompt.reduce((sum, block) => sum + Buffer.byteLength(block), 0),
			wireSystemBytes: Buffer.byteLength(JSON.stringify(captured.system)),
			wireToolCount: captured.tools.length,
			wireToolBytes: Buffer.byteLength(JSON.stringify(captured.tools)),
			sha256: sha256(JSON.stringify([captured.systemPrompt, captured.system, captured.tools])),
		}, null, 2));
	} finally {
		try { process.kill(-child.pid!, "SIGKILL"); } catch { /* already gone */ }
		void server.stop(true);
		rmSync(scratch, { recursive: true, force: true });
	}
}

if (import.meta.main) await main(process.argv.slice(2));
