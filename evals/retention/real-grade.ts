#!/usr/bin/env bun
/**
 * Blind grading for the real-chat view-size check.
 *
 *   bun evals/retention/real-grade.ts packets   --cases <private cases.json> --run <private run dir>
 *   bun evals/retention/real-grade.ts aggregate --run <private run dir> [--out <public result.json>]
 *
 * `packets` writes <run>/review/packets.json (what reviewers see: question, accepted label, wrong candidates and
 * the answer, under a random id, in random order) and <run>/review/mapping.json (private: packet id to trial).
 * Reviewers write <run>/review/grades-<name>.json: [{ packetId, correct, misleading }]. `adjudication.json`, in the
 * same form, settles packets on which two reviewers differ. `aggregate` refuses a packet with an open disagreement.
 * The public result holds counts only: no question, answer or label text.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { TrialRow } from "./real-run.ts";

interface Grade { readonly packetId: string; readonly correct: boolean; readonly misleading: boolean }

function rowsOf(run: string): TrialRow[] {
	return readFileSync(join(run, "results.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as TrialRow);
}

function option(name: string): string | null {
	const index = process.argv.indexOf(`--${name}`);
	return index < 0 ? null : process.argv[index + 1] ?? null;
}

function gradesOf(file: string): Map<string, Grade> {
	const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
	if (!Array.isArray(parsed)) throw new Error(`${file} is not a grade list`);
	const grades = new Map<string, Grade>();
	for (const item of parsed as Grade[]) {
		if (typeof item.packetId !== "string" || typeof item.correct !== "boolean" || typeof item.misleading !== "boolean") throw new Error(`${file} holds a malformed grade`);
		if (grades.has(item.packetId)) throw new Error(`${file} grades ${item.packetId} twice`);
		grades.set(item.packetId, item);
	}
	return grades;
}

/** Two-sided exact sign test over discordant pairs. */
export function signTest(a: number, b: number): number {
	const n = a + b;
	if (n === 0) return 1;
	const choose = (k: number): number => { let c = 1; for (let i = 0; i < k; i++) c = (c * (n - i)) / (i + 1); return c; };
	let tail = 0;
	for (let k = 0; k <= Math.min(a, b); k++) tail += choose(k);
	return Math.min(1, (2 * tail) / 2 ** n);
}

function packets(run: string, casesFile: string): void {
	const frozen: unknown = JSON.parse(readFileSync(casesFile, "utf8"));
	if (frozen === null || typeof frozen !== "object" || !("cases" in frozen) || !Array.isArray(frozen.cases)) throw new Error("not a frozen cases file");
	// The run already validated every case against the manifest (loadCorpus); only the fields shown to reviewers are read here.
	const list: Record<string, any>[] = frozen.cases;
	const cases = new Map(list.map((item) => [String(item.id), item]));
	const review = join(run, "review");
	mkdirSync(review, { mode: 0o700 });
	const rows = rowsOf(run);
	const mapping: { packetId: string; key: string }[] = [];
	const out = rows.map((row) => {
		const item = cases.get(row.caseId);
		if (!item) throw new Error(`no frozen case ${row.caseId}`);
		const packetId = randomUUID();
		mapping.push({ packetId, key: row.key });
		return {
			packetId,
			question: item.question as string,
			label: {
				status: item.answer.status as string,
				answer: item.answer.text as string,
				evidenceLevel: item.answer.evidenceLevel as string,
				support: (item.citations as { messageId: number; quote: string }[]).map((citation) => ({ messageId: citation.messageId, quote: citation.quote })),
				missingAnswerJustification: item.missingAnswerJustification ?? null,
				wrongCandidates: (item.wrongCandidates as { text: string; reason: string }[]).map((wrong) => ({ text: wrong.text, reason: wrong.reason })),
			},
			answer: row.status === "ok" ? row.answer : "[the trial failed: no answer]",
		};
	});
	// Random ids in id order: the order carries no trial, arm or repetition.
	out.sort((a, b) => a.packetId.localeCompare(b.packetId));
	writeFileSync(join(review, "packets.json"), JSON.stringify(out, null, 1), { flag: "wx", mode: 0o600 });
	writeFileSync(join(review, "mapping.json"), JSON.stringify(mapping), { flag: "wx", mode: 0o600 });
	console.log(JSON.stringify({ packets: out.length, file: join(review, "packets.json") }));
}

function aggregate(run: string, outFile: string | null): void {
	const review = join(run, "review");
	const mapping = JSON.parse(readFileSync(join(review, "mapping.json"), "utf8")) as { packetId: string; key: string }[];
	const reviewers = readdirSync(review).filter((name) => /^grades-.+\.json$/.test(name)).sort().map((name) => gradesOf(join(review, name)));
	if (reviewers.length < 2) throw new Error("two independent reviewers are required");
	const adjudication = existsSync(join(review, "adjudication.json")) ? gradesOf(join(review, "adjudication.json")) : new Map<string, Grade>();
	const rows = new Map(rowsOf(run).map((row) => [row.key, row]));
	let disagreements = 0;
	const final = new Map<string, Grade>();
	for (const { packetId, key } of mapping) {
		const grades = reviewers.map((reviewer) => {
			const grade = reviewer.get(packetId);
			if (!grade) throw new Error(`a reviewer left ${packetId} ungraded`);
			return grade;
		});
		const agree = grades.every((grade) => grade.correct === grades[0]!.correct && grade.misleading === grades[0]!.misleading);
		if (!agree) disagreements++;
		const settled = agree ? grades[0]! : adjudication.get(packetId);
		if (!settled) throw new Error(`reviewers differ on ${packetId} and no adjudication settles it`);
		// A failed trial is not correct, whatever a reviewer made of its placeholder.
		final.set(key, rows.get(key)!.status === "ok" ? settled : { packetId, correct: false, misleading: false });
	}
	const views = [...new Set([...rows.values()].map((row) => row.viewBytes))].sort((a, b) => b - a);
	const total = (values: readonly (number | null)[]): number | null => values.includes(null) ? null : (values as number[]).reduce((sum, value) => sum + value, 0);
	const median = (values: number[]): number => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)] ?? 0; };
	const arms = views.map((viewBytes) => {
		const mine = [...rows.values()].filter((row) => row.viewBytes === viewBytes);
		const grade = (row: TrialRow) => final.get(row.key)!;
		const perSource: Record<string, string> = {};
		for (const source of [...new Set(mine.map((row) => row.sourceId))].sort()) {
			const part = mine.filter((row) => row.sourceId === source);
			perSource[source] = `${part.filter((row) => grade(row).correct).length}/${part.length}`;
		}
		return {
			viewBytes,
			trials: mine.length,
			failed: mine.filter((row) => row.status !== "ok").length,
			correct: mine.filter((row) => grade(row).correct).length,
			misleading: mine.filter((row) => grade(row).misleading).length,
			correctBySource: perSource,
			mainCostUsd: total(mine.map((row) => row.main.costUsd)),
			compressorCostUsd: total(mine.map((row) => row.compressor.costUsd)),
			judgeCalls: mine.reduce((sum, row) => sum + row.judge.dispatched, 0),
			judgeRefused: mine.reduce((sum, row) => sum + row.judge.refused, 0),
			judgeDiagnosticUsd: total(mine.map((row) => row.judge.diagnosticUsd)),
			mainCalls: mine.reduce((sum, row) => sum + row.main.calls, 0),
			promptTokens: total(mine.map((row) => row.main.input === null || row.main.cacheRead === null || row.main.cacheWrite === null ? null : row.main.input + row.main.cacheRead + row.main.cacheWrite)),
			toolCalls: mine.reduce((sum, row) => sum + row.tools.length, 0),
			medianViewLines: median(mine.flatMap((row) => row.view ? [row.view.parts] : [])),
			medianLatencyMs: median(mine.map((row) => row.latencyMs)),
		};
	});
	const result: Record<string, unknown> = { schemaVersion: 1, packets: mapping.length, reviewers: reviewers.length, disagreements, adjudicated: adjudication.size, arms, chargedUsd: total([...rows.values()].map((row) => row.chargedUsd)) };
	if (views.length === 2) {
		const [large, small] = views as [number, number];
		// Case level: an arm wins a case when it has more correct repetitions.
		const score = (caseId: string, viewBytes: number) => [...rows.values()].filter((row) => row.caseId === caseId && row.viewBytes === viewBytes && final.get(row.key)!.correct).length;
		let largeWins = 0, smallWins = 0, ties = 0;
		for (const caseId of new Set([...rows.values()].map((row) => row.caseId))) {
			const diff = score(caseId, large) - score(caseId, small);
			if (diff > 0) largeWins++; else if (diff < 0) smallWins++; else ties++;
		}
		const [a, b] = arms as [typeof arms[number], typeof arms[number]];
		const saving = a.mainCostUsd === null || b.mainCostUsd === null || a.mainCostUsd === 0 ? null : 1 - b.mainCostUsd / a.mainCostUsd;
		result.comparison = {
			large, small, caseWins: { large: largeWins, small: smallWins, ties }, signTestP: signTest(largeWins, smallWins),
			correctLostBySmall: a.correct - b.correct, misleadingAddedBySmall: b.misleading - a.misleading, mainCostSaving: saving,
			passes: a.correct - b.correct <= 2 && b.misleading - a.misleading <= 1 && saving !== null && saving >= 0.15,
		};
	}
	const text = JSON.stringify(result, null, 2);
	if (outFile !== null) writeFileSync(resolve(outFile), `${text}\n`);
	console.log(text);
}

if (import.meta.main) {
	const run = option("run");
	if (run === null) throw new Error("--run is required");
	if (process.argv[2] === "packets") {
		const cases = option("cases");
		if (cases === null) throw new Error("--cases is required");
		packets(resolve(run), resolve(cases));
	} else if (process.argv[2] === "aggregate") aggregate(resolve(run), option("out"));
	else throw new Error("first argument must be packets or aggregate");
}
