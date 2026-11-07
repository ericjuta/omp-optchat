import { describe, expect, test } from "bun:test";
import { readSourcePage, SourcePageBudgetError } from "../src/source-page.ts";

function original(text: string) {
  return Object.freeze({ text, kind: "work" as const, size: Buffer.byteLength(text, "utf8") + 6 });
}

describe("bounded source paging", () => {
  test("offset zero traverses only its page, even on a multi-megabyte original", () => {
    const record = original(`orchid ${"x".repeat(4 * 1024 * 1024)}`);
    const page = readSourcePage(record, 0, 2_048, 2_048);
    expect(page.text).toBe(record.text.slice(0, 2_048));
    expect(page.totalBytes).toBe(record.size - 6);
    expect(page.traversedBytes).toBe(2_048);
    expect(page.next).toBe(2_048);
    const overlap = readSourcePage(record, 1_024, 2_048, 3_072);
    expect(overlap.traversedBytes).toBe(3_072);
    expect(overlap.text).toBe(record.text.slice(1_024, 3_072));
    const next = readSourcePage(record, 3_072, 2_048, 2_048);
    expect(next.traversedBytes).toBe(2_048);
  });

  test("Unicode offsets and lone-surrogate normalization remain byte-exact", () => {
    const record = original(`\uFEFF${"é😀漢\ud800".repeat(800)}`);
    const encoded = Buffer.from(record.text);
    let offset = 0;
    for (;;) {
      const page = readSourcePage(record, offset, 2_048, 2_048);
      const end = page.next ?? page.totalBytes;
      expect(page.text).toBe(encoded.subarray(offset, end).toString("utf8"));
      expect(Buffer.byteLength(page.text)).toBe(end - offset);
      expect(page.traversedBytes).toBe(end - offset);
      if (page.next === null) break;
      offset = page.next;
    }
    expect(() => readSourcePage(record, 1, 2_048)).toThrow("code-point boundary");
  });

  test("far random seeks fail within their allowance and retain bounded forward progress", () => {
    const record = original("x".repeat(20_000));
    let spent = 0;
    for (;;) {
      try {
        const page = readSourcePage(record, 10_000, 100, 1_024);
        spent += page.traversedBytes;
        expect(page.text).toBe("x".repeat(100));
        break;
      } catch (error) {
        expect(error).toBeInstanceOf(SourcePageBudgetError);
        if (!(error instanceof SourcePageBudgetError)) throw error;
        expect(error.traversedBytes).toBeLessThanOrEqual(1_024);
        spent += error.traversedBytes;
        if (spent > 12_000) throw new Error("bounded seeks did not make progress");
      }
    }
    expect(spent).toBe(10_100);
  });

  test("sequential long reports continue after sparse checkpoint thinning", () => {
    const record = original("é".repeat(2 * 1024 * 1024));
    let offset = 0;
    let spent = 0;
    for (;;) {
      const page = readSourcePage(record, offset, 32_768, 32_768);
      spent += page.traversedBytes;
      expect(page.text).toBe("é".repeat(16_384));
      if (page.next === null) break;
      offset = page.next;
    }
    expect(spent).toBe(record.size - 6);
    const beginning = readSourcePage(record, 0, 8, 8);
    expect(beginning.text).toBe("éééé");
    expect(beginning.traversedBytes).toBe(8);
  });

  test("cache eviction cannot leak another source's cursor or alter original bytes", () => {
    const first = original("😀".repeat(2_000));
    readSourcePage(first, 0, 2_048);
    for (let index = 0; index < 80; index++) readSourcePage(original(`source ${index}`), 0, 32);
    const again = readSourcePage(first, 0, 2_048, 2_048);
    expect(again.text).toBe("😀".repeat(512));
    expect(again.traversedBytes).toBe(2_048);
  });

  test("empty sources and invalid offsets or budgets are explicit", () => {
    expect(readSourcePage(original(""), 0, 1, 0)).toEqual({ text: "", offset: 0, next: null, totalBytes: 0, traversedBytes: 0 });
    expect(() => readSourcePage(original("😀"), 0, 1)).toThrow("too small");
    expect(() => readSourcePage(original("abc"), 4, 1)).toThrow(RangeError);
    expect(() => readSourcePage(original("abc"), 0, 0)).toThrow(RangeError);
    expect(() => readSourcePage(original("abc"), 0, 1, -1)).toThrow(RangeError);
    expect(() => readSourcePage(original("abc"), 0, 1, 0)).toThrow(SourcePageBudgetError);
  });
});
