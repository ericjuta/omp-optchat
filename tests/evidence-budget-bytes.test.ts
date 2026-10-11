import { describe, expect, test } from "bun:test";
import { DEFAULT_PAGE_BYTES } from "../src/archive.ts";
import { SYSTEM_BLOCK } from "../src/index.ts";
import { compressorCallBoundUsd, compressorPromptBytes, SYSTEM_BLOCK_BYTES, TOOL_SCHEMA_BYTES, type CompactorLayout, type ModelRates } from "../scripts/evidence/cost.ts";

// Product defaults: the runner's COMPACTOR_LAYOUT. Page and node sizes come from src; the view budget is the compactor default.
const LAYOUT: CompactorLayout = { nodeBytes: 512, pageBytes: 16_384, compactionViewBytes: 32_000 };
// Haiku-class rates: contextWindow 200k, dearest input-side rate is the cache write at 1.25.
const HAIKU: ModelRates = { inputRate: 1, outputRate: 5, cacheReadRate: 0.1, cacheWriteRate: 1.25, contextWindow: 200_000, maxOutput: 64_000 };

describe("source constants the bounds depend on", () => {
	test("the system block length matches src/index.ts SYSTEM_BLOCK", () => {
		expect(SYSTEM_BLOCK_BYTES).toBe(Buffer.byteLength(SYSTEM_BLOCK, "utf8"));
	});

	test("the zoom page size matches src/archive.ts DEFAULT_PAGE_BYTES", () => {
		expect(LAYOUT.pageBytes).toBe(DEFAULT_PAGE_BYTES);
	});

	test("the tool allowance is a fixed 32 KiB", () => {
		expect(TOOL_SCHEMA_BYTES).toBe(32 * 1024);
	});
});

describe("compressor prompt bytes", () => {
	test("at product defaults the compressor prompt is the system bytes plus 86924 compactor bytes", () => {
		// view 36096 + batch 33657 + shorten 17171 = 86924 bytes of compactor prompts at default layout.
		expect(compressorPromptBytes(13_239, LAYOUT)).toBe(13_239 + 86_924);
	});

	test("the bytes grow with the view budget, the page size, and the node size", () => {
		const base = compressorPromptBytes(1000, LAYOUT);
		expect(compressorPromptBytes(1000, { ...LAYOUT, compactionViewBytes: 64_000 })).toBeGreaterThan(base);
		expect(compressorPromptBytes(1000, { ...LAYOUT, pageBytes: 32_768 })).toBeGreaterThan(base);
		expect(compressorPromptBytes(1000, { ...LAYOUT, nodeBytes: 1024 })).toBeGreaterThan(base);
		expect(compressorPromptBytes(2000, LAYOUT)).toBe(base + 1000);
	});

	test("invalid system bytes or layout are programming errors", () => {
		expect(() => compressorPromptBytes(-1, LAYOUT)).toThrow("non-negative");
		expect(() => compressorPromptBytes(0, { ...LAYOUT, pageBytes: 0 })).toThrow("positive");
	});
});

describe("compressor per-call bound", () => {
	test("prices the byte bound at the dearest input rate plus the compressor output cap", () => {
		const bytes = compressorPromptBytes(13_239, LAYOUT);
		const expected = (bytes * 1.25 + 512 * 5) / 1e6;
		expect(compressorCallBoundUsd(HAIKU, 13_239, LAYOUT, 512)).toBeCloseTo(expected, 12);
	});

	test("the output side uses the cap, never the catalog ceiling or the context window", () => {
		const small = compressorCallBoundUsd(HAIKU, 1000, LAYOUT, 512);
		const large = compressorCallBoundUsd(HAIKU, 1000, LAYOUT, 4096);
		expect(large! - small!).toBeCloseTo((4096 - 512) * 5 / 1e6, 12);
	});

	test("an unknown model, rate, or context window refuses with null", () => {
		expect(compressorCallBoundUsd(null, 1000, LAYOUT, 512)).toBeNull();
		expect(compressorCallBoundUsd({ ...HAIKU, cacheWriteRate: null }, 1000, LAYOUT, 512)).toBeNull();
		expect(compressorCallBoundUsd({ ...HAIKU, contextWindow: null }, 1000, LAYOUT, 512)).toBeNull();
	});

	test("the prompt tokens clamp to the context window when the bytes exceed it", () => {
		const tiny: ModelRates = { ...HAIKU, contextWindow: 1000 };
		expect(compressorCallBoundUsd(tiny, 13_239, LAYOUT, 512)).toBeCloseTo((1000 * 1.25 + 512 * 5) / 1e6, 12);
	});
});
