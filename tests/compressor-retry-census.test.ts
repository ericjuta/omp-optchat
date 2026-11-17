import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { census } from "../scripts/compressor-retry-census.ts";

const start = "2026-11-14T00:00:00Z";
const end = "2026-11-15T00:00:00Z";

test("counts calls by model, node, attempt and cause without mixing versions or mutating inputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "retry-census-"));
  try {
    const path = join(root, "metrics.jsonl");
    const base = { type: "compressor", pluginVersion: "0.16.6", at: start, model: "test/a", node: "leaf", attempt: 1, retry: null };
    const raw = [base,
      { ...base, attempt: 2, retry: "length" }, { ...base, attempt: 3, retry: "length", error: "DO NOT PRINT" },
      { ...base, attempt: 2, retry: "head" }, { ...base, node: "merge" }, { ...base, model: "test/b" },
      { ...base, at: end }, { ...base, at: "2026-11-14T00:00:00+01:00" },
      { ...base, pluginVersion: "0.16.5" }, { ...base, pluginVersion: "unknown" },
      { ...base, type: undefined, pluginVersion: undefined }, { ...base, attempt: 2 },
      { ...base, attempt: 2, retry: "new-cause" }, { ...base, node: "other" },
      { type: "host-compaction" }, { type: "rules" }, null,
    ].map(row => JSON.stringify(row)).join("\n") + '\n{"torn":';
    await writeFile(path, raw);
    const result = await census([root, path], start, end, "0.16.6");
    expect(result.files).toBe(1);
    expect(result.skipped).toEqual({ malformed: 2, otherType: 2, outsideWindow: 1, otherVersion: 3, incompatible: 4 });
    expect(result.groups).toEqual([
      { model: "test/a", node: "leaf", calls: 4, retries: 3, retryShare: 0.75, attempts: { 1: { initial: 1 }, 2: { head: 1, length: 1 }, 3: { length: 1 } } },
      { model: "test/a", node: "merge", calls: 1, retries: 0, retryShare: 0, attempts: { 1: { initial: 1 } } },
      { model: "test/b", node: "leaf", calls: 1, retries: 0, retryShare: 0, attempts: { 1: { initial: 1 } } },
    ]);
    expect(JSON.stringify(result)).not.toContain("DO NOT PRINT");
    expect((await census([path], start, end, "unversioned")).groups[0]?.calls).toBe(1);
    expect(await readFile(path, "utf8")).toBe(raw);
    await expect(census([path], end, start, "0.16.6")).rejects.toThrow();
    await expect(census([join(root, "missing")], start, end, "0.16.6")).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
