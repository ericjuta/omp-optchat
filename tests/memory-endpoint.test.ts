import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Memory, type CompactionRequest, type MemoryOptions, type Summarize } from "../src/memory.ts";
import { Store } from "../src/store.ts";

const PLACEHOLDER = "(not summarized yet: zoom it)";
type Address = readonly [number, number];
const ORIGINAL: readonly Address[] = [[2, 0], [2, 1], [1, 4], [1, 5]];
const FRONTIER: readonly Address[] = [[3, 0], [1, 4], [1, 5]];
const FRONTIER_CONTEXT = "<chat>\n0+8|O\n8+2|CCCC\n10+2|DDDD\n</chat>";
const cleanups: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  const failures: unknown[] = [];
  // LIFO keeps each Memory ahead of its Store, and its Store ahead of rm.
  for (let cleanup = cleanups.pop(); cleanup; cleanup = cleanups.pop()) {
    try {
      await cleanup();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw new AggregateError(failures, "endpoint test cleanup failed");
});

async function openStore(): Promise<Store> {
  const root = await mkdtemp(join(tmpdir(), "optchat-endpoint-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const store = await Store.open(join(root, "chat"));
  cleanups.push(() => store.close());
  return store;
}

interface Call {
  request: CompactionRequest;
  settled: boolean;
  resolve(reply: string): void;
  reject(error: unknown): void;
}

class Model {
  readonly calls: Call[] = [];

  readonly summarize: Summarize = (request, signal) => {
    const deferred = Promise.withResolvers<string>();
    const abort = () => call.reject(new Error("controlled summarizer aborted"));
    const finish = (settle: () => void) => {
      if (call.settled) return;
      call.settled = true;
      signal.removeEventListener("abort", abort);
      settle();
    };
    const call: Call = {
      request,
      settled: false,
      resolve: (reply) => finish(() => deferred.resolve(reply)),
      reject: (error) => finish(() => deferred.reject(error)),
    };
    this.calls.push(call);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    return deferred.promise;
  };

  take(instruction: string): Call {
    const matches = this.calls.filter((call) => !call.settled && call.request.instruction.includes(instruction));
    expect(matches).toHaveLength(1);
    return matches[0]!;
  }
}

function memoryFor(store: Store, model: Model, options: MemoryOptions): Memory {
  const memory = new Memory(store, model.summarize, options);
  cleanups.push(async () => {
    // close aborts calls; explicit rejection also releases any remaining held work.
    let closing: Promise<void> | undefined;
    try {
      closing = memory.close();
    } finally {
      for (const call of model.calls) {
        if (!call.settled) call.reject(new Error("endpoint test cleanup"));
      }
    }
    await closing;
  });
  return memory;
}

async function until(condition: () => boolean, what: string): Promise<void> {
  for (let round = 0; round < 5_000; round++) {
    if (condition()) return;
    if (round % 100 === 99) {
      const deferred = Promise.withResolvers<void>();
      setImmediate(deferred.resolve);
      await deferred.promise;
    } else {
      await Promise.resolve();
    }
  }
  throw new Error(`Timed out waiting for ${what}`);
}

function saveText(store: Store, l: number, i: number, text: string): void {
  store.saveNode({ l, i, text, size: Buffer.byteLength(text) });
}

const source = (i: number): string => `message ${i} ${"source ".repeat(8)}`;
const suffix = (total: number): Address[] => Array.from({ length: total - 12 }, (_, i) => [0, i + 12]);
const parts = (memory: Memory): Address[] => memory.viewParts().map(({ l, i }) => [l, i]);
const chat = (lines: string[]): string => `<chat>\n${lines.join("\n")}\n</chat>`;

/** Identical complete available prefix [0,12), regardless of the unbuilt log suffix. */
function seedPrefix(store: Store, total: number): void {
  for (let i = 0; i < total; i++) store.append("user", source(i));
  const texts: Readonly<Record<string, string>> = {
    "2,0": "AAAA", "2,1": "BBBB", "1,4": "CCCC", "1,5": "DDDD",
    "3,0": "O", "2,2": "N",
  };
  for (let l = 0, width = 1; width <= 12; l++, width *= 2) {
    for (let i = 0; (i + 1) * width <= 12; i++) {
      saveText(store, l, i, texts[`${l},${i}`] ?? "x");
    }
  }
}

test("compactor restore uses the built frontier and gives leaf 12 identical context with or without backlog", async () => {
  const contexts: string[] = [];
  for (const total of [12, 20]) {
    const store = await openStore();
    seedPrefix(store, total);
    store.saveView({
      version: 2,
      length: total,
      parts: [...ORIGINAL, ...suffix(total)],
      compacting: false,
      compactor: { length: 8, parts: [[2, 0], [2, 1]], compacting: true },
    });
    const model = new Model();
    const memory = memoryFor(store, model, {
      nodeBytes: 24, viewBytes: 100_000, compactionViewBytes: 18, jobs: 1,
    });
    // Capture the constructor's durable selection BEFORE appending to the total12 case.
    const saved = store.viewSnapshot;
    if (!saved || !("compactor" in saved)) throw new Error("missing version 2 snapshot");
    expect(saved.compactor).toEqual({ length: 12, parts: FRONTIER, compacting: false });
    if (total === 12) memory.append("user", source(12));
    await until(() => model.calls.some((call) => call.request.instruction.includes("compress message 12")), "leaf 12 Summarize call");
    const context = model.take("compress message 12").request.context;
    expect(context).toContain(FRONTIER_CONTEXT);
    contexts.push(context);
  }
  // The pre-fix probe observed unequal contexts: backlog must not change this prefix.
  expect(Buffer.from(contexts[0]!)).toEqual(Buffer.from(contexts[1]!));
});

test("pending main view uses GLOBAL mixed-width ordering, not the compactor frontier", async () => {
  for (const total of [12, 20]) {
    const store = await openStore();
    seedPrefix(store, total);
    store.saveView({
      version: 2,
      length: total,
      parts: [...ORIGINAL, ...suffix(total)],
      compacting: true,
      compactor: { length: 0, parts: [], compacting: false },
    });
    // Pending permits a batch below the upper bound; target includes the suffix placeholders.
    const viewBytes = total === 20 ? 2 * (8 * Buffer.byteLength(PLACEHOLDER) + 9) : 18;
    const memory = memoryFor(store, new Model(), { nodeBytes: 24, viewBytes, jobs: 1 });
    const expectedPrefix: readonly Address[] = total === 20 ? [[2, 0], [2, 1], [2, 2]] : FRONTIER;
    expect(parts(memory)).toEqual([...expectedPrefix, ...suffix(total)]);
    if (total === 20) {
      expect(parts(memory)).not.toEqual([...FRONTIER, ...suffix(total)]);
      expect(memory.render()).toBe(chat([
        "0+4|AAAA", "4+4|BBBB", "8+4|N",
        ...suffix(total).map(([, i]) => `${i}+1|${PLACEHOLDER}`),
      ]));
    } else {
      expect(memory.render()).toBe(FRONTIER_CONTEXT);
    }
  }
});

test("background merges publish partial main-view progress without appends while the compaction latch stays set", async () => {
  const store = await openStore();
  const leaves = Array.from({ length: 8 }, (_, i) => `user: leaf-${i}`.padEnd(20, "."));
  for (const [i, text] of leaves.entries()) {
    store.append("user", source(i));
    saveText(store, 0, i, text);
  }
  const model = new Model();
  const memory = memoryFor(store, model, { nodeBytes: 24, viewBytes: 120, jobs: 4 });
  await until(() => model.calls.length === 4, "four held sibling merges");
  expect(model.calls.every((call) => !call.settled && call.request.instruction.includes("merge lines"))).toBe(true);
  let settled: boolean | undefined;
  const settling = memory.settle().then((value) => { settled = value; });
  await until(() => settled !== undefined, "settle with held background merges");
  await settling;
  expect(settled).toBe(true);

  const leafLine = (i: number): string => `${i}+1|${leaves[i]}`;
  const expectProgress = (expectedParts: Address[], lines: string[], nodeTextBytes: number, renderedBytes: number): string => {
    expect(memory.status().messages).toBe(8);
    expect(store.messages).toHaveLength(8);
    expect(memory.status().viewBytes).toBe(nodeTextBytes);
    expect(store.viewSnapshot?.compacting).toBe(true);
    expect(parts(memory)).toEqual(expectedParts);
    const rendered = memory.render();
    expect(rendered).toBe(chat(lines));
    // Node-text budgeting excludes the <chat> envelope, addresses, separators and newlines.
    expect(Buffer.byteLength(rendered)).toBe(renderedBytes);
    return rendered;
  };
  const before = expectProgress(
    leaves.map((_, i) => [0, i]), leaves.map((_, i) => leafLine(i)), 160, 214,
  );

  model.take("merge lines 2+1 and 3+1").resolve("middle one");
  await until(() => memory.status().viewBytes === 130, "first partial publication");
  const afterOne = expectProgress(
    [[0, 0], [0, 1], [1, 1], [0, 4], [0, 5], [0, 6], [0, 7]],
    [leafLine(0), leafLine(1), "2+2|middle one", leafLine(4), leafLine(5), leafLine(6), leafLine(7)],
    130, 179,
  );
  expect(afterOne).not.toBe(before);

  model.take("merge lines 4+1 and 5+1").resolve("middle two");
  await until(() => memory.status().viewBytes === 100, "second partial publication");
  const afterTwo = expectProgress(
    [[0, 0], [0, 1], [1, 1], [1, 2], [0, 6], [0, 7]],
    [leafLine(0), leafLine(1), "2+2|middle one", "4+2|middle two", leafLine(6), leafLine(7)],
    100, 144,
  );
  expect(afterTwo).not.toBe(afterOne);
});
