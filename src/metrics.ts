import { closeSync, openSync, writeSync } from "node:fs";
import { Buffer } from "node:buffer";

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
}

/** Append one JSON line with O_APPEND. Best effort: the caller reports failures. */
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
