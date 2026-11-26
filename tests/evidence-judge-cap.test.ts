import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Judge } from "@oh-my-pi/pi-ai";
import { cappedJudge, initialJudgeCap, parseJudgeCap } from "../scripts/evidence/judge-cap.ts";

function counterFile(): string {
	const file = join(mkdtempSync(join(tmpdir(), "judge-cap-")), "judge.json");
	writeFileSync(file, JSON.stringify(initialJudgeCap()));
	return file;
}

test("a capped judge sends at most its allowance and refuses the rest without calling the judge", async () => {
	let sent = 0;
	const inner = {
		label: "fake",
		sessionFallback: true,
		primaryModel: () => ({ provider: "p", id: "m" }),
		judge: async () => {
			sent++;
			return { answers: {}, model: "p/m", usage: { cost: { total: 0.002 } } };
		},
	} as unknown as Judge & { sessionFallback: boolean; primaryModel(): { provider: string; id: string } };
	const file = counterFile();
	const capped = cappedJudge(inner, file, 2);
	const request = { state: {}, questions: {} } as never;
	await capped.judge(request);
	await capped.judge(request);
	await expect(capped.judge(request)).rejects.toThrow("allowance is spent");
	expect(sent).toBe(2);
	expect(parseJudgeCap(JSON.parse(readFileSync(file, "utf8")))).toEqual({ dispatched: 2, refused: 1, returned: 2, diagnosticUsd: [0.002, 0.002], models: ["p/m", "p/m"] });
	// OptChat reads these to decide whether a gate may run.
	expect(capped.sessionFallback).toBe(true);
	expect(capped.primaryModel()).toEqual({ provider: "p", id: "m" });
});

test("a judge call that throws stays counted as dispatched, with no cost recorded as zero", async () => {
	const inner: Judge = { label: "fake", judge: async () => { throw new Error("provider down"); } };
	const file = counterFile();
	await expect(cappedJudge(inner, file, 5).judge({ state: {}, questions: {} } as never)).rejects.toThrow("provider down");
	expect(parseJudgeCap(JSON.parse(readFileSync(file, "utf8")))).toEqual({ dispatched: 1, refused: 0, returned: 0, diagnosticUsd: [], models: [] });
});
