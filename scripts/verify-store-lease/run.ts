#!/usr/bin/env bun
/**
 * One command for the store writer lease check: bun run verify:lease [--model-only | --real-only] [--traces] [--strict]
 *
 * Phase 1 model-checks scripts/verify-store-lease/StoreLease.tla with TLC (current code, broken variants, fixed designs).
 * Phase 2 drives the real src/store.ts with real processes (guarantees, open findings, deliberate breaks).
 * Exit 0: every guarantee holds, every break is caught, every recorded finding still reproduces.
 * Exit 1: a guarantee broke, a break went uncaught, a check could not run, or a recorded finding no longer reproduces.
 * Exit 2: --strict and the recorded findings are still open.
 * How to read the result and what to do with it: .omp/skills/verify-store-lease/SKILL.md.
 */
import type { Check, Status } from "./check.ts";
import { runModel, toolchain } from "./model.ts";
import { runReal } from "./real.ts";

const args = new Set(process.argv.slice(2));
const unknown = [...args].filter((arg) => !["--model-only", "--real-only", "--traces", "--strict"].includes(arg));
if (unknown.length > 0 || (args.has("--model-only") && args.has("--real-only"))) {
	console.error(`usage: bun run verify:lease [--model-only | --real-only] [--traces] [--strict]${unknown.length ? ` (unknown: ${unknown.join(" ")})` : ""}`);
	process.exit(64);
}

const LABEL: Record<Status, string> = { pass: "ok     ", fail: "FAIL   ", "open-finding": "FINDING", "finding-gone": "GONE   " };
const started = Date.now();
const seconds = (since: number): string => `${((Date.now() - since) / 1000).toFixed(1)}s`;

const all: Check[] = [];
const report = (title: string, checks: readonly Check[]): void => {
	console.log(`\n${title}`);
	for (const check of checks) {
		console.log(`  ${LABEL[check.status]} ${check.role.padEnd(9)} ${check.id}\n          ${check.claim}\n          ${check.detail}`);
		if (check.trace && (args.has("--traces") || check.status === "fail" || check.status === "finding-gone")) {
			check.trace.forEach((step, index) => console.log(`            ${String(index + 1).padStart(2)}. ${step}`));
		}
	}
	all.push(...checks);
};

if (!args.has("--real-only")) {
	const tools = await toolchain();
	console.log(`TLC: java via ${tools.via} (${tools.java}), ${tools.jar}`);
	const t0 = Date.now();
	const checks = await runModel(tools);
	report(`model: StoreLease.tla under TLC (${seconds(t0)})`, checks);
}
if (!args.has("--model-only")) {
	const t0 = Date.now();
	const checks = await runReal();
	report(`real code: src/store.ts with real processes (${seconds(t0)})`, checks);
}

const count = (status: Status): number => all.filter((check) => check.status === status).length;
const open = all.filter((check) => check.status === "open-finding");
console.log(
	`\n${count("pass")} ok, ${open.length} open findings, ${count("fail")} failed, ${count("finding-gone")} findings gone, in ${seconds(started)}`,
);
if (open.length > 0) console.log(`open findings: ${[...new Set(open.map((check) => check.claim.match(/\((F\d)\)/)?.[1] ?? check.id))].join(", ")}; rerun with --traces to read their counterexamples`);
if (count("finding-gone") > 0) console.log("a recorded finding no longer reproduces: the code was fixed. Follow `Update procedure` in the skill: make that property a guarantee and drop the finding.");

if (count("fail") > 0 || count("finding-gone") > 0) process.exit(1);
if (args.has("--strict") && open.length > 0) process.exit(2);
