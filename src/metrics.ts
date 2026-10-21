import { closeSync, openSync, readFileSync, writeSync } from "node:fs";
import { Buffer } from "node:buffer";
import type { CompactionRequest } from "./memory.js";

/**
 * The store's metric sink: one `MetricRow` per line, counts only, appended by OptChat by default. Rows carry a `type`
 * discriminator; a line without one predates it and is a compressor row.
 */
export const METRICS_FILE = "metrics.jsonl";

/** Metrics for one completed compressor provider call (`type: "compressor"`). Never carries message content or credentials. */
export interface CompressorUsage {
	readonly type: "compressor";
	/** When the call completed, as an ISO-8601 UTC timestamp. */
	readonly at: string;
	readonly model: string;
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	/** What the node is: a message's leaf (including each page of a long one) or a merge of two lines. */
	readonly node: CompactionRequest["meta"]["node"];
	/** 1-based attempt within one `compact()` call: the first is 1, each retry adds one. */
	readonly attempt: number;
	/** Why this attempt is a retry (the previous attempt's defect); null on the first attempt. */
	readonly retry: CompactionRequest["meta"]["retry"];
	/** Time spent waiting before the request was sent: admission and the cache lease, summed over provider attempts. */
	readonly waitMs: number;
	/** Provider time only: the call's wall time without `waitMs`. */
	readonly latencyMs: number;
	/** The host's reported cost, or null when the host reports none. */
	readonly costUsd: number | null;
	/** Provider stop reason of the reply ("stop", "length", "error", ...). */
	readonly stopReason: string;
	/** Provider error text when the call failed, without control characters and at most 200 characters; never request content. */
	readonly error: string | null;
}

/** How OptChat answered one host compaction: the fixed marker at the host's cut, the marker with the cut moved to the open turn, or a cancel. */
export type HostCompactionOutcome = "marker" | "cut-moved" | "cut-in-turn" | "cancelled";

/** Why a host compaction was cancelled: a closed vocabulary, never message content. */
export type HostCompactionCancelReason =
	| "not-ready"
	| "nothing-older"
	| "leftover-summary"
	| "anchor-not-cut-point"
	| "anchor-not-in-branch";

/** One host compaction request and its answer (`type: "host-compaction"`). */
export interface HostCompactionRow {
	readonly type: "host-compaction";
	readonly at: string;
	readonly outcome: HostCompactionOutcome;
	/** Set exactly when `outcome` is "cancelled". */
	readonly reason: HostCompactionCancelReason | null;
	/** The host's token count before the compaction; null when the host gave none. */
	readonly tokensBefore: number | null;
}

/** One rules-gate triage of a user message (`type: "rules"`): probabilities and the decision, never the message or any rule text. */
export interface RulesRow {
	readonly type: "rules";
	readonly at: string;
	/** P(rule) of the whole message; null when the judge's answer is missing or malformed. */
	readonly pRule: number | null;
	/** The highest P(rule) over the message's sentences; null when the message was judged as one sentence or no sentence answer is usable. */
	readonly pSentenceMax: number | null;
	/** How many sentences were judged one by one (0 or 1 when the message was judged whole). */
	readonly sentences: number;
	/** The `--optchat-rule-add` threshold in force. */
	readonly cutoff: number;
	/** A rule was written: added, or replacing an earlier one. */
	readonly added: boolean;
}

/** Every row type the sink holds. */
export type MetricRow = CompressorUsage | HostCompactionRow | RulesRow;

/** Bounds provider error text for diagnostics: control characters removed, at most 200 characters. */
export function boundedProviderError(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const text = value.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim();
	return text ? text.slice(0, 200) : null;
}

/**
 * Whether a parsed sink line is a compressor row: it says `type: "compressor"`, or it carries no `type` (written before rows
 * were typed). Every reader that counts compressor calls or sums their cost must filter with this.
 */
export function isCompressorRow(value: unknown): boolean {
	if (value === null || typeof value !== "object" || !("type" in value)) return true;
	return value.type === "compressor";
}

/** Compressor calls recorded in a metric sink, with the host's reported cost summed. */
export interface CompressorSpend {
	readonly calls: number;
	/** Sum of the reported `costUsd` values; calls without one are counted in `unknownCost`, never as zero. */
	readonly reportedUsd: number;
	readonly unknownCost: number;
}

/**
 * Sums a metric sink's compressor rows; host-compaction and rules rows are not calls. A missing file is zero calls. A line
 * that does not parse (a torn final append) or carries no finite `costUsd` is still one call, with unknown cost. Other read
 * failures throw.
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
		let cost: unknown;
		try {
			const value: unknown = JSON.parse(line);
			if (!isCompressorRow(value)) continue;
			cost = value && typeof value === "object" && "costUsd" in value ? value.costUsd : null;
		} catch {
			cost = null;
		}
		calls++;
		if (typeof cost === "number" && Number.isFinite(cost)) reportedUsd += cost;
		else unknownCost++;
	}
	return { calls, reportedUsd, unknownCost };
}

/** Append one JSON line with O_APPEND, creating the file with mode 0600. Best effort: the caller reports failures. */
export function appendMetric(path: string, row: MetricRow): void {
	const bytes = Buffer.from(`${JSON.stringify(row)}\n`, "utf8");
	const fd = openSync(path, "a", 0o600);
	try {
		let written = 0;
		while (written < bytes.length) written += writeSync(fd, bytes, written, bytes.length - written);
	} finally {
		closeSync(fd);
	}
}
