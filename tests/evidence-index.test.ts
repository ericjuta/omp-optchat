import { describe, expect, test } from "bun:test";
import { readTextPage, type MessageMetadata } from "../src/archive.ts";
import { EVIDENCE_INDEX_BYTES } from "../src/evidence-index.ts";
import type { Kind } from "../src/store.ts";
import { readSourcePage } from "../src/source-page.ts";
import {
  EVIDENCE_BYTES, EVIDENCE_PASSAGE_BYTES, EVIDENCE_PASSAGES,
  gatherEvidence, renderEvidence, type EvidenceMemory, type EvidencePage,
} from "../src/system1/evidence.ts";

interface RecordText {
  readonly text: string;
  readonly kind?: Kind;
  readonly metadata?: MessageMetadata;
}

function source(records: readonly RecordText[], identity: object = {}) {
  const reads: { id: number; offset: number; bytes: number }[] = [];
  let live = true;
  const memory: EvidenceMemory = {
    sourceIdentity: identity,
    assertLive: () => { if (!live) throw new Error("source revoked"); },
    page: (id, offset, maxBytes) => {
      const record = records[id];
      if (!record) throw new Error(`outside source: ${id}`);
      const page = readTextPage(record.text, offset, maxBytes);
      reads.push({ id, offset, bytes: Buffer.byteLength(page.text) });
      return { ...page, kind: record.kind ?? "user", metadata: record.metadata };
    },
  };
  return { memory, reads, revoke: () => { live = false; } };
}

function bytes(passages: readonly { text: string }[]): number {
  return passages.reduce((total, passage) => total + Buffer.byteLength(passage.text), 0);
}

const frozenClock = () => 0;

describe("derived evidence chunk index", () => {
  test("an output budget omission never reports observed matches as absent", async () => {
    const result = await gatherEvidence(source([{ text: "orchid" }]).memory, "orchid", { upperBound: 1, maxBytes: 1, clock: frozenClock });
    expect(result.passages).toEqual([]);
    expect(result.missing).toEqual([]);
    expect(result.explanation.selection.matchedChunks).toBe(1);
    expect(renderEvidence("orchid", result)).not.toContain("no searched message contains a question word");
  });
  test("a compact gold fact outside fifty noisy whole-message hits wins generically", async () => {
    const query = "cedar release minimum runtime required version";
    // Every long decoy contains every word at message level, but not together in a passage.
    const noisy = query.split(" ").map((word) => `${word} ${"noise ".repeat(700)}`).join("\n");
    const records: RecordText[] = Array.from({ length: 75 }, () => ({ text: noisy }));
    const fact = "The cedar release minimum runtime required version is 9.4.4.";
    records.push({ text: fact });
    const reader = source(records);

    const result = await gatherEvidence(reader.memory, query, { upperBound: records.length, clock: frozenClock });

    expect(result.passages[0]).toMatchObject({ id: 75, text: fact, complete: true });
    expect(result.explanation.coverage).toMatchObject({ fullyIndexedMessages: 76, next: null, complete: true });
    expect(result.explanation.matches[0]!.terms).toEqual(query.split(" "));
    expect(result.explanation.selection.matchedChunks).toBeGreaterThan(50);
    expect(result.complete).toBe(true);
  });

  test("deep Unicode windows reopen byte-exactly and recover phrases across a chunk edge", async () => {
    const fact = "orchid greenhouse launch code";
    const text = `${"é😀漢".repeat(2_500)}${"x".repeat(1_013)} ${fact} ${"é😀漢".repeat(200)}`;
    const reader = source([{ text }]);
    const result = await gatherEvidence(reader.memory, fact, { upperBound: 1, clock: frozenClock });
    const encoded = Buffer.from(text);
    expect(result.passages.some((passage) => passage.text.includes(fact))).toBe(true);
    expect(result.passages[0]!.start).toBeGreaterThan(16_384);
    for (const passage of result.passages) {
      expect(passage.end - passage.start).toBeLessThanOrEqual(EVIDENCE_PASSAGE_BYTES);
      expect(passage.text).not.toContain("\uFFFD");
      expect(encoded.subarray(passage.start, passage.end).toString("utf8")).toBe(passage.text);
      expect(readTextPage(text, passage.start, EVIDENCE_PASSAGE_BYTES).text).toBe(passage.text);
    }
    const boundaryText = `${"x".repeat(2_040)} ${fact} ${"x".repeat(2_100)}`;
    const boundary = await gatherEvidence(source([{ text: boundaryText }]).memory, fact, { upperBound: 1, clock: frozenClock });
    expect(boundary.passages[0]!.text).toContain(fact);
    expect(boundary.passages[0]!.start).toBe(1_024);
  });

  test("a valid long Unicode query term spans windows without being reported missing", async () => {
    const term = "漢".repeat(1_000);
    const result = await gatherEvidence(source([{ text: term }]).memory, term, { upperBound: 1, clock: frozenClock });
    expect(result.complete).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.passages).toHaveLength(2);
    const ordered = [...result.passages].sort((a, b) => a.start - b.start);
    expect(ordered[0]!.start).toBe(0);
    expect(ordered[0]!.end).toBe(ordered[1]!.start);
    expect(ordered.map((passage) => passage.text).join("")).toBe(term);
    for (const passage of result.passages) expect(Buffer.byteLength(passage.text)).toBeLessThanOrEqual(EVIDENCE_PASSAGE_BYTES);
  });

  test("cross-window matching does not invent long terms by repeating overlap or joining messages", async () => {
    const term = "漢".repeat(700);
    const repeatedOverlap = await gatherEvidence(source([{ text: `${"漢".repeat(500)}${"字".repeat(500)}` }]).memory, term, { upperBound: 1, clock: frozenClock });
    expect(repeatedOverlap.missing).toEqual([term]);
    expect(repeatedOverlap.passages).toEqual([]);
    const crossMessage = await gatherEvidence(source([{ text: "漢".repeat(500) }, { text: "漢".repeat(500) }]).memory, term, { upperBound: 2, clock: frozenClock });
    expect(crossMessage.missing).toEqual([term]);
    expect(crossMessage.passages).toEqual([]);
  });

  test("large originals are paged incrementally and actual traversal stays inside each read budget", async () => {
    const text = `${"x".repeat(2 * 1024 * 1024)} orchid`;
    const record = { text, kind: "work" as const, size: text.length + 6 };
    const reads: number[] = [];
    const memory: EvidenceMemory = {
      page: (_id, offset, maxBytes, maxTraversalBytes) => {
        reads.push(offset);
        return { ...readSourcePage(record, offset, maxBytes, maxTraversalBytes), kind: record.kind };
      },
    };
    const first = await gatherEvidence(memory, "orchid", { upperBound: 1, maxReadBytes: 4_096, clock: frozenClock });
    expect(first.explanation.coverage.readBytes).toBeLessThanOrEqual(4_096);
    expect(first.explanation.omissions).toContain("read-byte-limit");
    expect(first.explanation.coverage.next).toEqual({ id: 0, offset: 1_024 });
    expect(first.complete).toBe(false);
    const resumed = await gatherEvidence(memory, "orchid", { upperBound: 1, clock: frozenClock });
    expect(resumed.complete).toBe(true);
    expect(resumed.passages.some((passage) => passage.text.includes("orchid"))).toBe(true);
    expect(reads[0]).toBe(0);
    expect(reads.filter((offset) => offset === 0)).toHaveLength(1);
  });

  test("incremental builds resume a partial message and rebuilding produces the same passages", async () => {
    const records = [{ text: "alpha ".repeat(700) }, { text: "omega launch marker" }];
    const reader = source(records);
    const limits = { upperBound: 2, maxReadBytes: 2_048, clock: frozenClock };
    const first = await gatherEvidence(reader.memory, "omega", limits);
    expect(first.complete).toBe(false);
    expect(first.explanation.coverage.next).toEqual({ id: 0, offset: 1_024 });
    expect(first.explanation.coverage.readBytes).toBe(2_048);
    expect(first.explanation.omissions).toContain("read-byte-limit");
    expect(first.missing).toEqual(["omega"]);
    expect(renderEvidence("omega", first)).toContain("not absent from the chat");
    const second = await gatherEvidence(reader.memory, "omega", limits);
    expect(second.explanation.coverage.next).toEqual({ id: 0, offset: 2_048 });
    expect(second.explanation.index.reused).toBe(true);
    await gatherEvidence(reader.memory, "omega", limits);
    await gatherEvidence(reader.memory, "omega", limits);
    const finished = await gatherEvidence(reader.memory, "omega", limits);
    expect(finished.complete).toBe(true);
    expect(finished.passages[0]!.id).toBe(1);
    expect(reader.reads.filter((read) => read.id === 0).map((read) => read.offset)).toEqual([0, 1_024, 2_048, 3_072]);
    const rebuilt = await gatherEvidence(source(records).memory, "omega", { upperBound: 2, clock: frozenClock });
    expect(finished.passages).toEqual(rebuilt.passages);
    expect(finished.explanation.matches).toEqual(rebuilt.explanation.matches);
  });

  test("fresh adapters reuse only a stable source identity, append incrementally, and isolate resets", async () => {
    const identity = {};
    const records = [{ text: "alpha orchid" }, { text: "beta orchid" }];
    const first = source(records, identity);
    await gatherEvidence(first.memory, "orchid", { upperBound: 2, clock: frozenClock });
    const next = source(records, identity);
    const reused = await gatherEvidence(next.memory, "beta", { upperBound: 2, clock: frozenClock });
    expect(next.reads).toHaveLength(0);
    expect(reused.explanation.index.reused).toBe(true);
    records.push({ text: "gamma orchid" });
    const appended = await gatherEvidence(next.memory, "gamma", { upperBound: 3, clock: frozenClock });
    expect(next.reads.map((read) => read.id)).toEqual([2]);
    expect(appended.passages[0]!.text).toBe("gamma orchid");
    const reset = await gatherEvidence(source([{ text: "delta orchid" }]).memory, "delta", { upperBound: 1, clock: frozenClock });
    expect(reset.passages[0]!.text).toBe("delta orchid");
    expect(reset.explanation.index.reused).toBe(false);
  });

  test("older snapshots cannot see future text, weights, coverage, or partial reports from a warm index", async () => {
    const records: RecordText[] = [
      { text: "orchid release" },
      { text: "orchid greenhouse" },
      { text: "[incomplete: capture stopped] future orchid greenhouse password", kind: "work" },
      ...Array.from({ length: 100 }, () => ({ text: "greenhouse greenhouse password" })),
    ];
    const reader = source(records);
    await gatherEvidence(reader.memory, "orchid greenhouse password", { upperBound: records.length, clock: frozenClock });
    const count = reader.reads.length;
    const older = await gatherEvidence(reader.memory, "orchid greenhouse password", { upperBound: 2, clock: frozenClock });
    const cold = await gatherEvidence(source(records).memory, "orchid greenhouse password", { upperBound: 2, clock: frozenClock });
    expect(reader.reads).toHaveLength(count);
    expect(older.passages).toEqual(cold.passages);
    expect(older.explanation.matches).toEqual(cold.explanation.matches);
    expect(older.explanation.index).toEqual({ ...cold.explanation.index, reused: true });
    expect(older.explanation.coverage).toEqual({ ...cold.explanation.coverage, readBytes: 0 });
    expect(older.incomplete).toEqual([]);
    expect(older.missing).toContain("password");
    expect(older.searched.every((id) => id < 2)).toBe(true);
    const empty = await gatherEvidence(reader.memory, "password", { upperBound: 0, clock: frozenClock });
    expect(empty.passages).toEqual([]);
    expect(empty.explanation.index).toMatchObject({ reused: false, chunks: 0, messages: 0, retainedBytes: 0 });
  });

  test("concurrent child and parent queries share an incremental prefix without widening child scope", async () => {
    const records = [{ text: "orchid original" }, { text: "orchid future greenhouse" }, { text: "future greenhouse" }];
    const reader = source(records);
    const page = reader.memory.page;
    reader.memory.page = (...args) => {
      if (args[0] === 0) {
        const until = performance.now() + 9;
        while (performance.now() < until) { /* guarantee the first builder yields before querying */ }
      }
      return page(...args);
    };
    const child = gatherEvidence(reader.memory, "orchid greenhouse", { upperBound: 1, clock: frozenClock });
    const parent = gatherEvidence(reader.memory, "orchid greenhouse", { upperBound: 3, clock: frozenClock });
    const [small, large] = await Promise.all([child, parent]);
    const cold = await gatherEvidence(source(records).memory, "orchid greenhouse", { upperBound: 1, clock: frozenClock });
    expect(small.passages).toEqual(cold.passages);
    expect(small.explanation.matches).toEqual(cold.explanation.matches);
    expect(small.explanation.index.messages).toBe(1);
    expect(small.missing).toEqual(["greenhouse"]);
    expect(large.explanation.index.messages).toBe(3);
    expect(reader.reads.map((read) => read.id)).toEqual([0, 1, 2]);
  });

  test("source reads never escape upperBound", async () => {
    const reads: number[] = [];
    const memory: EvidenceMemory = {
      page: (id, offset, maxBytes) => {
        reads.push(id);
        if (id >= 2) throw new Error("snapshot escaped");
        return { ...readTextPage("orchid", offset, maxBytes), kind: "user" };
      },
    };
    const result = await gatherEvidence(memory, "orchid", { upperBound: 2, clock: frozenClock });
    expect(reads).toEqual([0, 1]);
    expect(result.passages.map((passage) => passage.id)).toEqual([0, 1]);
  });

  test("memory calls, marked results, and resultFor-linked raw zoom results never recurse", async () => {
    const records: RecordText[] = [
      { kind: "tool", text: 'zoom {"id":7,"n":1} orchid' },
      { kind: "echo", text: `orchid secret from previous zoom ${"orchid ".repeat(1_000)}`, metadata: { resultFor: 0 } },
      { kind: "echo", text: "[optchat evidence] orchid result" },
      { kind: "echo", text: "[optchat search] orchid result" },
      { kind: "echo", text: "[optchat recall] orchid result" },
      { kind: "tool", text: 'chat_evidence {"question":"orchid"}' },
      { kind: "user", text: "orchid original source" },
      { kind: "work", text: "[incomplete: cut short] orchid report" },
      { kind: "work", text: "orchid report pointer", metadata: { work: { source: "task", completeness: "pointer-only" } } },
    ];
    const reader = source(records);
    const result = await gatherEvidence(reader.memory, "orchid", { upperBound: records.length, clock: frozenClock });
    expect(result.searched).toEqual([6, 7, 8]);
    expect(result.passages.every((passage) => passage.id >= 6)).toBe(true);
    expect(result.incomplete).toEqual([7, 8]);
    expect(result.explanation.coverage).toMatchObject({ excludedMessages: 6, fullyIndexedMessages: 3, partialMessages: 2, complete: true });
    expect(result.explanation.omissions).toContain("recursive-memory");
    expect(reader.reads.filter((read) => read.id === 1)).toHaveLength(1);
  });

  test("retained bytes, chunk count and message count bounds expose uncovered ranges", async () => {
    const records = [{ text: "orchid ".repeat(1_000) }, { text: "later fact" }];
    const chunkBound = await gatherEvidence(source(records).memory, "orchid", { upperBound: 2, maxChunks: 1, clock: frozenClock });
    expect(chunkBound.explanation.omissions).toContain("chunk-limit");
    expect(chunkBound.explanation.index.chunks).toBe(1);
    expect(chunkBound.explanation.coverage.next).toEqual({ id: 0, offset: 1_024 });
    expect(chunkBound.complete).toBe(false);
    const byteBound = await gatherEvidence(source(records).memory, "orchid", { upperBound: 2, maxIndexBytes: 4_500, clock: frozenClock });
    expect(byteBound.explanation.omissions).toContain("index-byte-limit");
    expect(byteBound.explanation.index.retainedBytes).toBeLessThanOrEqual(4_500);
    expect(byteBound.explanation.coverage.next).toEqual({ id: 0, offset: 1_024 });
    const messageBound = await gatherEvidence(source([{ text: "orchid" }, { text: "orchid second" }]).memory, "orchid", { upperBound: 2, maxMessages: 1, clock: frozenClock });
    expect(messageBound.explanation.omissions).toContain("message-limit");
    expect(messageBound.explanation.coverage.next).toEqual({ id: 1, offset: 0 });
    const zeroReader = source(records);
    const zero = await gatherEvidence(zeroReader.memory, "orchid", { upperBound: Number.MAX_SAFE_INTEGER, maxIndexBytes: 0, clock: frozenClock });
    expect(zeroReader.reads).toHaveLength(0);
    expect(zero.unsearched).toEqual([0]);
    expect(zero.explanation.coverage.next).toEqual({ id: 0, offset: 0 });
    expect(renderEvidence("orchid", zero)).not.toContain("[search complete");
  });

  test("build time is reserved for querying partial coverage, and final deadlines stop further reads", async () => {
    const records = [{ text: "orchid first" }, { text: "orchid second" }, { text: "orchid never" }];
    const reader = source(records);
    const page = reader.memory.page;
    let now = 0;
    reader.memory.page = (...args) => { now += 40; return page(...args); };
    const result = await gatherEvidence(reader.memory, "orchid", { upperBound: 3, timeoutMs: 100, clock: () => now });
    expect(reader.reads.map((read) => read.id)).toEqual([0, 1]);
    expect(result.passages.map((passage) => passage.id)).toEqual([0, 1]);
    expect(result.explanation.omissions).toContain("index-time-limit");
    expect(result.explanation.coverage.next).toEqual({ id: 2, offset: 0 });
    expect(result.complete).toBe(false);
    const timed = source(records);
    const timedPage = timed.memory.page;
    now = 0;
    timed.memory.page = (...args) => { now = 101; return timedPage(...args); };
    const exceeded = await gatherEvidence(timed.memory, "orchid", { upperBound: 3, timeoutMs: 100, clock: () => now });
    expect(timed.reads).toHaveLength(1);
    expect(exceeded.explanation.omissions).toContain("time-limit");
    expect(exceeded.explanation.coverage.unsearchedChunks).toBe(1);
    expect(exceeded.complete).toBe(false);
  });

  test("warm-cache query deadlines are enforced without extra source reads", async () => {
    const reader = source([{ text: "orchid first" }, { text: "orchid second" }]);
    await gatherEvidence(reader.memory, "orchid", { upperBound: 2, clock: frozenClock });
    let ticks = 0;
    const result = await gatherEvidence(reader.memory, "orchid", {
      upperBound: 2, timeoutMs: 10, clock: () => ++ticks < 6 ? 0 : 11,
    });
    expect(reader.reads).toHaveLength(2);
    expect(result.complete).toBe(false);
    expect(result.explanation.coverage).toMatchObject({ indexedChunks: 2, readBytes: 0 });
    expect(result.explanation.coverage.searchedChunks).toBeLessThanOrEqual(2);
    expect(result.explanation.selection.scoredChunks).toBeLessThan(2);
    expect(result.explanation.omissions).toContain("time-limit");
  });

  test("zero timeout, empty terms and byte limits do not claim a complete search", async () => {
    for (const options of [{ timeoutMs: 0 }, { maxReadBytes: 0 }]) {
      const reader = source([{ text: "orchid" }]);
      const result = await gatherEvidence(reader.memory, "orchid", { upperBound: 1, ...options, clock: frozenClock });
      expect(reader.reads).toHaveLength(0);
      expect(result.complete).toBe(false);
      expect(result.passages).toEqual([]);
    }
    const empty = await gatherEvidence(source([{ text: "orchid" }]).memory, "a b ?", { upperBound: 1, clock: frozenClock });
    expect(empty.complete).toBe(false);
    expect(empty.explanation.omissions).toContain("no-query-terms");
  });

  test("cancellation is checked before reads, immediately after a page, and across event-loop yields", async () => {
    const pre = new AbortController();
    pre.abort(new Error("pre-cancelled"));
    const first = source([{ text: "orchid" }]);
    await expect(gatherEvidence(first.memory, "orchid", { upperBound: 1, signal: pre.signal })).rejects.toThrow("pre-cancelled");
    expect(first.reads).toHaveLength(0);
    const mid = new AbortController();
    const second = source([{ text: "orchid" }, { text: "orchid" }]);
    const page = second.memory.page;
    second.memory.page = (...args) => { const result = page(...args); mid.abort(new Error("page-cancelled")); return result; };
    await expect(gatherEvidence(second.memory, "orchid", { upperBound: 2, signal: mid.signal })).rejects.toThrow("page-cancelled");
    expect(second.reads).toHaveLength(1);
    const deferred = new AbortController();
    const third = source([{ text: "orchid" }, { text: "orchid" }]);
    const delayedPage = third.memory.page;
    third.memory.page = (...args) => {
      const until = performance.now() + 9;
      while (performance.now() < until) { /* force a single bounded page to consume one event-loop slice */ }
      return delayedPage(...args);
    };
    setImmediate(() => deferred.abort(new Error("yield-cancelled")));
    await expect(gatherEvidence(third.memory, "orchid", { upperBound: 2, signal: deferred.signal })).rejects.toThrow("yield-cancelled");
    expect(third.reads).toHaveLength(1);
  });

  test("cache hits still enforce source revocation", async () => {
    const reader = source([{ text: "orchid source" }]);
    await gatherEvidence(reader.memory, "orchid", { upperBound: 1, clock: frozenClock });
    reader.revoke();
    await expect(gatherEvidence(reader.memory, "orchid", { upperBound: 1, clock: frozenClock })).rejects.toThrow("source revoked");
    expect(reader.reads).toHaveLength(1);
  });

  test("inconsistent paging cannot create invalid offsets or an infinite loop", async () => {
    const badPages: EvidencePage[] = [
      { text: "orchid", next: 0, totalBytes: 10, kind: "user" },
      { text: "orchid", next: null, totalBytes: 1, kind: "user" },
      { text: "orchid", offset: 1, next: null, totalBytes: 6, kind: "user" },
      { text: "x".repeat(2_049), next: null, totalBytes: 2_049, kind: "user" },
    ];
    for (const page of badPages) {
      await expect(gatherEvidence({ page: () => page }, "orchid", { upperBound: 1, clock: frozenClock })).rejects.toThrow("inconsistent UTF-8 page");
    }
  });

  test("output caps stay hard even when callers request more, with explicit omission counts", async () => {
    const reader = source(Array.from({ length: 20 }, () => ({ text: `orchid ${"x".repeat(4_000)}` })));
    const result = await gatherEvidence(reader.memory, "orchid", { upperBound: 20, maxPassages: 100, maxBytes: 1_000_000, maxIndexBytes: Number.MAX_SAFE_INTEGER, clock: frozenClock });
    expect(result.passages).toHaveLength(EVIDENCE_PASSAGES);
    expect(bytes(result.passages)).toBeLessThanOrEqual(EVIDENCE_BYTES);
    expect(result.explanation.index.capacityBytes).toBe(EVIDENCE_INDEX_BYTES);
    expect(result.explanation.selection.passageLimitedChunks).toBeGreaterThan(0);
    expect(result.explanation.omissions).toContain("passage-limit");
    const tiny = await gatherEvidence(reader.memory, "orchid", { upperBound: 20, maxBytes: 1, clock: frozenClock });
    expect(tiny.passages).toEqual([]);
    expect(tiny.explanation.omissions).toContain("passage-byte-limit");
    expect(tiny.complete).toBe(true);
  });

  test("large matching-id lists have an explicitly truncated, bounded text trailer", async () => {
    const result = await gatherEvidence(source(Array.from({ length: 100 }, () => ({ text: "orchid" }))).memory, "orchid", { upperBound: 100, clock: frozenClock });
    expect(result.searched).toHaveLength(100);
    expect(renderEvidence("orchid", result)).toContain("36 further ids omitted from this trailer");
  });

  test("smaller capacity requests rebuild rather than inheriting oversized cached state", async () => {
    const reader = source([{ text: "orchid first" }, { text: "orchid second" }]);
    await gatherEvidence(reader.memory, "orchid", { upperBound: 2, clock: frozenClock });
    const reduced = await gatherEvidence(reader.memory, "orchid", { upperBound: 2, maxMessages: 1, clock: frozenClock });
    expect(reduced.explanation.index).toMatchObject({ reused: false, messages: 1 });
    expect(reduced.passages.map((passage) => passage.id)).toEqual([0]);
    expect(reduced.complete).toBe(false);
    await expect(gatherEvidence(reader.memory, "orchid", { upperBound: 2, maxReadBytes: -1 })).rejects.toThrow(RangeError);
    await expect(gatherEvidence(reader.memory, "x".repeat(1_001), { upperBound: 2 })).rejects.toThrow(RangeError);
  });
});
