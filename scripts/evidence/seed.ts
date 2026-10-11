import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Price, UsageRecord } from "./artifact.ts";
import { isRecord } from "./scoring.ts";

export interface SeedRecord {
	text: string;
	timestampMs: number;
}

// Writes the documented OMP session JSONL directly (header + message entries) rather than
// through the SDK SessionManager. SessionManager gates disk writes on an assistant message or
// an explicit ensureOnDisk(), so a user-only seeded session would not be materialized. The
// format below was verified to load via SessionManager.open with records in original order.
export async function writeSeededSession(options: {
	cwd: string;
	sessionDir: string;
	records: readonly SeedRecord[];
}): Promise<string> {
	const sessionDir = resolve(options.sessionDir);
	const timestamp = new Date().toISOString();
	const id = randomUUID();
	const header = { type: "session", version: 3, id, timestamp, cwd: resolve(options.cwd) };
	const lines: string[] = [JSON.stringify(header)];
	let parentId: string | null = null;
	for (const record of options.records) {
		const entryId = randomUUID().slice(0, 8);
		lines.push(
			JSON.stringify({
				type: "message",
				id: entryId,
				parentId,
				timestamp: new Date().toISOString(),
				message: { role: "user", content: [{ type: "text", text: record.text }], timestamp: record.timestampMs },
			}),
		);
		parentId = entryId;
	}
	await mkdir(sessionDir, { recursive: true });
	const file = join(sessionDir, `${timestamp.replace(/[:.]/g, "-")}_${id}.jsonl`);
	await writeFile(file, `${lines.join("\n")}\n`, { flag: "wx" });
	return file;
}

function parseSessionLines(text: string, file: string): Record<string, unknown>[] {
	return text
		.split("\n")
		.filter(line => line.length > 0)
		.map((line, index) => {
			try {
				return JSON.parse(line) as Record<string, unknown>;
			} catch (error) {
				throw new Error(`${file}: line ${index + 1} is not valid JSON: ${(error as Error).message}`);
			}
		});
}

// Counts compaction entries in a session file. Fails closed on malformed JSON rather than
// undercounting maintenance activity.
export async function readCompactionEvidence(sessionFile: string): Promise<{ compactionEntries: number }> {
	const entries = parseSessionLines(await readFile(sessionFile, "utf8"), sessionFile);
	return { compactionEntries: entries.filter(entry => entry.type === "compaction").length };
}

// Maintenance (compaction) usage is not observable for OMP 18.9.0: CompactionResult and
// CompactionEntry carry no model usage, and no RPC event reports compaction usage. So
// usageObservable is always false and callers must record maintenance usage as null with a
// limitation, never zero. Compaction events are still countable, so a run can prove whether
// maintenance occurred even though its cost cannot be metered.
export function maintenanceUsageState(events: readonly Record<string, unknown>[]): {
	compactions: number;
	usageObservable: false;
} {
	return {
		compactions: events.filter(event => event.type === "auto_compaction_start").length,
		usageObservable: false,
	};
}

const isNonNegativeFinite = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value) && value >= 0;

// Counters must be non-negative safe integers; anything else is unobserved, never zero.
const tokenCount = (value: unknown): number | null =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

// Reads every *.jsonl session file in sessionDir without writing to it. A missing directory has no
// auxiliary usage. Malformed JSON throws, as readCompactionEvidence does, rather than undercounting.
export async function readAuxiliaryUsage(sessionDir: string): Promise<UsageRecord[]> {
	const dir = resolve(sessionDir);
	let names: string[];
	try {
		names = await readdir(dir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const records: UsageRecord[] = [];
	for (const name of names.filter(entry => entry.endsWith(".jsonl")).sort()) {
		const file = join(dir, name);
		for (const entry of parseSessionLines(await readFile(file, "utf8"), file)) {
			if (entry.type !== "model_usage") continue;
			if (typeof entry.purpose !== "string") throw new Error(`${file}: model_usage entry has no string purpose`);
			const usage = isRecord(entry.usage) ? entry.usage : {};
			// SDK cost is reported only when finite and non-negative; otherwise it is unobserved.
			const total = isRecord(usage.cost) && isNonNegativeFinite(usage.cost.total) ? usage.cost.total : null;
			records.push({
				role: "auxiliary",
				purpose: entry.purpose,
				input: tokenCount(usage.input),
				output: tokenCount(usage.output),
				cacheRead: tokenCount(usage.cacheRead),
				cacheWrite: tokenCount(usage.cacheWrite),
				costUsd: total,
				costSource: total === null ? "unavailable" : "sdk-reported",
				latencyMs: null,
			});
		}
	}
	return records;
}

const UTF8_BYTES_PER_TOKEN = 4;

export interface MaintenanceEstimate {
	readonly compactions: number;
	readonly estimated: boolean;
	readonly costUsdLow: number | null;
	readonly costUsdHigh: number | null;
	/** Present only when the estimate is unavailable. */
	readonly reason?: string;
}

/**
 * Estimates maintenance (compaction) spend from captured auto_compaction_start/end events and the
 * session's compaction entry count. Each complete end frame bills tokensBefore as input (low at the
 * cache-read rate, high at the input rate) and ceil(UTF-8 bytes of summary / 4) as output. A frame's
 * optional `model` string prices that frame when known; otherwise mainModel prices it. Any unpaired,
 * incomplete, unpriceable, or count-mismatched frame yields an unavailable estimate with null bounds.
 * Zero observed compactions cost zero.
 *
 * OMP 18.9.1 can report `tokensBefore: 0` for a compaction that summarized real history. A zero is then
 * not a measurement: the low bound bills no input and the high bound bills `inputTokensCeiling` (the
 * compaction model's context window, which its request cannot exceed) at the dearest input-side rate.
 * Without a ceiling such a frame is unavailable.
 */
export function estimateMaintenanceUsage(input: {
	readonly compactionEntries: number;
	readonly events: readonly Record<string, unknown>[];
	readonly mainModel: string;
	readonly prices: Readonly<Record<string, Price>>;
	readonly inputTokensCeiling: number | null;
}): MaintenanceEstimate {
	const starts = input.events.filter(event => event.type === "auto_compaction_start").length;
	const ends = input.events.filter(event => event.type === "auto_compaction_end");
	const observed = Math.max(input.compactionEntries, starts, ends.length);
	const unavailable = (reason: string): MaintenanceEstimate => ({
		compactions: observed,
		estimated: false,
		costUsdLow: null,
		costUsdHigh: null,
		reason,
	});
	if (observed === 0) return { compactions: 0, estimated: false, costUsdLow: 0, costUsdHigh: 0 };

	let open = false;
	for (const event of input.events) {
		if (event.type === "auto_compaction_start") {
			if (open) return unavailable("compaction start without a closing end");
			open = true;
		} else if (event.type === "auto_compaction_end") {
			if (!open) return unavailable("compaction end without a start");
			open = false;
		}
	}
	if (open) return unavailable("compaction start without a closing end");
	if (ends.length !== input.compactionEntries) {
		return unavailable("captured compaction frames disagree with session compaction entries");
	}

	let low = 0;
	let high = 0;
	for (const end of ends) {
		const result = end.result;
		if (
			!isRecord(result) ||
			!isNonNegativeFinite(result.tokensBefore) ||
			typeof result.summary !== "string"
		) {
			return unavailable("compaction end carries no numeric tokensBefore and string summary");
		}
		const model = end.model === undefined ? input.mainModel : end.model;
		if (typeof model !== "string" || !Object.hasOwn(input.prices, model)) {
			return unavailable(`no known price for compaction model ${String(model)}`);
		}
		const price = input.prices[model];
		if (
			price === undefined ||
			![price.input, price.output, price.cacheRead, price.cacheWrite].every(isNonNegativeFinite)
		) {
			return unavailable(`no usable price for compaction model ${model}`);
		}
		const outputTokens = Math.ceil(Buffer.byteLength(result.summary, "utf8") / UTF8_BYTES_PER_TOKEN);
		if (result.tokensBefore === 0) {
			if (input.inputTokensCeiling === null) return unavailable("compaction end reports tokensBefore 0 and the input ceiling is unknown");
			low += (outputTokens * price.output) / 1e6;
			high += (input.inputTokensCeiling * Math.max(price.input, price.cacheWrite) + outputTokens * price.output) / 1e6;
			continue;
		}
		low += (result.tokensBefore * price.cacheRead + outputTokens * price.output) / 1e6;
		high += (result.tokensBefore * price.input + outputTokens * price.output) / 1e6;
	}
	return { compactions: ends.length, estimated: true, costUsdLow: low, costUsdHigh: high };
}
