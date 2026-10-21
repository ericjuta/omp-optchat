/**
 * Summarizes a finished (or stopped) compressor A/B run: sample composition, frozen hashes, hard-rule violations per
 * arm, the pairwise tally, cost per arm and the adopt decision by the pre-registered rule. It prints counts, hashes and
 * paths only, never chat text, and writes the same summary to runs/<run>/report.json.
 *
 * Usage: bun evals/compressor/report.ts [--run ab-20261021] [--rev HEAD]
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Ledger, type SpendRow } from "./host.ts";
import type { Judgment } from "./judge.ts";
import { DEFAULT_RUN, flag, loadSnapshot, NODE_BYTES, runDir, type Task, utf8Bytes } from "./lib.ts";
import type { ArmResult } from "./run.ts";

const USER_TAG = /(?:^|;\s+)user:/i;

const jsonl = <T>(file: string): T[] =>
	existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as T) : [];

interface Violations {
	over: number;
	head: number;
	falseUser: number;
	/** Replies with at least one violation. */
	replies: number;
}

const empty = (): Violations => ({ over: 0, head: 0, falseUser: 0, replies: 0 });

function add(into: Violations, v: { over: boolean; head: boolean; falseUser: boolean }): void {
	if (v.over) into.over++;
	if (v.head) into.head++;
	if (v.falseUser) into.falseUser++;
	if (v.over || v.head || v.falseUser) into.replies++;
}

const mean = (values: number[]): number | "unknown" => (values.length === 0 ? "unknown" : values.reduce((a, b) => a + b, 0) / values.length);
const round = (value: number | "unknown", digits = 5): number | "unknown" => (value === "unknown" ? value : Number(value.toFixed(digits)));

async function main(args: string[]): Promise<void> {
	const run = flag(args, "--run", DEFAULT_RUN);
	const rev = flag(args, "--rev", "HEAD");
	const dir = runDir(run);
	const snapshot = await loadSnapshot(run, rev);
	const tasks = jsonl<Task>(join(dir, "tasks.jsonl"));
	const byId = new Map(tasks.map((task) => [task.id, task]));
	const results = jsonl<ArmResult>(join(dir, "results.jsonl"));
	const judgments = jsonl<Judgment>(join(dir, "judgments.jsonl"));
	const spend: SpendRow[] = new Ledger(dir).rows();
	const sample = JSON.parse(readFileSync(join(dir, "sample.json"), "utf8"));
	const frozen = JSON.parse(readFileSync(join(dir, "frozen.json"), "utf8"));

	const finished = (task: string, arm: "H" | "C"): ArmResult | undefined =>
		results.findLast((r) => r.task === task && r.arm === arm && (r.final !== undefined || r.refused));
	// A task counts only when both arms finished: every metric below is over the same paired tasks.
	const paired = tasks.filter((task) => finished(task.id, "H") && finished(task.id, "C"));
	const pairedIds = new Set(paired.map((task) => task.id));

	const arms = {} as Record<"H" | "C", Record<string, unknown>>;
	const rate: Record<"H" | "C", { first: Violations; stored: Violations; calls: number; retries: number; refused: number; promptCosts: number[]; totalCosts: number[]; unknownCost: number; cacheRead: number; cacheWrite: number; input: number; output: number }> = {
		H: { first: empty(), stored: empty(), calls: 0, retries: 0, refused: 0, promptCosts: [], totalCosts: [], unknownCost: 0, cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
		C: { first: empty(), stored: empty(), calls: 0, retries: 0, refused: 0, promptCosts: [], totalCosts: [], unknownCost: 0, cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
	};
	for (const task of paired) {
		const own = { lo: task.node === "leaf" ? task.i : task.start, hi: task.node === "leaf" ? task.i : task.end - 1 };
		for (const arm of ["H", "C"] as const) {
			const result = finished(task.id, arm)!;
			const r = rate[arm];
			if (result.refused) r.refused++;
			result.attempts.forEach((attempt, index) => {
				r.calls++;
				if (index > 0) r.retries++;
				r.cacheRead += attempt.cacheRead;
				r.cacheWrite += attempt.cacheWrite;
				r.input += attempt.input;
				r.output += attempt.output;
				if (attempt.promptCostUsd === null || attempt.costUsd === null) r.unknownCost++;
				else {
					r.promptCosts.push(attempt.promptCostUsd);
					r.totalCosts.push(attempt.costUsd);
				}
				if (index === 0) add(r.first, attempt);
			});
			if (result.final !== undefined) {
				const head = snapshot.replyHead(result.final, own);
				add(r.stored, {
					over: utf8Bytes(result.final) > NODE_BYTES,
					head: head > 0,
					falseUser: !task.user && USER_TAG.test(result.final.slice(head)),
				});
			}
		}
	}
	for (const arm of ["H", "C"] as const) {
		const r = rate[arm];
		arms[arm] = {
			tasks: paired.length,
			providerCalls: r.calls,
			retryCalls: r.retries,
			refusedTasks: r.refused,
			hardViolationsFirstAttempt: r.first,
			hardViolationsStoredLine: r.stored,
			meanPromptCostPerCallUsd: round(mean(r.promptCosts)),
			meanTotalCostPerCallUsd: round(mean(r.totalCosts)),
			totalCostUsd: r.unknownCost > 0 ? "unknown" : round(r.totalCosts.reduce((a, b) => a + b, 0), 4),
			knownCostUsd: round(r.totalCosts.reduce((a, b) => a + b, 0), 4),
			callsWithUnknownCost: r.unknownCost,
			tokens: { input: r.input, cacheRead: r.cacheRead, cacheWrite: r.cacheWrite, output: r.output },
		};
	}

	const scored = judgments.filter((j) => pairedIds.has(j.task));
	const tally = { cBetter: 0, cWorse: 0, tie: 0, invalid: 0 };
	const split = {
		leaf: { cBetter: 0, cWorse: 0, tie: 0 },
		merge: { cBetter: 0, cWorse: 0, tie: 0 },
		withUser: { cBetter: 0, cWorse: 0, tie: 0 },
		noUser: { cBetter: 0, cWorse: 0, tie: 0 },
	};
	let firstIsH = 0;
	// Confounds a reader should see: a judge may favor the longer line or the line listed second.
	const byLength = { cLonger: { cBetter: 0, cWorse: 0, tie: 0 }, cNotLonger: { cBetter: 0, cWorse: 0, tie: 0 } };
	const byPosition = { listedFirstWon: 0, listedSecondWon: 0, tie: 0 };
	const finalBytes = { H: 0, C: 0 };
	for (const j of scored) {
		const task = byId.get(j.task)!;
		if (j.first === "H") firstIsH++;
		const bytesH = utf8Bytes(finished(j.task, "H")!.final ?? "");
		const bytesC = utf8Bytes(finished(j.task, "C")!.final ?? "");
		finalBytes.H += bytesH;
		finalBytes.C += bytesC;
		if (j.winner !== "invalid") {
			const outcome = j.winner === "C" ? "cBetter" : j.winner === "H" ? "cWorse" : "tie";
			byLength[bytesC > bytesH ? "cLonger" : "cNotLonger"][outcome]++;
			if (j.winner === "tie") byPosition.tie++;
			else byPosition[j.winner === j.first ? "listedFirstWon" : "listedSecondWon"]++;
		}
		if (j.winner === "invalid") {
			tally.invalid++;
			continue;
		}
		const key = j.winner === "C" ? "cBetter" : j.winner === "H" ? "cWorse" : "tie";
		tally[key]++;
		split[task.node][key]++;
		split[task.user ? "withUser" : "noUser"][key]++;
	}

	const judgeRows = spend.filter((row) => row.phase === "judge");
	const compressRows = spend.filter((row) => row.phase === "compress");
	const sum = (rows: SpendRow[]) => rows.reduce<{ usd: number; unknown: number }>((acc, row) => (row.costUsd === null ? { ...acc, unknown: acc.unknown + 1 } : { ...acc, usd: acc.usd + row.costUsd }), { usd: 0, unknown: 0 });
	const total = sum(spend);
	const judgeTotal = sum(judgeRows);
	const compressTotal = sum(compressRows);

	const meanH = mean(rate.H.promptCosts);
	const meanC = mean(rate.C.promptCosts);
	const violH = rate.H.first.replies;
	const violC = rate.C.first.replies;
	const rule = {
		pairwiseOk: tally.cWorse <= tally.cBetter,
		hardViolationsOk: violC <= violH,
		promptCostOk: meanH !== "unknown" && meanC !== "unknown" && meanC < meanH,
	};
	const complete = paired.length === tasks.length && rate.H.unknownCost === 0 && rate.C.unknownCost === 0;
	const report = {
		run,
		directory: dir,
		sourceRev: frozen.sourceRev,
		sample,
		frozen: {
			armCSystemPromptSha256: frozen.armC.systemPromptSha256,
			armHSystemPromptSha256: frozen.armH.systemPromptSha256,
			armHToolsSha256: frozen.armH.toolsSha256,
			armHToolsShared: frozen.armH.toolsShared,
			rubricSha256: frozen.rubricSha256,
			tasksSha256: frozen.tasksSha256,
			models: frozen.models,
			definitions: frozen.definitions,
		},
		completeTasks: paired.length,
		plannedTasks: tasks.length,
		arms,
		pairwise: {
			...tally,
			judged: scored.length,
			listedFirstWasH: firstIsH,
			split,
			byLength,
			byPosition,
			meanFinalBytes: { H: round(finalBytes.H / Math.max(1, scored.length), 1), C: round(finalBytes.C / Math.max(1, scored.length), 1) },
		},
		cost: {
			capUsd: 5,
			totalUsd: total.unknown > 0 ? "unknown" : round(total.usd, 4),
			knownUsd: round(total.usd, 4),
			compressUsd: round(compressTotal.usd, 4),
			judgeUsd: round(judgeTotal.usd, 4),
			callsWithUnknownCost: total.unknown,
		},
		rule: { ...rule, adoptC: complete && rule.pairwiseOk && rule.hardViolationsOk && rule.promptCostOk },
		complete,
		artifacts: {
			tasks: join(dir, "tasks.jsonl"),
			results: join(dir, "results.jsonl"),
			judgments: join(dir, "judgments.jsonl"),
			spend: join(dir, "spend.jsonl"),
			frozen: join(dir, "frozen.json"),
			hostPrefix: join(dir, "host-prefix.json"),
			snapshot: snapshot.dir,
		},
	};
	writeFileSync(join(dir, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
	console.log(JSON.stringify(report, null, 2));
}

if (import.meta.main) await main(process.argv.slice(2));
