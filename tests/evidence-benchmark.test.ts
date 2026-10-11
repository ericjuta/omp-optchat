import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { validateArtifact } from "../scripts/evidence/artifact.ts";

const ROOT = resolve(import.meta.dir, "..");
const OMP = process.env.OPTCHAT_EVIDENCE_OMP ?? Bun.which("omp");
const E2E_TIMEOUT_MS = 300_000;

async function runRecall(args: readonly string[]): Promise<{ exitCode: number; output: string }> {
	const proc = Bun.spawn(["bun", "scripts/evidence-recall.ts", ...args], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
	const [exitCode, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	return { exitCode, output: `${stdout}${stderr}` };
}

describe("evidence recall CLI", () => {
	test("refuses a live selector in fixture mode before any host starts", async () => {
		const dir = await mkdtemp(join(tmpdir(), "omp-optchat-evidence-refuse-"));
		try {
			const out = join(dir, "artifact.json");
			const { exitCode, output } = await runRecall(["--main", "openrouter/a", "--compressor", "optchat-smoke/optchat-smoke-compact", "--fixture-provider", "--out", out]);
			expect(exitCode).not.toBe(0);
			expect(output).toContain("--fixture-provider requires optchat-smoke/");
			expect(await readFile(out, "utf8").then(() => true, () => false)).toBe(false);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe.skipIf(OMP === null)("evidence recall no-call plan", () => {
	for (const mainContextWindow of [null, 128_000]) {
		test(`reports the main context override ${mainContextWindow} without live calls`, async () => {
			const dir = await mkdtemp(join(tmpdir(), "omp-optchat-evidence-plan-"));
			try {
				const out = join(dir, "artifact.json");
				const args = ["--main", "unconfigured/main", "--compressor", "unconfigured/compressor", "--agent-dir", dir, "--omp", OMP ?? "omp", "--out", out];
				if (mainContextWindow !== null) args.push("--main-context-window", String(mainContextWindow), "--max-calls", "2000");
				const { output } = await runRecall(args);
				const report = JSON.parse(output);
				expect(report.status).toBe("blocked");
				expect(report.plan.mainContextWindow).toBe(mainContextWindow);
				expect(report.plan.limits.maxCalls).toBe(mainContextWindow === null ? 80 : 2000);
				expect(await Bun.file(out).exists()).toBe(false);
			} finally {
				await rm(dir, { recursive: true, force: true });
			}
		}, E2E_TIMEOUT_MS);
	}
});

describe.skipIf(OMP === null)("evidence recall end to end (fixture provider)", () => {
	test("a paired on/off run with two compressors and the child experiment answers and delegates as scripted", async () => {
		const dir = await mkdtemp(join(tmpdir(), "omp-optchat-evidence-e2e-"));
		try {
			const out = join(dir, "artifact.json");
			const { exitCode, output } = await runRecall([
				"--main", "optchat-smoke/optchat-smoke-chat",
				"--compressor", "optchat-smoke/optchat-smoke-compact",
				"--arms", "on,off",
				"--compressors", "optchat-smoke/optchat-smoke-compact,optchat-smoke/optchat-smoke-child",
				"--turn-mode", "per-question",
				"--experiments", "child",
				"--projects", "2",
				"--sources", "16",
				"--questions", "4",
				"--max-cost-usd", "1",
				"--max-calls", "2000",
				"--main-context-window", "128000",
				"--fixture-provider",
				"--omp", OMP ?? "omp",
				"--out", out,
			]);
			expect(exitCode, output).toBe(0);

			const artifact = JSON.parse(await readFile(out, "utf8"));
			expect(artifact.schema).toBe("optchat-evidence-recall/3");
			expect(artifact.status).toBe("completed");
			expect(artifact.models.mainContextWindow).toBe(128_000);
			expect(artifact.limits.maxCalls).toBe(2000);
			expect(validateArtifact(artifact)).toEqual([]);

			// Routing: every request reached a fixture model, so the offline server recorded no violation.
			expect(artifact.limits.violations).toEqual([]);
			// Zero-rate fixtures spend nothing; an unobserved cost would be null and fail this.
			expect(Number.isFinite(artifact.limits.spentUsd)).toBe(true);
			expect(artifact.limits.spentUsd).toBe(0);

			const arms = [...new Set(artifact.scenarios.flatMap((scenario: { phases: { arm: string }[] }) => scenario.phases.map((phase) => phase.arm)))].sort();
			expect(arms).toEqual(["off", "on"]);

			expect(artifact.paired).toHaveLength(2);
			for (const pair of artifact.paired) {
				expect(pair.on.status).toBe("completed");
				expect(pair.off.status).toBe("completed");
				expect(pair.on.accuracy, pair.compressor).toMatchObject({ judged: 4, correct: 4, grounded: 4, hallucinated: 0 });
				expect(pair.off.accuracy, pair.compressor).toMatchObject({ judged: 4, correct: 4, grounded: 4, hallucinated: 0 });
			}

			const child = artifact.experiments.child;
			expect(child.reason).toBeNull();
			expect(child.arms.view).not.toBeNull();
			expect(child.arms.blind).not.toBeNull();
			const view: { taskId: string; status: string; success: boolean; valueCorrect: boolean | null; childZoomCalls: number | null }[] = child.arms.view.tasks;
			const blind: { taskId: string; status: string; valueCorrect: boolean | null }[] = child.arms.blind.tasks;
			// Every derived task gets its own host, so each arm must report all four tasks, none refused.
			expect(view).toHaveLength(4);
			expect(blind.map((task) => task.taskId)).toEqual(view.map((task) => task.taskId));
			expect([...view, ...blind].map((task) => task.status)).not.toContain("refused");
			// View arm: the child zooms the frozen parent memory, and the delegated answer is correct.
			for (const task of view) {
				expect(task.status, task.taskId).toBe("completed");
				expect(task.valueCorrect, task.taskId).toBe(true);
				expect(task.success, task.taskId).toBe(true);
				expect(task.childZoomCalls ?? 0, task.taskId).toBeGreaterThan(0);
			}
			// Blind arm: the child has no memory tools, so the scripted answer is uncertain and not a correct value.
			expect(blind).toHaveLength(4);
			for (const task of blind) {
				expect(task.status, task.taskId).toBe("completed");
				expect(task.valueCorrect, task.taskId).toBe(false);
			}
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, E2E_TIMEOUT_MS);
});
