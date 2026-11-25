#!/usr/bin/env bun
/**
 * Offline retention report over `evidence:recall` artifacts. Calls no model and starts no host.
 *
 *   bun run scripts/evidence-retention.ts [--out report.json [--force]] <artifact.json>...
 *
 * Retention is the on arm's correct answers as a share of the off arm's, on the same questions, in runs where the off
 * arm read the whole seeded history without compacting. The two arms may come from one artifact or from two that ran
 * the same corpus. On arms that share a corpus and differ in `--view-bytes` are also compared with each other. Rows
 * pool seeds only; models, turn mode and corpus shape must match.
 */
import { readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { readArtifact, renderReport, retentionReport } from "./evidence/retention.ts";

const USAGE = "Usage: bun run scripts/evidence-retention.ts [--out <report.json> [--force]] <artifact.json>...";

async function main(argv: readonly string[]): Promise<void> {
	const files: string[] = [];
	let out: string | null = null;
	let force = false;
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index]!;
		if (arg === "--force") force = true;
		else if (arg === "--out") {
			const value = argv[++index];
			if (value === undefined || out !== null) throw new Error("--out takes one file, once");
			out = value;
		} else if (arg.startsWith("--")) throw new Error(`unknown flag ${arg}`);
		else files.push(arg);
	}
	if (files.length === 0) throw new Error("no artifact given");
	if (out !== null && !force && (await stat(resolve(out)).then(() => true, () => false))) throw new Error(`refusing to overwrite ${out}; pass --force`);

	const artifacts = await Promise.all(files.map(async (file) => readArtifact(JSON.parse(await readFile(resolve(file), "utf8")), file)));
	for (const note of artifacts.flatMap((artifact) => artifact.incomplete)) console.error(`Left out: ${note}`);
	const report = retentionReport(artifacts.flatMap((artifact) => artifact.sides));
	if (out !== null) await writeFile(resolve(out), `${JSON.stringify(report, null, 2)}\n`);
	process.stdout.write(renderReport(report));
}

try {
	await main(Bun.argv.slice(2));
} catch (caught) {
	console.error(caught instanceof Error ? caught.message : String(caught));
	console.error(USAGE);
	process.exit(1);
}
