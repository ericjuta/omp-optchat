import { describe, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent";
import { HOST_COMPACTION_SUMMARY } from "../src/prompts.ts";
import {
	estimateMaintenanceUsage,
	maintenanceUsageState,
	readAuxiliaryUsage,
	readCompactionEvidence,
	writeSeededSession,
} from "../scripts/evidence/seed.ts";

// Shape of the session lines this test writes or reads back. Parsed JSON is trusted here
// because the writer under test produced it.
interface UserMessageBody {
	role: string;
	content: { type: string; text: string }[];
	timestamp: number;
}

interface SessionLine {
	type: string;
	id?: string;
	parentId?: string | null;
	cwd?: string;
	version?: number;
	message?: UserMessageBody;
}

const RECORDS = [
	{ text: "first record: the zebra is green", timestampMs: 1_700_000_000_001 },
	{ text: "second record: the anchor is 42", timestampMs: 1_700_000_000_002 },
	{ text: 'third record: quote with "quotes" and\nnewline', timestampMs: 1_700_000_000_003 },
];

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "optchat-seed-"));
	try {
		await run(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

async function readLines(file: string): Promise<SessionLine[]> {
	const text = await readFile(file, "utf8");
	return text
		.split("\n")
		.filter(line => line.length > 0)
		.map(line => JSON.parse(line) as SessionLine);
}

describe("off-arm seeded session", () => {
	test("round-trips records in order with exact text", async () => {
		await withTempDir(async dir => {
			const sessionDir = join(dir, "sessions");
			const file = await writeSeededSession({ cwd: dir, sessionDir, records: RECORDS });

			expect(file.startsWith(sessionDir)).toBe(true);
			expect(file.endsWith(".jsonl")).toBe(true);

			const [header, ...entries] = await readLines(file);
			expect(header).toMatchObject({ type: "session", version: 3, cwd: dir });
			expect(entries.map(entry => entry.type)).toEqual(["message", "message", "message"]);

			const messages = entries.map(entry => entry.message);
			expect(messages.map(message => message?.role)).toEqual(["user", "user", "user"]);
			expect(messages.map(message => message?.content[0]?.text)).toEqual(RECORDS.map(record => record.text));
			expect(messages.map(message => message?.timestamp)).toEqual(RECORDS.map(record => record.timestampMs));

			expect(entries[0]?.parentId).toBeNull();
			expect(entries[1]?.parentId).toBe(entries[0]?.id);
			expect(entries[2]?.parentId).toBe(entries[1]?.id);
		});
	});

	test("loads through the host SessionManager in the same order", async () => {
		await withTempDir(async dir => {
			const sessionDir = join(dir, "sessions");
			const file = await writeSeededSession({ cwd: dir, sessionDir, records: RECORDS });
			const manager = await SessionManager.open(file, sessionDir);
			const texts = manager.buildSessionContext().messages.map(message => {
				if (message.role !== "user" || typeof message.content === "string") return undefined;
				const first = message.content[0];
				return first?.type === "text" ? first.text : undefined;
			});
			expect(texts).toEqual(RECORDS.map(record => record.text));
		});
	});

	test("writes an empty-history session with only a header", async () => {
		await withTempDir(async dir => {
			const file = await writeSeededSession({ cwd: dir, sessionDir: join(dir, "sessions"), records: [] });
			const lines = await readLines(file);
			expect(lines).toHaveLength(1);
			expect(lines[0]).toMatchObject({ type: "session", version: 3 });
		});
	});

	test("compaction evidence is zero for a fresh session", async () => {
		await withTempDir(async dir => {
			const file = await writeSeededSession({ cwd: dir, sessionDir: join(dir, "sessions"), records: RECORDS });
			expect(await readCompactionEvidence(file)).toEqual({ compactionEntries: 0 });
		});
	});

	test("compaction evidence counts compaction entries", async () => {
		await withTempDir(async dir => {
			const file = await writeSeededSession({ cwd: dir, sessionDir: join(dir, "sessions"), records: RECORDS });
			const compaction = { type: "compaction", id: "c1", parentId: null, timestamp: new Date().toISOString(), summary: "s" };
			await appendFile(file, `${JSON.stringify(compaction)}\n`);
			expect(await readCompactionEvidence(file)).toEqual({ compactionEntries: 1 });
		});
	});

	test("compaction evidence fails closed on malformed JSON", async () => {
		await withTempDir(async dir => {
			const file = await writeSeededSession({ cwd: dir, sessionDir: join(dir, "sessions"), records: RECORDS });
			await appendFile(file, "{not json\n");
			await expect(readCompactionEvidence(file)).rejects.toThrow(/not valid JSON/);
		});
	});

	test("maintenanceUsageState counts compaction starts and is never observable", () => {
		const events = [
			{ type: "agent_start" },
			{ type: "auto_compaction_start" },
			{ type: "auto_compaction_end" },
			{ type: "auto_compaction_start" },
		];
		expect(maintenanceUsageState(events)).toEqual({ compactions: 2, usageObservable: false });
		expect(maintenanceUsageState([])).toEqual({ compactions: 0, usageObservable: false });
	});
});

function jsonl(lines: readonly unknown[]): string {
	return `${lines.map(line => JSON.stringify(line)).join("\n")}\n`;
}

describe("auxiliary usage", () => {
	test("returns no records for a missing directory", async () => {
		await withTempDir(async dir => {
			expect(await readAuxiliaryUsage(join(dir, "absent"))).toEqual([]);
		});
	});

	test("maps model_usage entries across every jsonl file and never writes", async () => {
		await withTempDir(async dir => {
			const sessionDir = join(dir, "aux");
			await mkdir(sessionDir, { recursive: true });
			await writeFile(
				join(sessionDir, "a.jsonl"),
				jsonl([
					{ type: "model_usage", purpose: "summarize", usage: { input: 100, output: 20, cacheRead: 5, cacheWrite: 1, cost: { total: 0.25 } } },
					{ type: "message", role: "user" },
				]),
			);
			await writeFile(
				join(sessionDir, "b.jsonl"),
				jsonl([{ type: "model_usage", purpose: "title", usage: { input: 7, cost: { total: "0.1" } } }]),
			);
			await writeFile(join(sessionDir, "notes.txt"), "not a session");
			const before = await readFile(join(sessionDir, "a.jsonl"), "utf8");

			expect(await readAuxiliaryUsage(sessionDir)).toEqual([
				{
					role: "auxiliary",
					purpose: "summarize",
					input: 100,
					output: 20,
					cacheRead: 5,
					cacheWrite: 1,
					costUsd: 0.25,
					costSource: "sdk-reported",
					latencyMs: null,
				},
				{
					role: "auxiliary",
					purpose: "title",
					input: 7,
					output: null,
					cacheRead: null,
					cacheWrite: null,
					costUsd: null,
					costSource: "unavailable",
					latencyMs: null,
				},
			]);
			expect(await readFile(join(sessionDir, "a.jsonl"), "utf8")).toBe(before);
			expect((await readdir(sessionDir)).sort()).toEqual(["a.jsonl", "b.jsonl", "notes.txt"]);
		});
	});

	test("throws on malformed JSON in any session file", async () => {
		await withTempDir(async dir => {
			await writeFile(join(dir, "bad.jsonl"), "{not json\n");
			await expect(readAuxiliaryUsage(dir)).rejects.toThrow(/not valid JSON/);
		});
	});
});

const PRICES = {
	"main-model": { input: 10, output: 20, cacheRead: 1, cacheWrite: 12.5 },
	"other-model": { input: 3, output: 6, cacheRead: 0.3, cacheWrite: 3.75 },
};

const START = { type: "auto_compaction_start" };

describe("maintenance estimate", () => {
	test("zero observed compactions cost zero and are not estimated", () => {
		expect(estimateMaintenanceUsage({ compactionEntries: 0, events: [], mainModel: "main-model", prices: PRICES, inputTokensCeiling: 200_000 })).toEqual({
			compactions: 0,
			estimated: false,
			costUsdLow: 0,
			costUsdHigh: 0,
		});
	});

	test("bounds a complete frame between cache-read and input rates plus output", () => {
		// "abcdefghi" is 9 UTF-8 bytes, so 3 output tokens.
		const events = [START, { type: "auto_compaction_end", result: { tokensBefore: 1000, summary: "abcdefghi" } }];
		const estimate = estimateMaintenanceUsage({ compactionEntries: 1, events, mainModel: "main-model", prices: PRICES, inputTokensCeiling: 200_000 });
		expect(estimate).toMatchObject({ compactions: 1, estimated: true });
		expect(estimate.costUsdLow).toBeCloseTo((1000 * 1 + 3 * 20) / 1e6, 12);
		expect(estimate.costUsdHigh).toBeCloseTo((1000 * 10 + 3 * 20) / 1e6, 12);
	});

	test("counts summary output as ceil of UTF-8 bytes over four", () => {
		// "ééééé" is 5 characters but 10 UTF-8 bytes, so ceil(10 / 4) = 3 output tokens.
		const events = [START, { type: "auto_compaction_end", result: { tokensBefore: 1, summary: "ééééé" } }];
		const estimate = estimateMaintenanceUsage({ compactionEntries: 1, events, mainModel: "main-model", prices: PRICES, inputTokensCeiling: 200_000 });
		expect(estimate.costUsdLow).toBeCloseTo((1 * 1 + 3 * 20) / 1e6, 12);
		expect(estimate.costUsdHigh).toBeCloseTo((1 * 10 + 3 * 20) / 1e6, 12);
	});

	test("a reported tokensBefore of zero is not a measurement: input is bounded by the context window, or unavailable", () => {
		const events = [START, { type: "auto_compaction_end", result: { tokensBefore: 0, summary: "abcdefghi" } }];
		const bounded = estimateMaintenanceUsage({ compactionEntries: 1, events, mainModel: "main-model", prices: PRICES, inputTokensCeiling: 200_000 });
		expect(bounded).toMatchObject({ compactions: 1, estimated: true });
		expect(bounded.costUsdLow).toBeCloseTo((3 * 20) / 1e6, 12);
		expect(bounded.costUsdHigh).toBeCloseTo((200_000 * 12.5 + 3 * 20) / 1e6, 12);
		const unknown = estimateMaintenanceUsage({ compactionEntries: 1, events, mainModel: "main-model", prices: PRICES, inputTokensCeiling: null });
		expect(unknown).toMatchObject({ estimated: false, costUsdLow: null, costUsdHigh: null });
	});

	test("an OptChat marker frame costs exactly zero, even with no known price, and still counts as a compaction", () => {
		const events = [START, { type: "auto_compaction_end", model: "mystery", result: { tokensBefore: 90_000, summary: HOST_COMPACTION_SUMMARY } }];
		expect(estimateMaintenanceUsage({ compactionEntries: 1, events, mainModel: "main-model", prices: PRICES, inputTokensCeiling: null })).toEqual({
			compactions: 1,
			estimated: true,
			costUsdLow: 0,
			costUsdHigh: 0,
		});
	});

	test("a marker frame mixed with a native frame prices only the native one", () => {
		const events = [
			START,
			{ type: "auto_compaction_end", result: { tokensBefore: 90_000, summary: HOST_COMPACTION_SUMMARY } },
			START,
			{ type: "auto_compaction_end", result: { tokensBefore: 1000, summary: "abcdefghi" } },
		];
		const estimate = estimateMaintenanceUsage({ compactionEntries: 2, events, mainModel: "main-model", prices: PRICES, inputTokensCeiling: 200_000 });
		expect(estimate).toMatchObject({ compactions: 2, estimated: true });
		expect(estimate.costUsdLow).toBeCloseTo((1000 * 1 + 3 * 20) / 1e6, 12);
		expect(estimate.costUsdHigh).toBeCloseTo((1000 * 10 + 3 * 20) / 1e6, 12);
	});

	test("a marker frame does not excuse an incomplete frame or a count mismatch", () => {
		const marker = { type: "auto_compaction_end", result: { tokensBefore: 1, summary: HOST_COMPACTION_SUMMARY } };
		const mismatch = estimateMaintenanceUsage({ compactionEntries: 2, events: [START, marker], mainModel: "main-model", prices: PRICES, inputTokensCeiling: 200_000 });
		expect(mismatch).toMatchObject({ estimated: false, costUsdLow: null, costUsdHigh: null });
		const unknownNative = estimateMaintenanceUsage({
			compactionEntries: 2,
			events: [START, marker, START, { type: "auto_compaction_end", model: "mystery", result: { tokensBefore: 1, summary: "x" } }],
			mainModel: "main-model",
			prices: PRICES,
			inputTokensCeiling: 200_000,
		});
		expect(unknownNative).toMatchObject({ estimated: false, costUsdLow: null, costUsdHigh: null });
	});

	test("a frame naming a known model is priced at that model", () => {
		const events = [START, { type: "auto_compaction_end", model: "other-model", result: { tokensBefore: 1000, summary: "abcdefghi" } }];
		const estimate = estimateMaintenanceUsage({ compactionEntries: 1, events, mainModel: "main-model", prices: PRICES, inputTokensCeiling: 200_000 });
		expect(estimate.costUsdLow).toBeCloseTo((1000 * 0.3 + 3 * 6) / 1e6, 12);
		expect(estimate.costUsdHigh).toBeCloseTo((1000 * 3 + 3 * 6) / 1e6, 12);
	});

	test("a frame naming an unknown model refuses the estimate", () => {
		const events = [START, { type: "auto_compaction_end", model: "mystery", result: { tokensBefore: 1000, summary: "x" } }];
		const estimate = estimateMaintenanceUsage({ compactionEntries: 1, events, mainModel: "main-model", prices: PRICES, inputTokensCeiling: 200_000 });
		expect(estimate).toMatchObject({ compactions: 1, estimated: false, costUsdLow: null, costUsdHigh: null });
		expect(estimate.reason).toMatch(/mystery/);
	});

	test("an unpaired start is unobserved", () => {
		const estimate = estimateMaintenanceUsage({ compactionEntries: 0, events: [START], mainModel: "main-model", prices: PRICES, inputTokensCeiling: 200_000 });
		expect(estimate).toMatchObject({ compactions: 1, estimated: false, costUsdLow: null, costUsdHigh: null });
	});

	test("a frame without numeric tokensBefore or string summary is unobserved", () => {
		const events = [START, { type: "auto_compaction_end", result: { tokensBefore: "1000", summary: "x" } }];
		const estimate = estimateMaintenanceUsage({ compactionEntries: 1, events, mainModel: "main-model", prices: PRICES, inputTokensCeiling: 200_000 });
		expect(estimate).toMatchObject({ estimated: false, costUsdLow: null, costUsdHigh: null });
	});

	test("frames that disagree with session compaction entries are unobserved", () => {
		const events = [START, { type: "auto_compaction_end", result: { tokensBefore: 1000, summary: "x" } }];
		const estimate = estimateMaintenanceUsage({ compactionEntries: 2, events, mainModel: "main-model", prices: PRICES, inputTokensCeiling: 200_000 });
		expect(estimate).toMatchObject({ estimated: false, costUsdLow: null, costUsdHigh: null });
	});
});
