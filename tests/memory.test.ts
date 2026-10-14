import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CompressorRefusedError, Memory, utf8Bytes, utf8Prefix, type CompactionRequest, type MemoryOptions, type Summarize } from "../src/memory.ts";
import { Store, nodeKey } from "../src/store.ts";

const PLACEHOLDER = "(not summarized yet: zoom it)";
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
  if (failures.length > 0) throw new AggregateError(failures, "memory test cleanup failed");
});

async function openStore(): Promise<Store> {
  const root = await mkdtemp(join(tmpdir(), "optchat-memory-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return openAt(join(root, "chat"));
}

async function openAt(directory: string): Promise<Store> {
  const store = await Store.open(directory);
  cleanups.push(() => store.close());
  return store;
}

async function reopen(store: Store): Promise<Store> {
  await store.close();
  return openAt(store.directory);
}

function saveText(store: Store, l: number, i: number, text: string): void {
  store.saveNode({ l, i, text, size: utf8Bytes(text) });
}

function seedTree(
  store: Store,
  length: number,
  text: (l: number, i: number) => string | undefined = (l, i) => `[n${l}-${i}]`.padEnd(12, "."),
): void {
  for (let i = 0; i < length; i++) store.append("user", `[m${i}] seeded long message`);
  for (let l = 0, width = 1; width <= length; l++, width *= 2) {
    for (let i = 0; (i + 1) * width <= length; i++) {
      const value = text(l, i);
      if (value !== undefined) saveText(store, l, i, value);
    }
  }
}

/** Compactor defaults to empty: restore rebuilds it from the built prefix. */
function saveView(
  store: Store,
  parts: ReadonlyArray<readonly [number, number]>,
  compacting = false,
): void {
  store.saveView({
    version: 2,
    length: store.messages.length,
    parts,
    compacting,
    compactor: { length: 0, parts: [], compacting: false },
  });
}

interface Call {
  readonly request: CompactionRequest;
  readonly signal: AbortSignal;
  settled: boolean;
  resolve(reply: string): void;
  reject(error: unknown): void;
}

/** Markers like [m3] (message 3), [s3] (its summary), [p0-1] (a merge reply) name a call's inputs. */
const label = (call: Call): string => (call.request.instruction.match(/\[[a-z][\d-]*\]/g) ?? []).join("+");

/** The text between the instruction's <input> tags. */
const inputOf = (call: Call): string => /<input>\n([\s\S]*?)\n<\/input>/.exec(call.request.instruction)![1]!;

/** A compactor whose replies the test controls; tracks how many calls overlap. */
class Model {
  readonly calls: Call[] = [];
  peak = 0;
  private active = 0;

  constructor(private readonly options: { ignoreAbort?: boolean; auto?: (request: CompactionRequest) => string } = {}) {}

  readonly summarize: Summarize = (request, signal) => {
    const deferred = Promise.withResolvers<string>();
    const finish = (settle: () => void) => {
      if (call.settled) return;
      call.settled = true;
      this.active--;
      settle();
    };
    const call: Call = {
      request,
      signal,
      settled: false,
      resolve: (reply) => finish(() => deferred.resolve(reply)),
      reject: (error) => finish(() => deferred.reject(error)),
    };
    this.calls.push(call);
    this.active++;
    this.peak = Math.max(this.peak, this.active);
    if (!this.options.ignoreAbort) {
      const abort = () => call.reject(new Error("compactor call aborted"));
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    }
    if (this.options.auto) call.resolve(this.options.auto(request));
    return deferred.promise;
  };

  open(): Call[] {
    return this.calls.filter((call) => !call.settled);
  }

  labels(): string[] {
    return this.open().map(label).sort();
  }

  take(...markers: string[]): Call {
    const matches = this.open().filter((call) => markers.every((marker) => call.request.instruction.includes(marker)));
    if (matches.length !== 1) {
      throw new Error(`Expected one open call with ${markers.join(" ")}; open: ${this.labels().join(", ")}`);
    }
    return matches[0]!;
  }
}

function memoryFor(store: Store, model: Model, options: MemoryOptions = {}): Memory {
  const memory = new Memory(store, model.summarize, options);
  cleanups.push(async () => {
    const closing = memory.close();
    for (const call of model.open()) call.reject(new Error("test cleanup"));
    await closing;
  });
  return memory;
}

/** Bounded: microtask turns with an occasional macrotask hop, never a clock sleep. */
async function until(condition: () => boolean, what: string | (() => string)): Promise<void> {
  for (let round = 0; round < 5_000; round++) {
    if (condition()) return;
    await (round % 100 === 99 ? new Promise<void>((resolve) => setImmediate(resolve)) : Promise.resolve());
  }
  throw new Error(`Timed out waiting for ${typeof what === "string" ? what : what()}`);
}

async function flush(rounds = 200): Promise<void> {
  for (let round = 0; round < rounds; round++) await Promise.resolve();
}

async function macrotasks(count: number): Promise<void> {
  for (let round = 0; round < count; round++) await new Promise<void>((resolve) => setImmediate(resolve));
}

interface Tracked<T> {
  done: boolean;
  value?: T;
  error?: unknown;
}

function track<T>(promise: Promise<T>): Tracked<T> {
  const state: Tracked<T> = { done: false };
  promise.then(
    (value) => {
      state.done = true;
      state.value = value;
    },
    (error: unknown) => {
      state.done = true;
      state.error = error;
    },
  );
  return state;
}

function chatLines(text: string): string[] {
  const lines = text.split("\n");
  expect(lines[0]).toBe("<chat>");
  expect(lines.at(-1)).toBe("</chat>");
  return lines.slice(1, -1);
}

const addresses = (memory: Memory): string[] =>
  chatLines(memory.render()).map((line) => line.slice(0, line.indexOf("|")));

const summary = (tag: string): string => `[${tag}]`.padEnd(12, ".");

const contextBytes = (context: string): number =>
  chatLines(context).reduce((bytes, line) => bytes + utf8Bytes(line.slice(line.indexOf("|") + 1)), 0);

test("UTF-8 helpers count bytes and never split a code point", () => {
  expect(utf8Bytes("aé🙂")).toBe(7);
  expect(utf8Prefix("abcde🙂fg", 7)).toBe("abcde");
  expect(utf8Prefix("abc🙂defgh", 7)).toBe("abc🙂");
  expect(utf8Prefix("ééé", 5)).toBe("éé");
  expect(utf8Prefix("😀🙂", 4)).toBe("😀");
  expect(utf8Prefix("🙂", 0)).toBe("");
  expect(utf8Prefix("short", 99)).toBe("short");
});

test("admission stops eight unbuilt leaves ahead, however many jobs are free", async () => {
  const store = await openStore();
  const model = new Model();
  const memory = memoryFor(store, model, { nodeBytes: 16, jobs: 16, viewBytes: 1_000_000 });
  for (let i = 0; i < 10; i++) memory.append("user", `[m${i}] a long user message`);

  await until(() => model.open().length === 8, "eight admitted leaves");
  await flush();
  expect(model.labels()).toEqual(["[m0]", "[m1]", "[m2]", "[m3]", "[m4]", "[m5]", "[m6]", "[m7]"]);

  // Each built leaf admits exactly one more: the window counts unbuilt leaves, not jobs.
  model.take("[m0]").resolve(summary("s0"));
  await until(() => model.labels().includes("[m8]"), "window admits leaf 8");
  await flush();
  expect(model.labels()).toEqual(["[m1]", "[m2]", "[m3]", "[m4]", "[m5]", "[m6]", "[m7]", "[m8]"]);
  expect(memory.status().pending).toBe(8);
});

test("a leaf's importance hint is added to its compaction instruction, and the hint sees only that leaf", async () => {
  const store = await openStore();
  const model = new Model();
  const seen: string[] = [];
  const memory = memoryFor(store, model, {
    nodeBytes: 16,
    jobs: 4,
    viewBytes: 1_000_000,
    hint: async (source) => {
      seen.push(source.text);
      return "This record is a decision; keep the choice and its reason. Its importance is high.";
    },
  });
  memory.append("user", "[m0] a long user message");
  await until(() => model.labels().includes("[m0]"), "leaf m0 with its hint");
  expect(model.take("[m0]").request.instruction).toContain("Its importance is high.");
  expect(seen).toEqual(["[m0] a long user message"]);
});

test("a failing hint leaves the leaf compacted as if no hint existed", async () => {
  const store = await openStore();
  const model = new Model();
  const memory = memoryFor(store, model, {
    nodeBytes: 16,
    jobs: 4,
    viewBytes: 1_000_000,
    hint: async () => {
      throw new Error("hint provider down");
    },
  });
  memory.append("user", "[m0] a long user message");
  await until(() => model.labels().includes("[m0]"), "leaf m0 without its hint");
  expect(model.take("[m0]").request.instruction).not.toContain("importance");
});

// Real timers on purpose: hintTimeoutMs is a wall-clock bound, and observing that the leaf proceeds past it needs real time.
test("a hint that never answers is abandoned at hintTimeoutMs, and the leaf compacts without it", async () => {
  const store = await openStore();
  const model = new Model();
  const memory = memoryFor(store, model, {
    nodeBytes: 16,
    jobs: 4,
    viewBytes: 1_000_000,
    hintTimeoutMs: 20,
    hint: () => Promise.withResolvers<string>().promise,
  });
  memory.append("user", "[m0] a long user message");
  const { promise: past, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, 60);
  await past;
  await until(() => model.labels().includes("[m0]"), "leaf m0 after the hint bound");
  expect(model.take("[m0]").request.instruction).not.toContain("importance");
});

test("a failed leaf keeps its admission slot until a retry succeeds", async () => {
  const store = await openStore();
  const model = new Model();
  const reports: string[] = [];
  const memory = memoryFor(store, model, {
    nodeBytes: 16,
    jobs: 16,
    viewBytes: 1_000_000,
    report: (message) => reports.push(message),
  });
  for (let i = 0; i < 10; i++) memory.append("user", `[m${i}] a long user message`);
  await until(() => model.open().length === 8, "eight admitted leaves");

  model.take("[m0]").reject(new Error("offline"));
  model.take("[m1]").resolve(summary("s1"));
  await until(() => model.labels().includes("[m8]"), "window admits leaf 8");
  await flush();
  // Leaf 0 is still unbuilt, so leaf 9 waits behind the window.
  expect(model.labels()).toEqual(["[m2]", "[m3]", "[m4]", "[m5]", "[m6]", "[m7]", "[m8]"]);
  expect(reports).toHaveLength(1);
  expect(reports[0]).toContain("offline");
});

test("the job cap bounds concurrent merges, and merges complete their parents", async () => {
  const store = await openStore();
  for (let i = 0; i < 8; i++) store.append("user", `[m${i}] seeded long message`);
  for (let i = 0; i < 8; i++) saveText(store, 0, i, summary(`s${i}`));
  const model = new Model();
  const memory = memoryFor(store, model, { nodeBytes: 16, jobs: 2, viewBytes: 100_000 });

  await until(() => model.open().length === 2, "two merges");
  await flush();
  expect(model.labels()).toEqual(["[s0]+[s1]", "[s2]+[s3]"]);
  expect(memory.status().pending).toBe(2);

  for (let built = 1; built <= 7; built++) {
    const call = model.open()[0];
    if (!call) throw new Error(`No open merge before node ${built}`);
    call.resolve(summary(`p${built}`));
    await until(() => store.nodes.size === 8 + built, `merge ${built}`);
    await flush();
    expect(model.open().length).toBeLessThanOrEqual(2);
  }
  expect(model.calls).toHaveLength(7);
  expect(model.peak).toBe(2);
  expect(store.nodes.has(nodeKey(3, 0))).toBe(true);
});

test("an over-long source is summarized through every page, then reduced to one leaf", async () => {
  const store = await openStore();
  const model = new Model({ auto: () => "ok" });
  const memory = memoryFor(store, model, { nodeBytes: 16, pageBytes: 4_096, jobs: 1, viewBytes: 1_000_000 });
  const big = Array.from({ length: 600 }, (_, k) => `línea ${k}: résumé 🙂 payload`).join("\n");
  const source = `echo: ${big}`;
  memory.append("user", "hi");
  memory.append("echo", big);
  expect(await memory.settle()).toBe(true);

  const calls = model.calls.filter((call) => call.request.instruction.includes("compress message 1"));
  const pageCalls = calls.filter((call) => call.request.instruction.includes(", part "));
  const finals = calls.filter((call) => !call.request.instruction.includes(", part "));
  expect(pageCalls.length).toBeGreaterThan(4);
  expect(finals).toHaveLength(1);
  // Every source byte reaches the compactor exactly once, in order, within the page bound.
  expect(pageCalls.map(inputOf).join("")).toBe(source);
  for (const call of pageCalls) expect(utf8Bytes(inputOf(call))).toBeLessThanOrEqual(4_096);
  expect(finals[0]!.request.instruction).toContain(
    `Ordered partial summaries of the complete input:\n${Array(pageCalls.length).fill("ok").join("\n")}`,
  );
  // Context is the built prefix only, never the message being summarized.
  expect(chatLines(pageCalls[0]!.request.context)).toEqual(["0+1|user: hi"]);
  expect(store.nodes.get(nodeKey(0, 1))?.text).toBe("ok");
});

test("reduction keeps exact order over bounded groups and rounds; each output is consumed once", async () => {
  const store = await openStore();
  // 16-byte ids: two summaries plus their newline are exactly the 33-byte group budget.
  const id = (n: number): string => String(n).padStart(16, "0");
  let produced = 0;
  const model = new Model({ auto: () => id(++produced) });
  const memory = memoryFor(store, model, { nodeBytes: 16, pageBytes: 16, jobs: 1, viewBytes: 1_000_000 });
  const body = "abcdefghij".repeat(10);
  const source = `echo: ${body}`; // 106 bytes: six full 16-byte pages, then 10 bytes
  memory.append("echo", body);
  expect(await memory.settle()).toBe(true);

  // Seven page calls cover the source exactly once, in order.
  const pages = model.calls.filter((call) => call.request.instruction.includes(", part "));
  expect(pages).toHaveLength(7);
  expect(pages.map(inputOf).join("")).toBe(source);

  // Round 1: [1,2] [3,4] [5,6] [7] -> 8, 9, 10; 7 passes through alone.
  // Round 2: [8,9] [10,7] -> 11, 12. Round 3: one group -> final leaf 13.
  const reductions = model.calls.filter((call) => call.request.instruction.includes("merge these"));
  expect(reductions.map(inputOf)).toEqual([
    `${id(1)}\n${id(2)}`,
    `${id(3)}\n${id(4)}`,
    `${id(5)}\n${id(6)}`,
    `${id(8)}\n${id(9)}`,
    `${id(10)}\n${id(7)}`,
  ]);
  const prefix = "Ordered partial summaries of the complete input:\n";
  const final = model.calls.at(-1)!;
  expect(model.calls).toHaveLength(13);
  expect(inputOf(final)).toBe(`${prefix}${id(11)}\n${id(12)}`);
  // A merged group is exactly 16 + 1 + 16 = 33 bytes; the final leaf adds the fixed prefix on top.
  for (const call of reductions) expect(utf8Bytes(inputOf(call))).toBe(33);
  expect(utf8Bytes(inputOf(final))).toBe(utf8Bytes(prefix) + 33);

  // Every page output and every intermediate output is consumed by exactly one later input.
  const consumed = [...reductions, final].flatMap((call) => inputOf(call).replace(prefix, "").split("\n"));
  expect(consumed.sort()).toEqual(Array.from({ length: 12 }, (_, k) => id(k + 1)).sort());
  for (const call of model.calls) {
    expect(utf8Bytes(call.request.context)).toBeLessThanOrEqual(36_096);
    expect(utf8Bytes(inputOf(call))).toBeLessThanOrEqual(utf8Bytes(prefix) + 33);
  }
  expect(store.nodes.get(nodeKey(0, 0))?.text).toBe(id(13));
});

test("close cancels a paged summary midway and publishes no partial leaf", async () => {
  const store = await openStore();
  const model = new Model();
  const memory = memoryFor(store, model, { nodeBytes: 16, pageBytes: 8, jobs: 1 });
  memory.append("echo", "x".repeat(40));

  await until(() => model.open().length === 1, "page 1");
  model.open()[0]!.resolve("ok");
  await until(() => model.open().length === 1, "page 2");
  const closing = track(memory.close());
  await until(() => closing.done, "close");
  expect(closing.error).toBeUndefined();
  expect(model.calls).toHaveLength(2);
  expect(store.nodes.has(nodeKey(0, 0))).toBe(false);
});

test("close during a reduction waits for the ignored provider call and publishes nothing from its late reply", async () => {
  const store = await openStore();
  const model = new Model({ ignoreAbort: true });
  const memory = memoryFor(store, model, { nodeBytes: 16, pageBytes: 16, jobs: 1 });
  memory.append("echo", "y".repeat(40)); // three pages: 16, 16, 14 bytes

  await until(() => model.open().length === 1, "page 1");
  model.open()[0]!.resolve("a".repeat(16));
  await until(() => model.open().length === 1, "page 2");
  model.open()[0]!.resolve("b".repeat(16));
  await until(() => model.open().length === 1, "page 3");
  model.open()[0]!.resolve("c".repeat(16));
  // [a, b] form one 33-byte group; c waits as a lone pass-through.
  await until(() => model.open().length === 1, "reduction pair");
  const pair = model.take("merge these");
  expect(model.calls).toHaveLength(4);

  const closing = track(memory.close());
  expect(pair.signal.aborted).toBe(true);
  await flush();
  // The provider ignored the abort, so close must still wait on it.
  expect(closing.done).toBe(false);

  pair.resolve("m".repeat(16)); // late reply, after close
  await until(() => closing.done, "close after the late reply");
  expect(closing.error).toBeUndefined();
  await flush();
  // Nothing after the late reply: no leaf, no further call, nothing pending.
  expect(model.calls).toHaveLength(4);
  expect(memory.status().pending).toBe(0);
  expect(store.nodes.has(nodeKey(0, 0))).toBe(false);
});

test("short sources become nodes verbatim without a model call, measured in UTF-8 bytes", async () => {
  const store = await openStore();
  const model = new Model();
  const memory = memoryFor(store, model, { nodeBytes: 40, viewBytes: 1_000_000 });
  const leaf0 = `user: ${"a".repeat(14)}`; // 20 bytes
  const leaf1 = `talk: ${"b".repeat(13)}`; // 19 bytes; 20 + 1 + 19 = 40 fits a free merge
  const leaf3 = `tool: ${"c".repeat(14)}`; // 20 bytes
  memory.append("user", "a".repeat(14));
  memory.append("talk", "b".repeat(13));
  memory.append("user", "é".repeat(18)); // 42 bytes but 24 UTF-16 units: needs the model
  memory.append("tool", "c".repeat(14));

  await until(() => model.calls.length === 1 && store.nodes.has(nodeKey(1, 0)), "free nodes and leaf 2 call");
  await flush();
  expect(store.nodes.get(nodeKey(0, 0))?.text).toBe(leaf0);
  expect(store.nodes.get(nodeKey(0, 1))?.text).toBe(leaf1);
  expect(store.nodes.get(nodeKey(1, 0))).toEqual({ l: 1, i: 0, text: `${leaf0}\n${leaf1}`, size: 40 });
  expect(model.calls[0]!.request.instruction).toContain(`user: ${"é".repeat(18)}`);
  // Leaves are independent: leaf 3 builds while leaf 2 is still summarizing,
  // but the pair that needs leaf 2 waits for it.
  expect(store.nodes.get(nodeKey(0, 3))?.text).toBe(leaf3);
  expect(store.nodes.has(nodeKey(1, 1))).toBe(false);

  model.calls[0]!.resolve("[s2] short");
  await until(() => model.calls.length === 2, "merge 0+4");
  expect(store.nodes.get(nodeKey(1, 1))?.text).toBe(`[s2] short\n${leaf3}`);
  const merge = model.calls[1]!;
  // 40 + 1 + 31 bytes exceeds the target, so the top merge asks the model.
  expect(merge.request.instruction).toContain(`\n${leaf0} ${leaf1}\n[s2] short ${leaf3}`);
  expect(chatLines(merge.request.context)).toEqual([`0+1|${leaf0}`, `1+1|${leaf1}`, "2+1|[s2] short", `3+1|${leaf3}`]);
});

test("size enforcement trims whitespace, cuts feedback to the limit, keeps the whole shortest reply, and stops early", async () => {
  const store = await openStore();
  const model = new Model();
  const memory = memoryFor(store, model, { nodeBytes: 20, tries: 3, jobs: 1 });
  memory.append("user", "[m0] a message that needs a summary");
  memory.append("user", "[m1] another message that needs one");

  await until(() => model.calls.length === 1, "first try");
  const first = model.calls[0]!;
  first.resolve(`  ${"x".repeat(30)}\n\t`);

  await until(() => model.calls.length === 2, "second try");
  const second = model.calls[1]!;
  expect(second.request.context).toBe(first.request.context);
  expect(second.request.instruction).toBe(first.request.instruction);
  expect(second.request.feedback.map((turn) => turn.reply.trim())).toEqual(["x".repeat(30)]);
  const cut = second.request.feedback[0]!.instruction;
  expect(cut).toContain("30 bytes");
  expect(cut).toContain("20-byte limit");
  expect(cut).toContain(`\n${"x".repeat(20)}| ← LIMIT`);
  expect(cut).not.toContain("x".repeat(21));
  second.resolve(`${"y".repeat(25)}  `);

  await until(() => model.calls.length === 3, "third try");
  const third = model.calls[2]!;
  // Only the latest try is replayed: the x30 reply is no longer in feedback.
  expect(third.request.feedback.map((turn) => turn.reply)).toEqual(["y".repeat(25)]);
  expect(third.request.feedback[0]!.instruction).toContain("25 bytes");
  expect(third.request.feedback[0]!.instruction).toContain(`\n${"y".repeat(20)}| ← LIMIT`);
  third.resolve("z".repeat(27));

  // Every try overflowed the 20-byte target but fit the ceiling: the shortest
  // whole reply (25 bytes) is kept intact, never cut.
  await until(() => store.nodes.has(nodeKey(0, 0)), "leaf 0 saved");
  expect(store.nodes.get(nodeKey(0, 0))?.text).toBe("y".repeat(25));

  await until(() => model.calls.length === 4, "leaf 1");
  expect(label(model.calls[3]!)).toBe("[m1]");
  model.calls[3]!.resolve("w".repeat(24));
  await until(() => model.calls.length === 5, "leaf 1 second try");
  model.calls[4]!.resolve("  keep  inner  spaces \n");
  await until(() => store.nodes.has(nodeKey(0, 1)), "leaf 1 saved");
  expect(store.nodes.get(nodeKey(0, 1))?.text).toBe("keep  inner  spaces");

  // The next call is the merge, not a third try for leaf 1.
  await until(() => model.calls.length === 6, "merge 0+2");
  expect(model.calls[5]!.request.feedback).toEqual([]);
  expect(model.calls[5]!.request.instruction).toContain(`\n${"y".repeat(25)}\nkeep  inner  spaces`);
});

test("feedback cuts on UTF-8 boundaries and the shortest try is measured in bytes", async () => {
  const store = await openStore();
  const model = new Model();
  const memory = memoryFor(store, model, { nodeBytes: 7, tries: 3 });
  memory.append("user", "[m0] needs a summary");

  await until(() => model.calls.length === 1, "first try");
  model.calls[0]!.resolve("ééééé"); // 10 bytes, 5 UTF-16 units
  await until(() => model.calls.length === 2, "second try");
  const firstCut = model.calls[1]!.request.feedback[0]!.instruction;
  expect(firstCut).toContain("10 bytes");
  expect(firstCut).toContain("\nééé| ← LIMIT");
  expect(firstCut).not.toContain("\uFFFD");

  model.calls[1]!.resolve("abc🙂defgh"); // 12 bytes; byte 7 ends the emoji exactly
  await until(() => model.calls.length === 3, "third try");
  expect(model.calls[2]!.request.feedback).toHaveLength(1); // latest try only
  const secondCut = model.calls[2]!.request.feedback[0]!.instruction;
  expect(secondCut).toContain("12 bytes");
  expect(secondCut).toContain("\nabc🙂| ← LIMIT");

  // 8 bytes versus ééééé's 10 bytes (5 UTF-16 units): bytes decide, and the
  // whole shortest reply is kept without cutting.
  model.calls[2]!.resolve("abcdefgh");
  await until(() => store.nodes.has(nodeKey(0, 0)), "leaf saved");
  expect(store.nodes.get(nodeKey(0, 0))?.text).toBe("abcdefgh");
});

test("a reply that opens with a head is retried once; the echo drops the head and the clean reply is stored", async () => {
  const store = await openStore();
  const model = new Model();
  const memory = memoryFor(store, model, { nodeBytes: 20, tries: 3, jobs: 1 });
  memory.append("user", "[m0] a message that needs a summary");

  await until(() => model.calls.length === 1, "first try");
  model.calls[0]!.resolve("476+4|user: a line");

  await until(() => model.calls.length === 2, "second try");
  const second = model.calls[1]!;
  expect(second.request.instruction).toBe(model.calls[0]!.request.instruction);
  expect(second.request.feedback).toHaveLength(1);
  const turn = second.request.feedback[0]!;
  expect(turn.reply).toBe("user: a line");
  expect(turn.instruction).toContain("Your line began with a head or preamble.");
  expect(turn.instruction).not.toContain("Too long");
  expect(JSON.stringify(second.request.feedback)).not.toContain("476");
  second.resolve("user: a clean line");

  await until(() => store.nodes.has(nodeKey(0, 0)), "leaf saved");
  expect(store.nodes.get(nodeKey(0, 0))?.text).toBe("user: a clean line");
  expect(model.calls).toHaveLength(2);
});

test("when every try opens with a head, the first fitting headed reply is stored and the leaf completes", async () => {
  const store = await openStore();
  const model = new Model();
  const memory = memoryFor(store, model, { nodeBytes: 20, tries: 3, jobs: 1 });
  memory.append("user", "[m0] a message that needs a summary");

  await until(() => model.calls.length === 1, "first try");
  model.calls[0]!.resolve("1+1|head one");
  await until(() => model.calls.length === 2, "second try");
  model.calls[1]!.resolve("2+1|head two");
  await until(() => model.calls.length === 3, "third try");
  model.calls[2]!.resolve("3+1|head three");

  await until(() => store.nodes.has(nodeKey(0, 0)), "leaf saved");
  expect(store.nodes.get(nodeKey(0, 0))?.text).toBe("1+1|head one");
  expect(model.calls).toHaveLength(3);
});

test("a reply that is both headed and over-long gets one feedback turn covering both", async () => {
  const store = await openStore();
  const model = new Model();
  const memory = memoryFor(store, model, { nodeBytes: 20, tries: 3, jobs: 1 });
  memory.append("user", "[m0] a message that needs a summary");

  await until(() => model.calls.length === 1, "first try");
  model.calls[0]!.resolve(`476+4|${"x".repeat(30)}`);

  await until(() => model.calls.length === 2, "second try");
  const second = model.calls[1]!;
  expect(second.request.feedback).toHaveLength(1);
  const turn = second.request.feedback[0]!;
  expect(turn.reply).toBe("x".repeat(30));
  expect(turn.instruction).toContain("Your line began with a head or preamble.");
  expect(turn.instruction).toContain("your line is 36 bytes, over the 20-byte limit");
  expect(JSON.stringify(second.request.feedback)).not.toContain("476");
  second.resolve("y".repeat(15));

  await until(() => store.nodes.has(nodeKey(0, 0)), "leaf saved");
  expect(store.nodes.get(nodeKey(0, 0))?.text).toBe("y".repeat(15));
  expect(model.calls).toHaveLength(2);
});

test("an ordinary opening such as 'user: ...' is never retried", async () => {
  const store = await openStore();
  const model = new Model();
  const memory = memoryFor(store, model, { nodeBytes: 20, tries: 3, jobs: 1 });
  memory.append("user", "[m0] a message that needs a summary");

  await until(() => model.calls.length === 1, "first try");
  model.calls[0]!.resolve("user: asks about it");

  await until(() => store.nodes.has(nodeKey(0, 0)), "leaf saved");
  expect(store.nodes.get(nodeKey(0, 0))?.text).toBe("user: asks about it");
  expect(model.calls).toHaveLength(1);
});

test("an unresolved early leaf stalls only its ancestors; the right subtree still completes", async () => {
  const store = await openStore();
  const model = new Model();
  const reports: string[] = [];
  const memory = memoryFor(store, model, {
    nodeBytes: 16,
    jobs: 3,
    report: (message) => reports.push(message),
  });
  for (let i = 0; i < 4; i++) memory.append("user", `[m${i}] a long user message`);
  await until(() => model.labels().join() === "[m0],[m1],[m2]", "three started leaves");
  const early = model.take("[m0]");

  model.take("[m1]").resolve(summary("s1"));
  await until(() => model.labels().join() === "[m0],[m2],[m3]", "last leaf admitted");
  model.take("[m2]").resolve(summary("s2"));
  await until(() => store.nodes.has(nodeKey(0, 2)), "leaf 2 saved");
  model.take("[m3]").resolve(summary("s3"));
  await until(() => model.labels().join() === "[m0],[s2]+[s3]", "right parent starts");
  model.take("[s2]", "[s3]").resolve(summary("p2-3"));
  await until(() => store.nodes.has(nodeKey(1, 1)), "right parent saved");

  // m0 is still unresolved: it holds one of the three slots and blocks every ancestor.
  await until(() => memory.status().pending === 1, "only the early leaf in flight");
  await macrotasks(3);
  expect(early.settled).toBe(false);
  expect(early.signal.aborted).toBe(false);
  expect(model.labels()).toEqual(["[m0]"]);
  expect(model.calls.map(label)).toEqual(["[m0]", "[m1]", "[m2]", "[m3]", "[s2]+[s3]"]);
  expect([...store.nodes.keys()].sort()).toEqual([nodeKey(0, 1), nodeKey(0, 2), nodeKey(0, 3), nodeKey(1, 1)].sort());
  expect(store.nodes.has(nodeKey(0, 0))).toBe(false);
  expect(store.nodes.has(nodeKey(1, 0))).toBe(false);
  expect(store.nodes.has(nodeKey(2, 0))).toBe(false);
  expect(store.nodes.get(nodeKey(1, 1))?.text).toBe(summary("p2-3"));

  early.resolve(summary("s0"));
  await until(() => model.labels().join() === "[s0]+[s1]", "left parent starts");
  model.take("[s0]", "[s1]").resolve(summary("p0-1"));
  await until(() => store.nodes.has(nodeKey(1, 0)), "left parent saved");
  await until(() => model.labels().join() === "[p0-1]+[p2-3]", "root starts");
  model.take("[p0-1]", "[p2-3]").resolve(summary("root"));
  await until(() => store.nodes.has(nodeKey(2, 0)), "root saved");

  expect(model.calls.map(label)).toEqual([
    "[m0]",
    "[m1]",
    "[m2]",
    "[m3]",
    "[s2]+[s3]",
    "[s0]+[s1]",
    "[p0-1]+[p2-3]",
  ]);
  expect(model.open()).toEqual([]);
  expect(model.peak).toBe(3);
  expect(reports).toEqual([]);
  expect([...store.nodes.keys()].sort()).toEqual([
    nodeKey(0, 0),
    nodeKey(0, 1),
    nodeKey(0, 2),
    nodeKey(0, 3),
    nodeKey(1, 0),
    nodeKey(1, 1),
    nodeKey(2, 0),
  ]);
  expect(store.nodes.get(nodeKey(0, 0))?.text).toBe(summary("s0"));
  expect(store.nodes.get(nodeKey(0, 1))?.text).toBe(summary("s1"));
  expect(store.nodes.get(nodeKey(0, 2))?.text).toBe(summary("s2"));
  expect(store.nodes.get(nodeKey(0, 3))?.text).toBe(summary("s3"));
  expect(store.nodes.get(nodeKey(1, 0))?.text).toBe(summary("p0-1"));
  expect(store.nodes.get(nodeKey(1, 1))?.text).toBe(summary("p2-3"));
  expect(store.nodes.get(nodeKey(2, 0))?.text).toBe(summary("root"));
});

test("five giant multilingual replies publish no node, and every request stays bounded", async () => {
  const store = await openStore();
  const giant = [
    "é語🙂".repeat(10), // 90 bytes, 40 UTF-16 units
    "語".repeat(22), // 66 bytes but only 22 UTF-16 units: bytes decide
    "🙂".repeat(20), // 80 bytes
    "é".repeat(40), // 80 bytes
    "語".repeat(23), // 69 bytes
  ];
  let produced = 0;
  const model = new Model({ auto: () => giant[produced++]! });
  const reports: string[] = [];
  // Ceiling = max(nodeBytes, pageBytes) = 64 bytes; every attempt is over it.
  const memory = memoryFor(store, model, {
    nodeBytes: 16,
    pageBytes: 64,
    jobs: 1,
    report: (message) => reports.push(message),
  });
  memory.append("echo", "x".repeat(20)); // "echo: " + 20 bytes: one page, over nodeBytes

  // settle resolves false once the failed job is released: failure is reported before that wake.
  expect(await memory.settle()).toBe(false);
  // Exactly the default five attempts, then failure: no node and no sixth call.
  expect(model.calls).toHaveLength(5);
  expect(store.nodes.has(nodeKey(0, 0))).toBe(false);
  expect(reports).toHaveLength(1);
  expect(reports[0]).toContain("no whole summary within the 64-byte safety ceiling");

  const [first] = model.calls;
  model.calls.forEach((call, k) => {
    expect(utf8Bytes(call.request.context)).toBeLessThanOrEqual(36_096);
    // Only feedback changes between attempts; the leaf instruction is identical.
    expect(call.request.instruction).toBe(first!.request.instruction);
    expect(utf8Bytes(call.request.instruction)).toBeLessThanOrEqual(64 + 2_048);
    expect(call.request.feedback).toHaveLength(k === 0 ? 0 : 1);
    for (const turn of call.request.feedback) {
      // Feedback is a byte-bounded prefix of the previous giant reply, never the whole reply.
      expect(giant[k - 1]!.startsWith(turn.reply)).toBe(true);
      expect(utf8Bytes(turn.reply)).toBeLessThanOrEqual(64);
      expect(turn.reply).not.toContain("\uFFFD");
      expect(utf8Bytes(turn.instruction)).toBeLessThanOrEqual(16 + 512);
      expect(turn.instruction).toContain("Previous reply excerpt only");
      expect(turn.instruction).toContain("| ← LIMIT");
    }
  });
});

test("the shortest whole candidate survives later larger and oversized tries, uncut", async () => {
  const store = await openStore();
  const replies = [
    "A".repeat(40), // whole candidate: over nodeBytes, under the 64-byte ceiling
    "é".repeat(40), // 80 bytes: oversized, never a candidate
    "B".repeat(30), // the new shortest
    "語".repeat(30), // 90 bytes: oversized
    "C".repeat(50), // longer than B: not kept
  ];
  let produced = 0;
  const model = new Model({ auto: () => replies[produced++]! });
  // Ceiling = max(nodeBytes, pageBytes) = 64 bytes.
  const memory = memoryFor(store, model, { nodeBytes: 16, pageBytes: 64, jobs: 1 });
  memory.append("echo", "x".repeat(20));
  expect(await memory.settle()).toBe(true);

  expect(model.calls).toHaveLength(5);
  expect(store.nodes.get(nodeKey(0, 0))).toEqual({ l: 0, i: 0, text: "B".repeat(30), size: 30 });
  // Feedback is always the latest try only, excerpted to the ceiling when oversized.
  expect(model.calls[1]!.request.feedback.map((turn) => turn.reply)).toEqual(["A".repeat(40)]);
  expect(model.calls[2]!.request.feedback.map((turn) => turn.reply)).toEqual(["é".repeat(32)]);
  expect(model.calls[3]!.request.feedback.map((turn) => turn.reply)).toEqual(["B".repeat(30)]);
  expect(model.calls[4]!.request.feedback.map((turn) => turn.reply)).toEqual(["語".repeat(21)]);
});

test("a failed branch stalls only its own subtree; independent branches keep building", async () => {
  const store = await openStore();
  const model = new Model();
  const reports: string[] = [];
  const memory = memoryFor(store, model, {
    nodeBytes: 16,
    jobs: 8,
    report: (message) => reports.push(message),
  });
  for (let i = 0; i < 4; i++) memory.append("user", `[m${i}] a long user message`);
  await until(() => model.open().length === 4, "four leaves");

  model.take("[m0]").reject(new Error("provider down"));
  for (const i of [1, 2, 3]) model.take(`[m${i}]`).resolve(summary(`s${i}`));
  await until(() => model.labels().join() === "[s2]+[s3]", "right-branch pair");
  model.take("[s2]", "[s3]").resolve(summary("p2-3"));
  await until(() => store.nodes.has(nodeKey(1, 1)), "right branch parent");

  // Nothing can run until the next append: the left branch is stalled, not waiting.
  await until(() => memory.status().pending === 0 && model.open().length === 0, "quiet");
  expect(model.calls.map(label)).toEqual(["[m0]", "[m1]", "[m2]", "[m3]", "[s2]+[s3]"]);
  expect([...store.nodes.keys()].sort()).toEqual([nodeKey(0, 1), nodeKey(0, 2), nodeKey(0, 3), nodeKey(1, 1)].sort());
  expect(store.nodes.has(nodeKey(0, 0))).toBe(false);
  expect(store.nodes.has(nodeKey(1, 0))).toBe(false);
  expect(store.nodes.has(nodeKey(2, 0))).toBe(false);
  expect(store.nodes.get(nodeKey(0, 1))?.text).toBe(summary("s1"));
  expect(store.nodes.get(nodeKey(0, 2))?.text).toBe(summary("s2"));
  expect(store.nodes.get(nodeKey(0, 3))?.text).toBe(summary("s3"));
  expect(store.nodes.get(nodeKey(1, 1))?.text).toBe(summary("p2-3"));
  const settled = track(memory.settle());
  await until(() => settled.done, "settle with a stalled left branch");
  expect(settled.value).toBe(false);
  await macrotasks(3);
  expect(model.calls).toHaveLength(5);
  expect(model.open()).toEqual([]);
  expect(reports).toEqual(["OptChat compaction failed at 0+1; retrying on the next appended message: provider down"]);
});

test("a failed call releases the only job slot to queued work without retrying until append", async () => {
  const store = await openStore();
  const model = new Model();
  const reports: string[] = [];
  const memory = memoryFor(store, model, {
    nodeBytes: 16,
    jobs: 1,
    report: (message) => reports.push(message),
  });
  memory.append("user", "[m0] a long user message");
  await until(() => model.calls.length === 1, "first leaf call");
  expect(model.calls.map(label)).toEqual(["[m0]"]);

  // Let the append's pump admit m1 while m0 still owns the only job slot.
  memory.append("talk", "[m1] a second long message");
  await flush();
  expect(store.messages).toHaveLength(2);
  expect(model.calls.map(label)).toEqual(["[m0]"]);
  expect(model.labels()).toEqual(["[m0]"]);
  expect(store.nodes.has(nodeKey(0, 1))).toBe(false);
  model.take("[m0]").reject(new Error("offline"));

  // The failed job's own pump starts m1; no append or settle is involved.
  await until(() => model.calls.length === 2, "queued m1 starts after m0 fails");
  expect(model.calls.map(label)).toEqual(["[m0]", "[m1]"]);
  expect(model.labels()).toEqual(["[m1]"]);
  expect(store.nodes.has(nodeKey(0, 0))).toBe(false);
  model.take("[m1]").resolve(summary("s1"));
  await until(() => store.nodes.has(nodeKey(0, 1)), "queued leaf saved");
  const stalled = track(memory.settle());
  await until(() => stalled.done, "failed branch settles without work");
  expect(stalled.error).toBeUndefined();
  expect(stalled.value).toBe(false);
  await macrotasks(5);
  expect(model.calls.map(label)).toEqual(["[m0]", "[m1]"]);
  expect(model.open()).toEqual([]);
  expect(memory.status().pending).toBe(0);
  expect([...store.nodes.keys()]).toEqual([nodeKey(0, 1)]);
  expect(store.nodes.get(nodeKey(0, 1))?.text).toBe(summary("s1"));
  expect(store.nodes.has(nodeKey(0, 0))).toBe(false);
  expect(store.nodes.has(nodeKey(1, 0))).toBe(false);
  expect(reports).toHaveLength(1);
  expect(reports[0]).toContain("offline");

  // Append enqueues failed m0 before admitting m2; its parent queues behind m2.
  memory.append("user", "[m2] a third long message");
  await until(() => model.calls.length === 3, "m0 retry on new append");
  expect(model.calls.map(label)).toEqual(["[m0]", "[m1]", "[m0]"]);
  expect(model.labels()).toEqual(["[m0]"]);
  model.take("[m0]").resolve(summary("s0"));
  await until(() => model.calls.length === 4, "m2 precedes newly ready parent");
  expect(model.calls.map(label)).toEqual(["[m0]", "[m1]", "[m0]", "[m2]"]);
  expect(store.nodes.get(nodeKey(0, 0))?.text).toBe(summary("s0"));
  model.take("[m2]").resolve(summary("s2"));
  await until(() => model.calls.length === 5, "left parent starts after m2");
  expect(model.calls.map(label)).toEqual(["[m0]", "[m1]", "[m0]", "[m2]", "[s0]+[s1]"]);
  model.take("[s0]", "[s1]").resolve(summary("p0-1"));
  await until(() => store.nodes.has(nodeKey(1, 0)), "left parent saved");
  const recovered = track(memory.settle());
  await until(() => recovered.done, "three-leaf recovery settles");
  expect(recovered.error).toBeUndefined();
  expect(recovered.value).toBe(true);
  await macrotasks(5);
  expect(model.calls.map(label)).toEqual(["[m0]", "[m1]", "[m0]", "[m2]", "[s0]+[s1]"]);
  expect([...store.nodes].map(([key, node]) => [key, node.text]).sort()).toEqual([
    [nodeKey(0, 0), summary("s0")],
    [nodeKey(0, 1), summary("s1")],
    [nodeKey(0, 2), summary("s2")],
    [nodeKey(1, 0), summary("p0-1")],
  ].sort());
  expect(model.open()).toEqual([]);
  expect(memory.status().pending).toBe(0);
  expect(model.peak).toBe(1);
  expect(reports).toHaveLength(1);
});

test("repeated failures retry only on distinct appends, report once, and recover the complete tree", async () => {
  const store = await openStore();
  const model = new Model();
  const reports: string[] = [];
  const memory = memoryFor(store, model, {
    nodeBytes: 16,
    jobs: 1,
    report: (message) => reports.push(message),
  });
  memory.append("user", "[m0] a long user message");
  await until(() => model.calls.length === 1, "initial m0 call");
  expect(model.calls.map(label)).toEqual(["[m0]"]);
  model.take("[m0]").reject(new Error("offline initially"));
  const initial = track(memory.settle());
  await until(() => initial.done, "initial failure settles");
  expect(initial.error).toBeUndefined();
  expect(initial.value).toBe(false);
  await macrotasks(5);
  expect(model.calls.map(label)).toEqual(["[m0]"]);
  expect(model.open()).toEqual([]);
  expect(memory.status().pending).toBe(0);
  expect(store.nodes.size).toBe(0);
  expect(store.nodes.has(nodeKey(0, 0))).toBe(false);
  expect(store.nodes.has(nodeKey(1, 0))).toBe(false);
  expect(reports).toHaveLength(1);
  expect(reports[0]).toContain("offline initially");

  for (const { i, history } of [
    { i: 1, history: ["[m0]", "[m0]", "[m1]"] },
    { i: 2, history: ["[m0]", "[m0]", "[m1]", "[m0]", "[m2]"] },
  ]) {
    memory.append("user", `[m${i}] another long user message`);
    await until(() => model.calls.length === history.length - 1, `m0 retry before m${i}`);
    expect(model.calls.map(label)).toEqual(history.slice(0, -1));
    expect(model.labels()).toEqual(["[m0]"]);
    model.take("[m0]").reject(new Error(`offline again on append ${i}`));
    await until(() => model.calls.length === history.length, `unrelated m${i} starts after retry failure`);
    expect(model.calls.map(label)).toEqual(history);
    expect(model.labels()).toEqual([`[m${i}]`]);
    model.take(`[m${i}]`).resolve(summary(`s${i}`));
    await until(() => store.nodes.has(nodeKey(0, i)), `unrelated leaf ${i} saved`);
    const stalled = track(memory.settle());
    await until(() => stalled.done, `retry failure ${i} settles`);
    expect(stalled.error).toBeUndefined();
    expect(stalled.value).toBe(false);
    await macrotasks(5);
    expect(model.calls.map(label)).toEqual(history);
    expect(model.open()).toEqual([]);
    expect(memory.status().pending).toBe(0);
    expect([...store.nodes.keys()].sort()).toEqual(
      (i === 1 ? [nodeKey(0, 1)] : [nodeKey(0, 1), nodeKey(0, 2)]).sort(),
    );
    for (let leaf = 1; leaf <= i; leaf++) {
      expect(store.nodes.get(nodeKey(0, leaf))?.text).toBe(summary(`s${leaf}`));
    }
    expect(store.nodes.has(nodeKey(0, 0))).toBe(false);
    expect(store.nodes.has(nodeKey(1, 0))).toBe(false);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain("offline initially");
  }

  memory.append("talk", "[m3] a fourth long message");
  const history = ["[m0]", "[m0]", "[m1]", "[m0]", "[m2]", "[m0]"];
  await until(() => model.calls.length === history.length, "successful m0 retry on fourth append");
  expect(model.calls.map(label)).toEqual(history);
  expect(model.labels()).toEqual(["[m0]"]);
  model.take("[m0]").resolve(summary("s0"));

  // Saving m0 queues the left parent behind m3; saving m3 queues the right
  // parent behind the left. Only saving both parents makes the root ready.
  for (const { call, reply, l, i } of [
    { call: "[m3]", reply: "s3", l: 0, i: 3 },
    { call: "[s0]+[s1]", reply: "p0-1", l: 1, i: 0 },
    { call: "[s2]+[s3]", reply: "p2-3", l: 1, i: 1 },
    { call: "[p0-1]+[p2-3]", reply: "p0-3", l: 2, i: 0 },
  ]) {
    history.push(call);
    await until(() => model.calls.length === history.length, `FIFO recovery call ${call}`);
    expect(model.calls.map(label)).toEqual(history);
    expect(model.labels()).toEqual([call]);
    model.calls[history.length - 1]!.resolve(summary(reply));
    await until(() => store.nodes.has(nodeKey(l, i)), `recovery node ${l}:${i} saved`);
    expect(store.nodes.get(nodeKey(l, i))?.text).toBe(summary(reply));
    expect(reports).toHaveLength(1);
  }
  const recovered = track(memory.settle());
  await until(() => recovered.done, "complete four-leaf tree settles");
  expect(recovered.error).toBeUndefined();
  expect(recovered.value).toBe(true);
  await macrotasks(5);
  expect(model.calls.map(label)).toEqual([
    "[m0]", "[m0]", "[m1]", "[m0]", "[m2]", "[m0]", "[m3]",
    "[s0]+[s1]", "[s2]+[s3]", "[p0-1]+[p2-3]",
  ]);
  expect([...store.nodes].map(([key, node]) => [key, node.text]).sort()).toEqual([
    [nodeKey(0, 0), summary("s0")],
    [nodeKey(0, 1), summary("s1")],
    [nodeKey(0, 2), summary("s2")],
    [nodeKey(0, 3), summary("s3")],
    [nodeKey(1, 0), summary("p0-1")],
    [nodeKey(1, 1), summary("p2-3")],
    [nodeKey(2, 0), summary("p0-3")],
  ].sort());
  expect(model.open()).toEqual([]);
  expect(memory.status().pending).toBe(0);
  expect(model.peak).toBe(1);
  expect(reports).toHaveLength(1);
  expect(reports[0]).toContain("offline initially");
});

test("an unprintable rejection is reported and retried on the next append", async () => {
  const store = await openStore();
  const model = new Model();
  const reports: string[] = [];
  const memory = memoryFor(store, model, {
    nodeBytes: 16,
    report: (message) => reports.push(message),
  });
  memory.append("user", "[m0] a long user message");
  await until(() => model.open().length === 1, "leaf call");
  model.take("[m0]").reject(Object.create(null)); // String() of it throws
  await until(() => reports.length === 1, "failure report");
  expect(reports[0]).toContain("unprintable error");

  memory.append("talk", "[m1] a second long message");
  await until(() => model.open().some((call) => label(call) === "[m0]"), "retry call");
  model.take("[m0]").resolve(summary("s0"));
  await until(() => store.nodes.has(nodeKey(0, 0)), "leaf saved");
  expect(store.nodes.get(nodeKey(0, 0))?.text).toBe(summary("s0"));
});

test("an async reporter's rejection is contained and the retry proceeds", async () => {
  const unhandled: unknown[] = [];
  const listener = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", listener);
  try {
    const store = await openStore();
    const model = new Model();
    let reported = 0;
    const memory = memoryFor(store, model, {
      nodeBytes: 16,
      report: async () => {
        reported++;
        throw new Error("reporter down");
      },
    });
    memory.append("user", "[m0] a long user message");
    await until(() => model.open().length === 1, "leaf call");
    model.take("[m0]").reject(new Error("offline"));
    await until(() => reported === 1, "report");
    await macrotasks(2);
    expect(unhandled).toEqual([]);

    memory.append("talk", "[m1] a second long message");
    await until(() => model.open().some((call) => label(call) === "[m0]"), "retry call");
    model.take("[m0]").resolve(summary("s0"));
    await until(() => store.nodes.has(nodeKey(0, 0)), "leaf saved");
    await macrotasks(2);
    expect(unhandled).toEqual([]);
  } finally {
    process.off("unhandledRejection", listener);
  }
});

for (const mode of ["discards", "returns"] as const) {
  test(`a reporter that ${mode} memory.close() does not deadlock the failing job`, async () => {
    const store = await openStore();
    const model = new Model();
    const reporter: { closing?: Tracked<void> } = {};
    const memory: Memory = memoryFor(store, model, {
      nodeBytes: 16,
      report: () => {
        const promise = memory.close();
        reporter.closing = track(promise);
        if (mode === "returns") return promise;
      },
    });
    memory.append("user", "[m0] a long user message");
    await until(() => model.open().length === 1, "leaf call");
    model.take("[m0]").reject(new Error("offline"));

    await until(() => reporter.closing?.done === true, "close started inside the reporter");
    expect(reporter.closing?.error).toBeUndefined();
    expect(model.calls).toHaveLength(1);
    expect(store.nodes.size).toBe(0);
    expect(memory.status().pending).toBe(0);
    expect(await memory.settle()).toBe(false);
  });
}

test("settle resolves per caller once every view line is a summary, without waiting for merges", async () => {
  const store = await openStore();
  const model = new Model();
  const memory = memoryFor(store, model, { nodeBytes: 16, viewBytes: 100_000 });
  expect(memory.render()).toBe("<chat>\n</chat>");
  expect(await memory.settle()).toBe(true);

  memory.append("user", "[m0] first long user message");
  expect(memory.render()).toBe(`<chat>\n0+1|${PLACEHOLDER}\n</chat>`);
  await until(() => model.open().length === 1, "leaf 0 call");
  const cancelled = new AbortController();
  const first = track(memory.settle(cancelled.signal));
  const second = track(memory.settle());
  await flush();
  expect(first.done).toBe(false);
  expect(second.done).toBe(false);

  // One caller's abort ends only its own wait, never the compactor's work.
  cancelled.abort();
  await flush();
  expect(first).toEqual({ done: true, value: false });
  expect(second.done).toBe(false);
  expect(model.calls[0]!.signal.aborted).toBe(false);
  expect(await memory.settle(AbortSignal.abort())).toBe(false);

  // A line appended while waiting must be summarized too.
  memory.append("talk", "[m1] second long reply message");
  model.take("[m0]").resolve(summary("s0"));
  await until(() => store.nodes.has(nodeKey(0, 0)), "leaf 0 saved");
  await flush();
  expect(second.done).toBe(false);
  expect(memory.render()).toContain(`1+1|${PLACEHOLDER}`);

  await until(() => model.open().some((call) => label(call) === "[m1]"), "leaf 1 call");
  model.take("[m1]").resolve(summary("s1"));
  await until(() => second.done, "settle after both leaves");
  expect(second.value).toBe(true);
  expect(memory.render()).not.toContain(PLACEHOLDER);

  await until(() => model.open().length === 1, "merge call");
  expect(model.labels()).toEqual(["[s0]+[s1]"]);
  expect(await memory.settle()).toBe(true);
  expect(memory.status().pending).toBe(1);
});

test("close aborts the provider, waits for it to settle, and drops its late reply", async () => {
  const store = await openStore();
  const model = new Model({ ignoreAbort: true });
  const memory = memoryFor(store, model, { nodeBytes: 16 });
  memory.append("user", "[m0] a long user message");
  await until(() => model.open().length === 1, "leaf call");
  const call = model.open()[0]!;
  const waiting = track(memory.settle());

  const closing = track(memory.close());
  await flush();
  expect(call.signal.aborted).toBe(true);
  expect(waiting).toEqual({ done: true, value: false });
  expect(closing.done).toBe(false);

  call.resolve("[s0] late");
  await until(() => closing.done, "close after provider settlement");
  expect(closing.error).toBeUndefined();
  await flush();
  expect(store.nodes.size).toBe(0);
  expect(model.calls).toHaveLength(1);
  expect(await memory.settle()).toBe(false);
});

test("close before the scheduled pump runs starts no compaction", async () => {
  const store = await openStore();
  const model = new Model();
  const memory = memoryFor(store, model, { nodeBytes: 16 });
  memory.append("user", "[m0] a long user message");
  const closing = track(memory.close());
  await until(() => closing.done, "close");
  await flush();
  expect(model.calls).toHaveLength(0);
  expect(store.nodes.size).toBe(0);
});

test("restart restores the persisted live tiling instead of replaying today's complete tree", async () => {
  const store = await openStore();
  seedTree(store, 4);
  const model = new Model();
  const options = { nodeBytes: 16, viewBytes: 60 };
  const memory = memoryFor(store, model, options);
  expect(addresses(memory)).toEqual(["0+1", "1+1", "2+1", "3+1"]);

  memory.append("user", "[m4] next long message");
  await until(() => model.open().length === 1, "leaf 4");
  model.take("[m4]").resolve(summary("s4"));
  await until(() => store.nodes.has(nodeKey(0, 4)), "leaf 4 saved");
  expect(addresses(memory)).toEqual(["0+4", "4+1"]);
  expect(memory.status().viewBytes).toBe(24);
  const rendered = memory.render();
  const parts = memory.viewParts();
  await memory.close();

  const restoredStore = await reopen(store);
  const restoredModel = new Model();
  const restored = memoryFor(restoredStore, restoredModel, options);
  expect(restored.render()).toBe(rendered);
  expect(restored.viewParts()).toEqual(parts);
  expect(restored.status().viewBytes).toBe(24);
  expect(await restored.settle()).toBe(true);
  await flush();
  expect(restoredModel.calls).toHaveLength(0);
  // All five leaves fit exactly in 60 bytes now; reconstructing from them
  // would incorrectly split the persisted 0+4 line back into four leaves.
  expect(restoredStore.viewSnapshot?.parts).toEqual([[2, 0], [0, 4]]);
});

test("restart reproduces the compactor context of the next summary exactly", async () => {
  const store = await openStore();
  seedTree(store, 8);
  const reports: string[] = [];
  const options: MemoryOptions = {
    nodeBytes: 16,
    viewBytes: 1_000,
    compactionViewBytes: 60,
    report: (message) => reports.push(message),
  };
  const model = new Model();
  const memory = memoryFor(store, model, options);
  memory.append("user", "[m8] next long message");
  await until(() => model.open().length === 1, "leaf 8");
  model.take("[m8]").resolve(summary("s8"));
  await until(() => store.nodes.has(nodeKey(0, 8)), "leaf 8 saved");
  memory.append("talk", "[m9] another long message");
  await until(() => model.open().length === 1, "leaf 9");
  model.take("[m9]").resolve(summary("s9"));
  await until(() => store.nodes.has(nodeKey(0, 9)), "leaf 9 saved");
  await until(() => model.open().some((call) => label(call) === "[s8]+[s9]"), "pair 8+2");
  model.take("[s8]", "[s9]").resolve(summary("p8-9"));
  await until(() => store.nodes.has(nodeKey(1, 4)) && memory.status().pending === 0, "pair 8+2 saved and quiet");
  expect(store.nodes.has(nodeKey(3, 0))).toBe(true);
  expect(store.nodes.has(nodeKey(1, 4))).toBe(true);

  memory.append("user", "[m10] another long user message");
  await until(() => model.open().some((call) => label(call) === "[m10]"), "leaf 10");
  const leaf = model.take("[m10]");
  const before = leaf.request.context;
  expect(chatLines(before)).toEqual([
    `0+4|${summary("n2-0")}`,
    `4+4|${summary("n2-1")}`,
    `8+1|${summary("s8")}`,
    `9+1|${summary("s9")}`,
  ]);
  const beforeAddresses = chatLines(before).map((line) => line.slice(0, line.indexOf("|")));
  expect(beforeAddresses).toEqual(["0+4", "4+4", "8+1", "9+1"]);
  expect(beforeAddresses).not.toEqual(["0+8", "8+2"]);
  expect(contextBytes(before)).toBe(48);
  expect(contextBytes(before)).toBeLessThan(60);

  const calls = model.calls.length;
  const failure = new Error("leaf 10 restart-context regression failure");
  leaf.reject(failure);
  await until(
    () => reports.some((message) => message.includes(failure.message)) && memory.status().pending === 0,
    "leaf 10 failure reported and quiet",
  );
  await macrotasks(5);
  expect(model.calls.filter((call) => label(call) === "[m10]")).toHaveLength(1);
  expect(model.calls).toHaveLength(calls);
  expect(model.open()).toHaveLength(0);
  expect(store.nodes.has(nodeKey(0, 10))).toBe(false);
  const rendered = memory.render();
  await memory.close();

  const restoredStore = await reopen(store);
  const restoredModel = new Model();
  const restored = memoryFor(restoredStore, restoredModel, options);
  await until(() => restoredModel.open().some((call) => label(call) === "[m10]"), "restored leaf 10");
  const retry = restoredModel.take("[m10]");
  expect(retry.request.context).toBe(before);
  expect(chatLines(retry.request.context)).toEqual([
    `0+4|${summary("n2-0")}`,
    `4+4|${summary("n2-1")}`,
    `8+1|${summary("s8")}`,
    `9+1|${summary("s9")}`,
  ]);
  const retryAddresses = chatLines(retry.request.context).map((line) => line.slice(0, line.indexOf("|")));
  expect(retryAddresses).toEqual(["0+4", "4+4", "8+1", "9+1"]);
  expect(retryAddresses).not.toEqual(["0+8", "8+2"]);
  expect(restored.render()).toBe(rendered);
  retry.resolve(summary("s10"));
  await until(() => restoredStore.nodes.has(nodeKey(0, 10)), "retried leaf 10 saved");
  expect(restoredStore.nodes.get(nodeKey(0, 10))?.text).toBe(summary("s10"));
});

test("a stale snapshot preserves its coarse prefix and admits only the durable message suffix", async () => {
  const store = await openStore();
  seedTree(store, 4);
  saveView(store, [[2, 0]]);
  store.append("user", "[m4] logged after the snapshot");
  store.append("talk", "[m5] still needs summarizing");
  saveText(store, 0, 4, summary("s4"));

  const restoredStore = await reopen(store);
  const model = new Model();
  const memory = memoryFor(restoredStore, model, { nodeBytes: 16, viewBytes: 100 });
  expect(addresses(memory)).toEqual(["0+4", "4+1", "5+1"]);
  expect(memory.render()).toContain(`5+1|${PLACEHOLDER}`);
  expect(memory.status().viewBytes).toBe(24 + utf8Bytes(PLACEHOLDER));
  expect(restoredStore.viewSnapshot?.length).toBe(6);
  await until(() => model.open().length === 1, "unbuilt suffix leaf");
  const leaf = model.take("[m5]");
  expect(chatLines(leaf.request.context)).toEqual([`0+4|${summary("n2-0")}`, `4+1|${summary("s4")}`]);
  expect(leaf.request.context).not.toContain(PLACEHOLDER);
  leaf.resolve(summary("s5"));
  await until(() => restoredStore.nodes.has(nodeKey(0, 5)), "suffix summarized");
  expect(addresses(memory)).toEqual(["0+4", "4+1", "5+1"]);
  expect(memory.status().viewBytes).toBe(36);
  expect(await memory.settle()).toBe(true);
});

test("a node durable before its snapshot is used on restart without rebuilding or splitting the prefix", async () => {
  const store = await openStore();
  seedTree(store, 4, (l, i) => l === 0 ? summary(`s${i}`).padEnd(20, ".") : undefined);
  saveView(store, [[0, 0], [0, 1], [0, 2], [0, 3]], true);
  // Model the crash window with public persistence operations: the tree log
  // commit succeeded, but the corresponding view snapshot was never written.
  saveText(store, 1, 0, "[p0-1]....");

  const restoredStore = await reopen(store);
  const model = new Model();
  const memory = memoryFor(restoredStore, model, { nodeBytes: 16, viewBytes: 60 });
  expect(addresses(memory)).toEqual(["0+2", "2+1", "3+1"]);
  expect(memory.status().viewBytes).toBe(50);
  expect(restoredStore.viewSnapshot?.compacting).toBe(true);
  expect(restoredStore.viewSnapshot?.parts).toEqual([[1, 0], [0, 2], [0, 3]]);
  await until(() => model.open().length === 1, "remaining pair");
  expect(model.labels()).toEqual(["[s2]+[s3]"]);
  model.take("[s2]", "[s3]").resolve("[p2-3]....");
  await until(() => restoredStore.nodes.has(nodeKey(1, 1)), "remaining pair saved");
  expect(addresses(memory)).toEqual(["0+2", "2+2"]);
  expect(memory.status().viewBytes).toBe(20);
  expect(restoredStore.viewSnapshot?.compacting).toBe(false);
});

test("a partial batch resumes after restart even below upper, then stops at half without splitting", async () => {
  const store = await openStore();
  seedTree(store, 4, (l, i) => l === 0 ? summary(`s${i}`).padEnd(20, ".") : undefined);
  saveText(store, 1, 0, "[p0-1]....");
  const model = new Model();
  const options = { nodeBytes: 16, viewBytes: 60 };
  const memory = memoryFor(store, model, options);
  expect(addresses(memory)).toEqual(["0+2", "2+1", "3+1"]);
  expect(memory.status().viewBytes).toBe(50); // below 60, still above the batch's 30-byte target
  expect(store.viewSnapshot?.compacting).toBe(true);
  await until(() => model.open().length === 1, "unfinished pair before shutdown");
  await memory.close();
  expect(store.nodes.has(nodeKey(1, 1))).toBe(false);

  const restoredStore = await reopen(store);
  const restoredModel = new Model();
  const restored = memoryFor(restoredStore, restoredModel, options);
  expect(addresses(restored)).toEqual(["0+2", "2+1", "3+1"]);
  expect(restored.status().viewBytes).toBe(50);
  await until(() => restoredModel.open().length === 1, "resumed pair");
  restoredModel.take("[s2]", "[s3]").resolve("[p2-3]....");
  await until(() => restoredStore.nodes.has(nodeKey(1, 1)), "resumed pair saved");
  expect(addresses(restored)).toEqual(["0+2", "2+2"]);
  expect(restored.status().viewBytes).toBe(20);
  expect(restoredStore.viewSnapshot?.compacting).toBe(false);
  await until(() => restoredModel.open().length === 1, "top parent after both children");
  restoredModel.take("[p0-1]", "[p2-3]").resolve("top");
  await until(() => restoredStore.nodes.has(nodeKey(2, 0)), "top parent saved");
  // This parent is now available, but neither a new batch nor a split is due.
  expect(addresses(restored)).toEqual(["0+2", "2+2"]);
  expect(restored.status().viewBytes).toBe(20);
});

test("a store without a snapshot migrates once from the complete tree and persists that tiling", async () => {
  const seeded = await openStore();
  seedTree(seeded, 10);
  expect(seeded.viewSnapshot).toBeUndefined();
  const store = await reopen(seeded);
  const model = new Model();
  const memory = memoryFor(store, model, { viewBytes: 50 });
  expect(addresses(memory)).toEqual(["0+8", "8+2"]);
  expect(memory.status().viewBytes).toBe(24);
  expect(store.viewSnapshot).toEqual({
    version: 2,
    length: 10,
    parts: [[3, 0], [1, 4]],
    compacting: false,
    compactor: { length: 10, parts: [[3, 0], [1, 4]], compacting: false },
  });
  await flush();
  expect(model.calls).toHaveLength(0);
  await memory.close();

  const restoredStore = await reopen(store);
  const restored = memoryFor(restoredStore, new Model(), { viewBytes: 1_000 });
  expect(addresses(restored)).toEqual(["0+8", "8+2"]);
  expect(restored.status().viewBytes).toBe(24);
});

test("a legacy version-1 snapshot keeps its main tiling and gains a compactor exactly once", async () => {
  const seeded = await openStore();
  seedTree(seeded, 4);
  const directory = seeded.directory;
  await seeded.close();
  // Legacy stores have no compactor: write the version-1 file they would hold.
  await writeFile(
    join(directory, "view.json"),
    `${JSON.stringify({ version: 1, length: 4, parts: [[2, 0]], compacting: false })}\n`,
    { mode: 0o600 },
  );

  const store = await openAt(directory);
  const memory = memoryFor(store, new Model(), { nodeBytes: 16, viewBytes: 1_000 });
  expect(addresses(memory)).toEqual(["0+4"]);
  expect(store.viewSnapshot).toEqual({
    version: 2,
    length: 4,
    parts: [[2, 0]],
    compacting: false,
    compactor: { length: 4, parts: [[2, 0]], compacting: false },
  });
  await memory.close();

  const restored = memoryFor(await reopen(store), new Model(), { nodeBytes: 16, viewBytes: 1_000 });
  expect(addresses(restored)).toEqual(["0+4"]);
});

test("last-message age at T10 prefers 8+1|9+1 over 0+4|4+4", async () => {
  const store = await openStore();
  seedTree(store, 10, (l, i) => {
    if (l === 2) return i === 0 ? "AA" : "BB";
    if (l === 0 && i >= 8) return i === 8 ? "eeee" : "ffff";
    if (l === 1 && i === 4) return "N";
    if (l === 3) return "O";
    return "x";
  });
  saveView(store, [[2, 0], [2, 1], [0, 8], [0, 9]]);
  const model = new Model();
  const memory = memoryFor(store, model, { viewBytes: 10 });
  // 12 > upper 10. Last-message ages: (10-9)/1 = 1 beats (10-7)/4 = .75.
  // The newer pair reaches target 5 exactly; choosing the old pair first
  // would need both merges and produce 0+8,8+2 instead.
  expect(addresses(memory)).toEqual(["0+4", "4+4", "8+2"]);
  expect(memory.render()).toBe("<chat>\n0+4|AA\n4+4|BB\n8+2|N\n</chat>");
  expect(memory.status().viewBytes).toBe(5);
  await flush();
  expect(model.calls).toHaveLength(0);
});

test("main bytes sawtooth from upper to half and available parents do not retile between batches", async () => {
  const store = await openStore();
  seedTree(store, 8, (l) => (l === 0 ? "l".repeat(10) : "p".repeat(6)));
  const model = new Model({ auto: (request) => request.instruction.includes("<input>\nuser:") ? "l".repeat(10) : "p".repeat(6) });
  const memory = memoryFor(store, model, { nodeBytes: 8, tries: 1, viewBytes: 80 });
  expect(memory.status().viewBytes).toBe(80);
  expect(addresses(memory)).toEqual(Array.from({ length: 8 }, (_, i) => `${i}+1`));
  const built = (length: number) => {
    let count = 0;
    for (let width = 1; width <= length; width *= 2) count += Math.floor(length / width);
    return count;
  };
  const appendAndFinish = async (i: number) => {
    memory.append("user", `[m${i}] next long message`);
    await until(() => store.nodes.size === built(i + 1) && memory.status().pending === 0, `complete tree through ${i}`);
  };

  await appendAndFinish(8);
  expect(store.nodes.get(nodeKey(0, 8))?.text).toBe("l".repeat(10));
  expect(addresses(memory)).toEqual(["0+8", "8+1"]);
  expect(memory.status().viewBytes).toBe(16);
  const growth: number[] = [];
  for (let i = 9; i <= 12; i++) {
    await appendAndFinish(i);
    expect(addresses(memory)).toEqual(["0+8", ...Array.from({ length: i - 7 }, (_, k) => `${k + 8}+1`)]);
    growth.push(memory.status().viewBytes);
  }
  expect(growth).toEqual([26, 36, 46, 56]);
  expect(store.nodes.has(nodeKey(2, 2))).toBe(true); // 8+4 is built but not yet selected
  await appendAndFinish(13); // 56 + a 29-byte placeholder crosses upper 80
  expect(addresses(memory)).toEqual(["0+8", "8+4", "12+1", "13+1"]);
  expect(memory.status().viewBytes).toBe(32);
  expect(memory.status().viewBytes).toBeLessThanOrEqual(40);
});

test("compactor context has its own half-target batch and grows independently of the main tiling", async () => {
  const store = await openStore();
  seedTree(store, 8);
  const model = new Model();
  const memory = memoryFor(store, model, { nodeBytes: 16, viewBytes: 1_000, compactionViewBytes: 60 });
  const original = addresses(memory);
  expect(original).toEqual(Array.from({ length: 8 }, (_, i) => `${i}+1`));
  expect(memory.status().viewBytes).toBe(96);
  memory.append("user", "[m8] next long message");
  await until(() => model.open().length === 1, "leaf 8");
  const first = model.take("[m8]");
  expect(chatLines(first.request.context)).toEqual([`0+4|${summary("n2-0")}`, `4+4|${summary("n2-1")}`]);
  expect(contextBytes(first.request.context)).toBe(24);
  first.resolve(summary("s8"));
  await until(() => store.nodes.has(nodeKey(0, 8)), "leaf 8 saved");
  memory.append("talk", "[m9] another long message");
  await until(() => model.open().length === 1, "leaf 9");
  const second = model.take("[m9]");
  expect(chatLines(second.request.context)).toEqual([`0+4|${summary("n2-0")}`, `4+4|${summary("n2-1")}`, `8+1|${summary("s8")}`]);
  expect(contextBytes(second.request.context)).toBe(36);
  expect(second.request.context).not.toContain(PLACEHOLDER);
  expect(addresses(memory)).toEqual([...original, "8+1", "9+1"]);
});

test("a main-view batch refreshes compactor context even when its independent budget has room", async () => {
  const store = await openStore();
  seedTree(store, 4);
  const model = new Model();
  const memory = memoryFor(store, model, { nodeBytes: 16, viewBytes: 64, compactionViewBytes: 1_000 });
  expect(addresses(memory)).toEqual(["0+1", "1+1", "2+1", "3+1"]);
  memory.append("user", "[m4] full next message");
  await until(() => model.open().length === 1, "leaf after main batch");
  const leaf = model.take("[m4]");
  expect(addresses(memory)).toEqual(["0+4", "4+1"]);
  expect(chatLines(leaf.request.context)).toEqual([`0+4|${summary("n2-0")}`]);
  expect(leaf.request.context).not.toContain("[n0-");
  expect(leaf.request.context).not.toContain(PLACEHOLDER);
  expect(leaf.request.instruction).toContain("<input>\nuser: [m4] full next message\n</input>");
});

test("out-of-order concurrent merges use only the eligible built prefix and both complete children", async () => {
  const store = await openStore();
  seedTree(store, 8, (l, i) => l === 0 ? summary(`s${i}`) : undefined);
  const model = new Model();
  memoryFor(store, model, { nodeBytes: 16, jobs: 4, viewBytes: 1_000, compactionViewBytes: 1_000 });
  await until(() => model.open().length === 4, "four sibling-pair jobs");
  expect(chatLines(model.take("[s0]", "[s1]").request.context)).toEqual([`0+1|${summary("s0")}`, `1+1|${summary("s1")}`]);
  expect(chatLines(model.take("[s2]", "[s3]").request.context)).toEqual(Array.from({ length: 4 }, (_, i) => `${i}+1|${summary(`s${i}`)}`));
  model.take("[s2]", "[s3]").resolve(summary("p2-3"));
  await until(() => store.nodes.has(nodeKey(1, 1)), "later pair saved first");
  await flush();
  expect(model.calls).toHaveLength(4); // 0+4 still lacks its left child
  model.take("[s0]", "[s1]").resolve(summary("p0-1"));
  await until(() => model.open().some((call) => label(call) === "[p0-1]+[p2-3]"), "ready 0+4 parent");
  const parent = model.take("[p0-1]", "[p2-3]");
  expect(chatLines(parent.request.context)).toEqual(Array.from({ length: 4 }, (_, i) => `${i}+1|${summary(`s${i}`)}`));
  expect(parent.request.context).not.toContain("[s4]");
  expect(parent.request.context).not.toContain(PLACEHOLDER);
  expect(parent.request.instruction).toContain(`<input>\n${summary("p0-1")}\n${summary("p2-3")}\n</input>`);
  expect(model.open().map(label).sort()).toEqual(["[p0-1]+[p2-3]", "[s4]+[s5]", "[s6]+[s7]"]);
  expect(model.peak).toBe(4);
});

test("default main upper is 128000 bytes and an overflow batch reaches 64000 with a 16000-byte context", async () => {
  const store = await openStore();
  seedTree(store, 8, (l, i) => `[n${l}-${i}]`.padEnd(l === 0 ? 16_000 : 8_000, "."));
  const model = new Model();
  const memory = memoryFor(store, model);
  expect(memory.status().viewBytes).toBe(128_000);
  expect(addresses(memory)).toEqual(Array.from({ length: 8 }, (_, i) => `${i}+1`));
  memory.append("user", `[m8] ${"x".repeat(600)}`);
  expect(addresses(memory)).toEqual(["0+2", "2+2", "4+2", "6+1", "7+1", "8+1"]);
  expect(memory.status().viewBytes).toBe(56_000 + utf8Bytes(PLACEHOLDER));
  expect(memory.status().viewBytes).toBeLessThanOrEqual(64_000);
  await until(() => model.open().length === 1, "default-budget leaf");
  const leaf = model.take("[m8]");
  expect(leaf.request.instruction).toContain("at most 512 bytes");
  expect(leaf.request.instruction).toContain("(about 70 words), the length of this ruler:");
  expect(leaf.request.instruction.split("\n")).toContain("-".repeat(512));
  expect(chatLines(leaf.request.context)).toEqual([
    `0+4|${"[n2-0]".padEnd(8_000, ".")}`,
    `4+4|${"[n2-1]".padEnd(8_000, ".")}`,
  ]);
  expect(contextBytes(leaf.request.context)).toBe(16_000);
});

test("default compactor context grows through 32000 bytes before a batch returns it to 16000", async () => {
  const store = await openStore();
  seedTree(store, 2, (l, i) => `[n${l}-${i}]`.padEnd(l === 0 ? 16_000 : 8_000, "."));
  const model = new Model();
  // Keep the 24,001-byte pair in one request: this fixture exercises tiling, not paging.
  const memory = memoryFor(store, model, { nodeBytes: 16_000, pageBytes: 32_768 });
  const append = (i: number) => memory.append("user", `[m${i}] ${"x".repeat(16_001)}`);
  append(2);
  await until(() => model.open().length === 1, "leaf 2");
  expect(chatLines(model.take("[m2]").request.context)).toEqual([`0+2|${"[n1-0]".padEnd(8_000, ".")}`]);
  model.take("[m2]").resolve("[s2]".padEnd(16_000, "."));
  await until(() => store.nodes.has(nodeKey(0, 2)), "leaf 2 saved");
  append(3);
  await until(() => model.open().length === 1, "leaf 3");
  const third = model.take("[m3]");
  expect(contextBytes(third.request.context)).toBe(24_000);
  third.resolve("[s3]".padEnd(8_000, "."));
  await until(() => model.open().some((call) => label(call) === "[s2]+[s3]"), "pair 2+2");
  const pair = model.take("[s2]", "[s3]");
  expect(contextBytes(pair.request.context)).toBe(32_000);
  pair.resolve("[p2-3]".padEnd(8_000, "."));
  await until(() => store.nodes.has(nodeKey(1, 1)), "pair 2+2 saved");
  await until(() => model.open().some((call) => label(call) === "[n1-0]+[p2-3]"), "top pair");
  model.take("[n1-0]", "[p2-3]").resolve("[p0-3]".padEnd(8_000, "."));
  await until(() => store.nodes.has(nodeKey(2, 0)), "top pair saved");
  // Available parents alone do not compact a context exactly at upper.
  append(4);
  await until(() => model.open().length === 1, "leaf 4");
  expect(contextBytes(model.take("[m4]").request.context)).toBe(32_000);
  model.take("[m4]").resolve(summary("s4"));
  await until(() => store.nodes.has(nodeKey(0, 4)), "leaf 4 saved");
  append(5);
  await until(() => model.open().length === 1, "leaf 5");
  const after = model.take("[m5]");
  expect(chatLines(after.request.context)).toEqual([`0+4|${"[p0-3]".padEnd(8_000, ".")}`, `4+1|${summary("s4")}`]);
  expect(contextBytes(after.request.context)).toBe(8_012);
  expect(memory.status().viewBytes).toBeGreaterThan(32_000);
});

test("view budget counts UTF-8 bytes of summaries, not UTF-16 units", async () => {
  const store = await openStore();
  store.append("user", "[m0] seeded message");
  store.append("user", "[m1] seeded message");
  saveText(store, 0, 0, "é".repeat(10));
  saveText(store, 0, 1, "é".repeat(10));
  saveText(store, 1, 0, "p");
  const model = new Model();

  // 40 bytes in 20 UTF-16 units.
  const tight = memoryFor(store, model, { viewBytes: 30 });
  expect(addresses(tight)).toEqual(["0+2"]);
  expect(tight.status().viewBytes).toBe(1);
  await tight.close();

  const restored = memoryFor(store, model, { viewBytes: 40 });
  expect(addresses(restored)).toEqual(["0+2"]); // a larger budget never splits a saved tiling
  expect(restored.status().viewBytes).toBe(1);

  const separate = await openStore();
  seedTree(separate, 2, (l) => l === 0 ? "é".repeat(10) : "p");
  const roomy = memoryFor(separate, new Model(), { viewBytes: 40 });
  expect(addresses(roomy)).toEqual(["0+1", "1+1"]);
  expect(roomy.status().viewBytes).toBe(40);
});

test("zoom of one message returns bounded byte pages whose cursor reassembles the exact source", async () => {
  const store = await openStore();
  const big = Array.from({ length: 1_500 }, (_, k) => `línea ${k}: résumé 🙂 payload`).join("\n");
  store.append("user", big);
  const memory = memoryFor(store, new Model(), { nodeBytes: 16 });

  const pages: string[] = [];
  let offset = 0;
  for (let guard = 0; guard < 100; guard++) {
    const page = memory.zoom(0, 1, offset);
    expect(page.offset).toBe(offset);
    expect(page.totalBytes).toBe(utf8Bytes(big));
    expect(utf8Bytes(page.text)).toBeLessThanOrEqual(16_384);
    pages.push(page.text);
    if (page.next === null) break;
    expect(page.next).toBeGreaterThan(offset);
    offset = page.next;
  }
  expect(pages.length).toBeGreaterThan(1);
  expect(pages.join("")).toBe(big);
  // A cursor inside a code point is an invalid boundary, not a replacement character.
  expect(() => memory.zoom(0, 1, 2)).toThrow();
});

test("zoom returns whole short messages and both children for n>1; offsets apply only to n=1", async () => {
  const store = await openStore();
  const dates = Array.from({ length: 6 }, (_, i) => new Date(2026, 0, 2 + i, 3, 4, 5, 6));
  const messages = [
    ["user", "short user"],
    ["talk", "short reply"],
    ["tool", "read file"],
    ["echo", "file body"],
    ["user", "next"],
    ["user", "[m5] unsummarized tail message"],
  ] as const;
  messages.forEach(([kind, text], i) => store.append(kind, text, dates[i]));
  saveText(store, 0, 0, "user: digest\nsecond line");
  saveText(store, 0, 1, "leaf one");
  saveText(store, 0, 2, "leaf two");
  saveText(store, 0, 3, "leaf three");
  saveText(store, 0, 4, "leaf four");
  saveText(store, 1, 0, "pair zero one");
  saveText(store, 1, 1, "pair two three");
  saveText(store, 2, 0, "quad zero to three");
  const memory = memoryFor(store, new Model(), { nodeBytes: 16 });

  expect(memory.zoom(1, 1)).toEqual({ text: "short reply", next: null, totalBytes: 11, offset: 0 });
  expect(memory.zoom(5, 1)).toEqual({
    text: "[m5] unsummarized tail message",
    next: null,
    totalBytes: utf8Bytes("[m5] unsummarized tail message"),
    offset: 0,
  });
  expect(memory.zoom(0, 2)).toEqual({
    text: "0+1|user: digest second line\n1+1|leaf one",
    next: null,
    totalBytes: utf8Bytes("0+1|user: digest second line\n1+1|leaf one"),
    offset: 0,
  });
  expect(memory.zoom(2, 2).text).toBe("2+1|leaf two\n3+1|leaf three");
  expect(memory.zoom(0, 4).text).toBe("0+2|pair zero one\n2+2|pair two three");
  expect(() => memory.zoom(0, 2, 1)).toThrow("offset applies only to single-message zoom");

  const invalid: Array<[number, number]> = [
    [4, 2], // message 5 has no summary yet
    [0, 8],
    [4, 4],
    [6, 1],
    [-1, 1],
    [1.5, 1],
    [Number.NaN, 1],
    [0, 0],
    [0, 3],
    [2, 4],
    [1, 2],
  ];
  for (const [id, n] of invalid) expect(() => memory.zoom(id, n)).toThrow(`No line ${id}+${n}.`);

  dates.forEach((date, i) => expect(memory.date(i)).toBe(date.toLocaleString()));
  for (const id of [-1, 6, 0.5]) expect(memory.date(id)).toBe(`No message ${id}.`);
});

test("append forwards work metadata to the stored record and it survives restart", async () => {
  const store = await openStore();
  const memory = memoryFor(store, new Model(), { nodeBytes: 16 });
  const metadata = { work: { source: "task", completeness: "full", id: "w1" } } as const;
  const message = memory.append("work", "done", undefined, metadata);
  expect(message.metadata).toEqual(metadata);
  await memory.close();

  const restored = await reopen(store);
  expect(restored.messages[message.i]!.metadata).toEqual(metadata);
});

describe("terminal compressor refusal stand-ins", () => {
  const marker = "[unsummarized: compressor refused] ";

  test("leaf refusal saves a bounded UTF-8 source prefix and preserves exact zoom text", async () => {
    const store = await openStore();
    const reports: string[] = [];
    const model = new Model();
    // 語 (3) + 🙂 (4) + é (2) = 9 bytes; the next 漢 spans bytes 9..12.
    // Eleven excerpt bytes must stop before 漢, not emit a replacement character.
    const nodeBytes = Buffer.byteLength(marker, "utf8") + 11;
    const original = "語🙂é漢字🌍".repeat(12);
    const memory = memoryFor(store, model, {
      nodeBytes,
      pageBytes: 1_024,
      report: (message) => reports.push(message),
    });
    const message = memory.append("user", original);
    await until(() => model.open().length === 1, "leaf request");
    model.take("compress message 0").reject(new CompressorRefusedError());

    expect(await memory.settle()).toBe(true);
    expect(store.nodes.has(nodeKey(0, message.i))).toBe(true);
    const node = store.nodes.get(nodeKey(0, message.i))!;
    expect(node.text.startsWith(marker)).toBe(true);
    const excerpt = node.text.slice(marker.length);
    expect(excerpt).toBe("語🙂é");
    expect(original.startsWith(excerpt)).toBe(true);
    expect(excerpt).not.toContain("\uFFFD");
    expect(Buffer.byteLength(node.text, "utf8")).toBeLessThanOrEqual(nodeBytes);
    expect(node.size).toBe(Buffer.byteLength(node.text, "utf8"));
    expect(memory.status().extractive).toBe(1);
    expect(reports).toHaveLength(1);
    expect(reports[0]!.startsWith("unsummarized at 0+1:")).toBe(true);
    expect(memory.zoom(message.i, 1)).toEqual({
      text: original,
      next: null,
      totalBytes: Buffer.byteLength(original, "utf8"),
      offset: 0,
    });
  });

  test("merge refusal preserves fragments of both children and completes the tree", async () => {
    const store = await openStore();
    const left = "LEFT-child:" + "a".repeat(21);
    const right = "RIGHT-child:" + "b".repeat(20);
    const nodeBytes = 64;
    const model = new Model();
    const memory = memoryFor(store, model, { nodeBytes, pageBytes: 1_024 });
    memory.append("user", "[m0] " + "left raw detail ".repeat(20));
    memory.append("user", "[m1] " + "right raw detail ".repeat(20));
    await until(() => model.open().length === 2, "two leaf requests");
    model.take("[m0]").resolve(left);
    model.take("[m1]").resolve(right);
    await until(() => model.open().length === 1, "merge request");
    const merge = model.take("merge lines 0+1 and 1+1");
    expect(inputOf(merge)).toBe(`${left}\n${right}`);
    merge.reject(new CompressorRefusedError());

    // Each child is 32 bytes, but their newline-joined parent is 65 > 64.
    expect(Buffer.byteLength(`${left}\n${right}`, "utf8")).toBe(nodeBytes + 1);
    expect(await memory.settle()).toBe(true);
    expect(store.nodes.get(nodeKey(0, 0))!.text).toBe(left);
    expect(store.nodes.get(nodeKey(0, 1))!.text).toBe(right);
    // settle() resolves once every leaf is built; the refused merge may still be in flight.
    await until(() => store.nodes.has(nodeKey(1, 0)), "refused merge stand-in");
    const parent = store.nodes.get(nodeKey(1, 0))!;
    expect(parent.text.startsWith(marker)).toBe(true);
    expect(parent.text).toContain("LEFT-child:");
    expect(parent.text).toContain("RIGHT-child:");
    expect(Buffer.byteLength(parent.text, "utf8")).toBeLessThanOrEqual(nodeBytes);
    expect(parent.size).toBe(Buffer.byteLength(parent.text, "utf8"));
    expect(store.nodes.size).toBe(3);
    await until(() => memory.status().pending === 0, "merge job drained");
    expect(memory.status()).toMatchObject({ messages: 2, nodes: 3, pending: 0, extractive: 1 });
  });

  test("ordinary HTTP failure saves no stand-in and recovers on the next append", async () => {
    const store = await openStore();
    const model = new Model();
    const reports: string[] = [];
    const memory = memoryFor(store, model, {
      nodeBytes: 64,
      pageBytes: 1_024,
      report: (message) => reports.push(message),
    });
    const original = "[m0] " + "failed raw detail ".repeat(10);
    memory.append("user", original);
    await until(() => model.open().length === 1, "initial leaf request");
    model.take("[m0]").reject(new Error("HTTP 500"));

    expect(await memory.settle()).toBe(false);
    expect(store.nodes.has(nodeKey(0, 0))).toBe(false);
    expect(store.nodes.size).toBe(0);
    expect(memory.status().extractive).toBe(0);
    expect(reports).toEqual([
      "OptChat compaction failed at 0+1; retrying on the next appended message: HTTP 500",
    ]);
    expect(model.calls).toHaveLength(1);

    memory.append("user", "[m1] " + "new raw detail ".repeat(10));
    await until(() => model.open().length === 2, "failed leaf retry and new leaf request");
    expect(inputOf(model.take("[m0]"))).toBe(`user: ${original}`);
    model.take("[m0]").resolve("recovered leaf");
    model.take("[m1]").resolve("new leaf");
    expect(await memory.settle()).toBe(true);
    expect(store.nodes.get(nodeKey(0, 0))!.text).toBe("recovered leaf");
    expect(store.nodes.get(nodeKey(0, 1))!.text).toBe("new leaf");
    expect(store.nodes.get(nodeKey(1, 0))!.text).toBe("recovered leaf\nnew leaf");
    await until(() => memory.status().pending === 0, "recovered merge job drained");
    expect(memory.status()).toMatchObject({ messages: 2, nodes: 3, pending: 0, extractive: 0 });
    expect(model.calls).toHaveLength(3);
    expect(reports).toHaveLength(1);
  });

  test("second-page refusal excerpts the whole original rather than the first-page summary", async () => {
    const store = await openStore();
    const model = new Model();
    const original = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".repeat(3);
    const pageBytes = 16;
    const nodeBytes = Buffer.byteLength(marker, "utf8") + 20;
    const memory = memoryFor(store, model, { nodeBytes, pageBytes });
    memory.append("user", original);
    // The 84-byte source includes the six-byte role prefix; it exceeds both budgets.
    expect(utf8Bytes(`user: ${original}`)).toBe(84);
    expect(utf8Bytes(`user: ${original}`)).toBeGreaterThan(nodeBytes);
    expect(utf8Bytes(`user: ${original}`)).toBeGreaterThan(pageBytes);
    await until(() => model.open().length === 1, "first source page");
    const first = model.take("part 1,");
    expect(inputOf(first)).toBe("user: ABCDEFGHIJ");
    expect(first.request.instruction).toContain("source bytes 0 to 16 of 84");
    first.resolve("partial digest");

    await until(() => model.open().length === 1, "second source page");
    const second = model.take("part 2,");
    expect(inputOf(second)).toBe("KLMNOPQRSTUVWXYZ");
    expect(second.request.instruction).toContain("source bytes 16 to 32 of 84");
    second.reject(new CompressorRefusedError());
    expect(await memory.settle()).toBe(true);
    expect(model.calls).toHaveLength(2);
    const node = store.nodes.get(nodeKey(0, 0))!;
    // The stand-in is the whole original message, not the first-page summary: 55 - 35 marker bytes leave 20.
    expect(node.text).toBe(`${marker}ABCDEFGHIJKLMNOPQRST`);
    expect(node.text).not.toContain("partial digest");
    expect(Buffer.byteLength(node.text, "utf8")).toBe(nodeBytes);
    expect(node.size).toBe(nodeBytes);
    expect(memory.status()).toMatchObject({ nodes: 1, pending: 0, extractive: 1 });
  });
});
