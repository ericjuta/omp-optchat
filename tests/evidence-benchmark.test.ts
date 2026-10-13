import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runRecall } from "./helpers/run-recall.ts";

// The live-host cases (no-call plan and the paired end-to-end run) launch real omp processes and live in tests/host/evidence-benchmark.test.ts.
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
