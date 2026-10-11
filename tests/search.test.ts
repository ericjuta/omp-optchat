import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Memory, utf8Bytes, type MemoryOptions, type Summarize } from "../src/memory.ts";
import { Store } from "../src/store.ts";

const cleanups: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  const failures: unknown[] = [];
  // LIFO: every Memory closes before its Store, and Stores close before rm.
  for (let cleanup = cleanups.pop(); cleanup; cleanup = cleanups.pop()) {
    try {
      await cleanup();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, "search test cleanup failed");
});

async function openStore(): Promise<Store> {
  const root = await mkdtemp(join(tmpdir(), "optchat-search-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const store = await Store.open(join(root, "chat"));
  cleanups.push(() => store.close());
  return store;
}

/** Summaries that always fail: nothing is built unless a test saves a node itself. */
const noCompactor: Summarize = async () => {
  throw new Error("no compactor in this test");
};

function memoryOver(store: Store, options: MemoryOptions = {}, summarize: Summarize = noCompactor): Memory {
  const memory = new Memory(store, summarize, { report: () => {}, ...options });
  cleanups.push(() => memory.close());
  return memory;
}

function saveText(store: Store, l: number, i: number, text: string): void {
  store.saveNode({ l, i, text, size: utf8Bytes(text) });
}

/** `length` messages, then every node of the full tree with `text(l, i)`; undefined leaves a node unbuilt. */
function seedTree(
  store: Store,
  length: number,
  text: (l: number, i: number) => string | undefined = (l, i) => `L${l}N${i}`,
): void {
  for (let i = 0; i < length; i++) store.append("talk", `message ${i}`);
  for (let l = 0, width = 1; width <= length; l++, width *= 2) {
    for (let i = 0; (i + 1) * width <= length; i++) {
      const value = text(l, i);
      if (value !== undefined) saveText(store, l, i, value);
    }
  }
}

describe("Memory.search", () => {
  test("every term must appear, case-insensitively, and hits come newest first", async () => {
    const store = await openStore();
    store.append("user", "Deploy the BUILD to /srv/app");
    store.append("talk", "build passed");
    store.append("talk", "deploy notes only");
    store.append("talk", "The Build and deploy finished");
    const memory = memoryOver(store);
    expect(memory.search("build deploy").hits.map((hit) => hit.id)).toEqual([3, 0]);
    expect(memory.search("BUILD").hits.map((hit) => hit.id)).toEqual([3, 1, 0]);
    expect(memory.search("  build \t ").hits.map((hit) => hit.id)).toEqual([3, 1, 0]);
  });

  test("the kind filter keeps only that kind", async () => {
    const store = await openStore();
    store.append("user", "build it");
    store.append("talk", "build done");
    store.append("note", "build note");
    const memory = memoryOver(store);
    expect(memory.search("build", { kind: "talk" }).hits.map((hit) => [hit.id, hit.kind])).toEqual([[1, "talk"]]);
  });

  test("memory tool calls and mark-prefixed results are never hits; other tool records are", async () => {
    const store = await openStore();
    store.append("tool", 'chat_search {"text":"build"}');
    store.append("tool", 'zoom {"id":0,"n":1}');
    store.append("tool", 'chat_recall {"question":"build"}');
    store.append("echo", "[optchat search] 1 hits for \"build\" (newest first)\n0|user|build");
    store.append("echo", "[optchat recall] the build was on Tuesday");
    store.append("echo", "result: [optchat search] build output");
    store.append("tool", 'bash {"command":"build"}');
    store.append("user", "build");
    const memory = memoryOver(store);
    expect(memory.search("build").hits.map((hit) => hit.id)).toEqual([7, 6, 5]);
  });

  test("a limit returns that many hits, and next pages to the older ones exactly once", async () => {
    const store = await openStore();
    for (let i = 0; i < 5; i++) store.append("talk", `note ${i}`);
    const memory = memoryOver(store);
    const first = memory.search("note", { limit: 2 });
    expect(first.hits.map((hit) => hit.id)).toEqual([4, 3]);
    expect(first.next).toBe(3);
    const second = memory.search("note", { limit: 2, before: first.next! });
    expect(second.hits.map((hit) => hit.id)).toEqual([2, 1]);
    expect(second.next).toBe(1);
    const third = memory.search("note", { limit: 2, before: second.next! });
    expect(third.hits.map((hit) => hit.id)).toEqual([0]);
    expect(third.next).toBeNull();
  });

  test("next is null when the remaining matches fit the limit exactly", async () => {
    const store = await openStore();
    for (let i = 0; i < 3; i++) store.append("talk", `note ${i}`);
    const memory = memoryOver(store);
    expect(memory.search("note", { limit: 3 })).toEqual({
      hits: [
        { id: 2, kind: "talk", date: store.messages[2]!.date, snippet: "note 2" },
        { id: 1, kind: "talk", date: store.messages[1]!.date, snippet: "note 1" },
        { id: 0, kind: "talk", date: store.messages[0]!.date, snippet: "note 0" },
      ],
      next: null,
    });
  });

  test("before past the end is the same as no bound, and a bound excludes its own id", async () => {
    const store = await openStore();
    store.append("talk", "note a");
    store.append("talk", "note b");
    const memory = memoryOver(store);
    expect(memory.search("note", { before: 999 }).hits.map((hit) => hit.id)).toEqual([1, 0]);
    expect(memory.search("note", { before: 1 }).hits.map((hit) => hit.id)).toEqual([0]);
    expect(memory.search("note", { before: 0 })).toEqual({ hits: [], next: null });
  });

  test("hits carry the stored ISO date", async () => {
    const store = await openStore();
    store.append("talk", "dated build", new Date("2026-10-11T12:00:00.000Z"));
    const memory = memoryOver(store);
    expect(memory.search("build").hits).toEqual([
      { id: 0, kind: "talk", date: "2026-10-11T12:00:00.000Z", snippet: "dated build" },
    ]);
  });

  test("a snippet is one bounded line around the first match, with cut marks on both ends", async () => {
    const store = await openStore();
    const body = `${"alpha beta\n".repeat(60)}needle here\n${"gamma delta\n".repeat(60)}`;
    store.append("talk", body);
    const memory = memoryOver(store);
    const [hit] = memory.search("needle").hits;
    expect(hit!.snippet).toContain("needle here");
    expect(hit!.snippet).not.toMatch(/[\r\n]/);
    expect(hit!.snippet.startsWith("…")).toBe(true);
    expect(hit!.snippet.endsWith("…")).toBe(true);
    expect(utf8Bytes(hit!.snippet)).toBeLessThanOrEqual(240 + utf8Bytes("……"));
  });

  test("a match at the start has no leading cut mark, and multi-byte text is never split", async () => {
    const store = await openStore();
    store.append("talk", "needle first");
    store.append("talk", `${"é".repeat(200)} needle ${"漢".repeat(100)}`);
    const memory = memoryOver(store);
    const [long, short] = memory.search("needle").hits;
    expect(short!.snippet).toBe("needle first");
    expect(long!.snippet).toContain("needle");
    expect(long!.snippet).not.toContain("\uFFFD");
    expect(long!.snippet.startsWith("…")).toBe(true);
    expect(utf8Bytes(long!.snippet)).toBeLessThanOrEqual(240 + utf8Bytes("……"));
  });

  test("the search text is validated, and a bad option throws RangeError", async () => {
    const store = await openStore();
    store.append("talk", "anything");
    const memory = memoryOver(store);
    const bad: Array<[string, () => unknown]> = [
      ["blank text", () => memory.search("   ")],
      ["text over 200 characters", () => memory.search("x".repeat(201))],
      ["more than 8 words", () => memory.search("a b c d e f g h i")],
      ["an unknown kind", () => memory.search("a", { kind: "bogus" as never })],
      ["limit 0", () => memory.search("a", { limit: 0 })],
      ["limit 51", () => memory.search("a", { limit: 51 })],
      ["fractional limit", () => memory.search("a", { limit: 1.5 })],
      ["negative before", () => memory.search("a", { before: -1 })],
      ["fractional before", () => memory.search("a", { before: 1.5 })],
    ];
    for (const [name, call] of bad) expect(call, name).toThrow(RangeError);
    expect(memory.search("a", { limit: 50 }).hits).toHaveLength(1);
    expect(memory.search("x".repeat(200)).hits).toEqual([]);
  });
});

describe("Memory.zoom depth", () => {
  test("depth 1 is the two children, exactly as before", async () => {
    const store = await openStore();
    seedTree(store, 8);
    const memory = memoryOver(store);
    expect(memory.zoom(0, 8, 0, 1)).toEqual({
      text: "0+4|L2N0\n4+4|L2N1",
      next: null,
      totalBytes: utf8Bytes("0+4|L2N0\n4+4|L2N1"),
      offset: 0,
    });
    expect(memory.zoom(0, 8).text).toBe(memory.zoom(0, 8, 0, 1).text);
  });

  test("depth 2 opens four lines two levels down, and depth 3 opens all eight leaves", async () => {
    const store = await openStore();
    seedTree(store, 8);
    const memory = memoryOver(store);
    expect(memory.zoom(0, 8, 0, 2).text).toBe("0+2|L1N0\n2+2|L1N1\n4+2|L1N2\n6+2|L1N3");
    expect(memory.zoom(0, 8, 0, 3).text).toBe(
      ["0+1|L0N0", "1+1|L0N1", "2+1|L0N2", "3+1|L0N3", "4+1|L0N4", "5+1|L0N5", "6+1|L0N6", "7+1|L0N7"].join("\n"),
    );
  });

  test("depth counts from the addressed line, not from the root", async () => {
    const store = await openStore();
    seedTree(store, 8);
    const memory = memoryOver(store);
    expect(memory.zoom(4, 4, 0, 2).text).toBe("4+1|L0N4\n5+1|L0N5\n6+1|L0N6\n7+1|L0N7");
  });

  test("invalid depths and combinations throw RangeError", async () => {
    const store = await openStore();
    seedTree(store, 8);
    const memory = memoryOver(store);
    expect(() => memory.zoom(0, 4, 0, 3)).toThrow(/exceeds/);
    expect(() => memory.zoom(0, 1, 0, 2)).toThrow(RangeError);
    expect(() => memory.zoom(0, 8, 1, 2)).toThrow(RangeError);
    for (const depth of [0, 5, 1.5]) expect(() => memory.zoom(0, 8, 0, depth), `depth ${depth}`).toThrow(RangeError);
  });

  test("an unbuilt descendant throws the missing-line error", async () => {
    const store = await openStore();
    // The store will not save a parent without its children, so the nodes above an unbuilt one stay unbuilt too.
    seedTree(store, 8, (l, i) => (l === 1 && i === 3) || (l === 2 && i === 1) || l === 3 ? undefined : `L${l}N${i}`);
    const memory = memoryOver(store);
    // Depth 2 under line 0+8 reaches level-1 node 3, which is unbuilt.
    expect(() => memory.zoom(0, 8, 0, 2)).toThrow("No line 0+8.");
    // Line 0+4 needs only level-1 nodes 0 and 1, both built.
    expect(memory.zoom(0, 4, 0, 1).text).toBe("0+2|L1N0\n2+2|L1N1");
    // Line 4+4 needs only leaves 4..7, all built.
    expect(memory.zoom(4, 4, 0, 2).text).toBe("4+1|L0N4\n5+1|L0N5\n6+1|L0N6\n7+1|L0N7");
  });
});

describe("Memory.lineAt", () => {
  test("returns the built line flattened to one line; undefined for unbuilt or invalid addresses", async () => {
    const store = await openStore();
    // Level-2 (the whole 4-message line) stays unbuilt; its children are built.
    seedTree(store, 4, (l, i) => (l === 2 ? undefined : `first\nsecond ${l}-${i}`));
    const memory = memoryOver(store);
    expect(memory.lineAt(0, 2)).toEqual({ id: 0, n: 2, text: "first second 1-0" });
    expect(memory.lineAt(0, 4)).toBeUndefined();
    expect(memory.lineAt(2, 2)).toEqual({ id: 2, n: 2, text: "first second 1-1" });
    expect(memory.lineAt(0, 3)).toBeUndefined();
    expect(memory.lineAt(1, 2)).toBeUndefined();
    expect(memory.lineAt(4, 4)).toBeUndefined();
    expect(memory.lineAt(0, 0)).toBeUndefined();
  });
});
