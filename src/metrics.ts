import { closeSync, openSync, readFileSync, writeSync } from "node:fs";
import { Buffer } from "node:buffer";

/** The store's compressor metric sink: one `CompressorUsage` per line, counts only, appended by OptChat by default. */
export const METRICS_FILE = "metrics.jsonl";

/** Metrics for one completed compressor provider call. Never carries message content or credentials. */
export interface CompressorUsage {
	readonly model: string;
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	/** 1-based shortening attempt: prior feedback rounds plus one. */
	readonly attempt: number;
	/** "shorten" when the request carries prior feedback; otherwise "leaf". */
	readonly purpose: "leaf" | "shorten";
	readonly latencyMs: number;
	/** The host's reported cost, or null when the host reports none. */
	readonly costUsd: number | null;
	/** Provider stop reason of the reply ("stop", "length", "error", ...). */
	readonly stopReason: string;
	/** Provider error text when the call failed, without control characters and at most 200 characters; never request content. */
	readonly error: string | null;
}

/** Bounds provider error text for diagnostics: control characters removed, at most 200 characters. */
export function boundedProviderError(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const text = value.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim();
	return text ? text.slice(0, 200) : null;
}

/** Compressor calls recorded in a metric sink, with the host's reported cost summed. */
export interface CompressorSpend {
	readonly calls: number;
	/** Sum of the reported `costUsd` values; calls without one are counted in `unknownCost`, never as zero. */
	readonly reportedUsd: number;
	readonly unknownCost: number;
}

/**
 * Sums a metric sink. A missing file is zero calls. A line that does not parse (a torn final append) or carries no
 * finite `costUsd` is still one call, with unknown cost. Other read failures throw.
 */
export function readCompressorSpend(path: string): CompressorSpend {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return { calls: 0, reportedUsd: 0, unknownCost: 0 };
		throw error;
	}
	let calls = 0;
	let reportedUsd = 0;
	let unknownCost = 0;
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		calls++;
		let cost: unknown;
		try {
			const value: unknown = JSON.parse(line);
			cost = value && typeof value === "object" && "costUsd" in value ? value.costUsd : null;
		} catch {
			cost = null;
		}
		if (typeof cost === "number" && Number.isFinite(cost)) reportedUsd += cost;
		else unknownCost++;
	}
	return { calls, reportedUsd, unknownCost };
}

/** Append one JSON line with O_APPEND, creating the file with mode 0600. Best effort: the caller reports failures. */
export function appendMetric(path: string, usage: CompressorUsage): void {
	const bytes = Buffer.from(`${JSON.stringify(usage)}\n`, "utf8");
	const fd = openSync(path, "a", 0o600);
	try {
		let written = 0;
		while (written < bytes.length) written += writeSync(fd, bytes, written, bytes.length - written);
	} finally {
		closeSync(fd);
	}
}
