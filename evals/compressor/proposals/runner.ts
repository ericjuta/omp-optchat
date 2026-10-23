/** Isolated proposal evaluations; all run artifacts stay in ignored compressor/runs/. */
export {};

const [command, ...args] = process.argv.slice(2);

switch (command) {
	case "merge-prepare":
	case "merge-check":
	case "merge-run":
	case "merge-report": {
		const actions = {
			"merge-prepare": "prepare",
			"merge-check": "check",
			"merge-run": "run",
			"merge-report": "report",
		} as const;
		const { runMergeExperiment } = await import("./merge.ts");
		await runMergeExperiment(actions[command], args);
		break;
	}
	case "cache-replay": {
		const { runCacheReplay } = await import("./cache.ts");
		await runCacheReplay(args);
		break;
	}
	default:
		throw new Error("Usage: bun evals/compressor/proposals/runner.ts <merge-prepare|merge-check|merge-run|merge-report|cache-replay> --run <name>; merge-run also requires --approval <frozen-manifest-sha256>.");
}
