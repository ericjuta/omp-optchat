import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Memory, utf8Bytes, utf8Prefix, type CompactionRequest, type MemoryOptions, type Summarize } from "../src/memory.ts";
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

function saveView(store: Store, parts: ReadonlyArray<readonly [number, number]>, compacting = false): void {
  store.saveView({ version: 1, length: store.messages.length, parts, compacting });
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

interface RetryWait {
  readonly ms: number;
  readonly signal: AbortSignal;
  release(): void;
}

/** Injected retry clock: waits end only when the test releases them or Memory aborts them. */
class Clock {
  readonly waits: RetryWait[] = [];

  readonly wait = (ms: number, signal: AbortSignal): Promise<void> => {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const abort = () => reject(new Error("retry wait aborted"));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    this.waits.push({
      ms,
      signal,
      release: () => {
        signal.removeEventListener("abort", abort);
        resolve();
      },
    });
    return promise;
  };
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

const coordinates = /\d+\+\d+\|/;

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

test("leaves compact one at a time in order while merges of finished parts run alongside", async () => {
  const store = await openStore();
  const model = new Model();
  const memory = memoryFor(store, model, { nodeBytes: 16, jobs: 8, viewBytes: 100_000 });
  for (let i = 0; i < 4; i++) memory.append("user", `[m${i}] a long user message`);

  const expectOpen = async (labels: string[]) => {
    const expected = [...labels].sort();
    await until(() => model.labels().join() === expected.join(), () => `${expected} (open: ${model.labels()})`);
    await flush();
    expect(model.labels()).toEqual(expected);
  };

  // Free job slots do not start later leaves: each waits for every earlier view line.
  await expectOpen(["[m0]"]);
  model.take("[m0]").resolve(summary("s0"));
  await expectOpen(["[m1]"]);
  model.take("[m1]").resolve(summary("s1"));
  await expectOpen(["[m2]", "[s0]+[s1]"]);
  model.take("[m2]").resolve(summary("s2"));
  await expectOpen(["[m3]", "[s0]+[s1]"]);
  model.take("[m3]").resolve(summary("s3"));
  await expectOpen(["[s0]+[s1]", "[s2]+[s3]"]);
  model.take("[s0]", "[s1]").resolve(summary("p0-1"));
  await expectOpen(["[s2]+[s3]"]);
  model.take("[s2]", "[s3]").resolve(summary("p2-3"));
  await expectOpen(["[p0-1]+[p2-3]"]);
  model.take("[p0-1]", "[p2-3]").resolve(summary("p0-3"));
  await until(() => store.nodes.size === 7, "complete four-message tree");

  expect(model.calls.map(label).filter((name) => name.startsWith("[m"))).toEqual(["[m0]", "[m1]", "[m2]", "[m3]"]);
  expect(model.calls).toHaveLength(7);
  expect(model.peak).toBe(2);
});

test("merges run concurrently but never beyond the job cap", async () => {
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

test("compactor sees only addressed built summary lines and its whole input", async () => {
  const store = await openStore();
  const model = new Model();
  const memory = memoryFor(store, model, { nodeBytes: 16, jobs: 1, viewBytes: 1_000_000 });
  const big = Array.from({ length: 1_500 }, (_, k) => `línea ${k}: résumé 🙂 payload`).join("\n");
  expect(utf8Bytes(big)).toBeGreaterThan(40_000);
  const texts = ["[m0] first request about the parser", `[m1] ${big}`, "[m2] reply about the results"];
  memory.append("user", texts[0]!);
  memory.append("echo", texts[1]!);
  memory.append("talk", texts[2]!);
  const ruler = "-".repeat(512);

  await until(() => model.calls.length === 1, "leaf 0");
  const leaf0 = model.calls[0]!;
  expect(chatLines(leaf0.request.context)).toEqual([]);
  expect(leaf0.request.instruction).toContain(`<input>\nuser: ${texts[0]}\n</input>`);
  expect(leaf0.request.instruction.split("\n")).toContain(ruler);
  expect(leaf0.request.instruction).toContain("at most 16 bytes");
  expect(leaf0.request.instruction).toContain("fixed 512-byte reference; the numeric limit above is authoritative");
  expect(leaf0.request.feedback).toEqual([]);
  leaf0.resolve("[s0] alpha\nbeta");

  await until(() => model.calls.length === 2, "leaf 1");
  const leaf1 = model.calls[1]!;
  // Prior line uses the main view's address format, flattened without raw text.
  expect(chatLines(leaf1.request.context)).toEqual(["0+1|[s0] alpha beta"]);
  expect(leaf1.request.context).not.toContain("[m0]");
  expect(leaf1.request.context).not.toContain("línea");
  expect(leaf1.request.context).not.toContain(PLACEHOLDER);
  // The 40 KB message arrives whole, newlines kept, never cut.
  expect(leaf1.request.instruction).toContain(`<input>\necho: ${texts[1]}\n</input>`);
  leaf1.resolve("[s1] gamma");

  await until(() => model.calls.length === 3, "leaf 2 before the merge");
  const leaf2 = model.calls[2]!;
  expect(label(leaf2)).toBe("[m2]");
  expect(chatLines(leaf2.request.context)).toEqual(["0+1|[s0] alpha beta", "1+1|[s1] gamma"]);
  leaf2.resolve("[s2] delta");

  await until(() => model.calls.length === 4, "merge 0+2");
  const merge = model.calls[3]!;
  // Context ends at the merge's last message even though message 2 is already summarized.
  expect(chatLines(merge.request.context)).toEqual(["0+1|[s0] alpha beta", "1+1|[s1] gamma"]);
  expect(merge.request.instruction).toContain("<input>\n[s0] alpha beta\n[s1] gamma\n</input>");
  expect(merge.request.instruction).toContain("merge lines 0+1 and 1+1, adjacent,");
  expect(merge.request.instruction).toContain("take details\nof them from there too");
  expect(merge.request.instruction).not.toContain("[s2]");
  expect(merge.request.instruction.split("\n")).toContain(ruler);

  for (const call of model.calls) {
    for (const line of chatLines(call.request.context)) expect(line).toMatch(/^\d+\+\d+\|/);
    expect(call.request.instruction).not.toMatch(coordinates);
  }
  // Even a summarized message never enters the view whole.
  expect(memory.render()).not.toContain("línea");
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
  // A free leaf is still gated behind the unsummarized message before it.
  expect(store.nodes.has(nodeKey(0, 3))).toBe(false);

  model.calls[0]!.resolve("[s2] short");
  await until(() => model.calls.length === 2, "merge 0+4");
  expect(store.nodes.get(nodeKey(0, 3))?.text).toBe(leaf3);
  expect(store.nodes.get(nodeKey(1, 1))?.text).toBe(`[s2] short\n${leaf3}`);
  const merge = model.calls[1]!;
  // 40 + 1 + 31 bytes exceeds the target, so the top merge asks the model.
  expect(merge.request.instruction).toContain(`\n${leaf0} ${leaf1}\n[s2] short ${leaf3}`);
  expect(chatLines(merge.request.context)).toEqual([`0+1|${leaf0}`, `1+1|${leaf1}`, "2+1|[s2] short", `3+1|${leaf3}`]);
});

test("size enforcement trims only, cuts feedback at the limit, keeps the shortest try, and stops early", async () => {
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
  expect(third.request.feedback.map((turn) => turn.reply.trim())).toEqual(["x".repeat(30), "y".repeat(25)]);
  expect(third.request.feedback[1]!.instruction).toContain(`\n${"y".repeat(20)}| ← LIMIT`);
  third.resolve("z".repeat(27));

  // All tries over the target: keep the shortest whole, not the last and not a cut.
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
  const secondCut = model.calls[2]!.request.feedback[1]!.instruction;
  expect(secondCut).toContain("12 bytes");
  expect(secondCut).toContain("\nabc🙂| ← LIMIT");

  model.calls[2]!.resolve("abcdefgh"); // 8 bytes but 8 units: shortest only in bytes
  await until(() => store.nodes.has(nodeKey(0, 0)), "leaf saved");
  expect(store.nodes.get(nodeKey(0, 0))?.text).toBe("abcdefgh");
});

test("a failed node reports once, holds its slot through fixed retry waits, and close cancels the wait", async () => {
  const store = await openStore();
  for (let i = 0; i < 4; i++) store.append("user", `[m${i}] seeded long message`);
  for (let i = 0; i < 4; i++) saveText(store, 0, i, summary(`s${i}`));
  const model = new Model();
  const clock = new Clock();
  const reports: string[] = [];
  const memory = memoryFor(store, model, {
    nodeBytes: 16,
    jobs: 1,
    retryMs: 1_234,
    wait: clock.wait,
    report: (message) => reports.push(message),
  });

  await until(() => model.open().length === 1, "merge 0+2");
  model.take("[s0]", "[s1]").reject(new Error("provider down"));
  await until(() => clock.waits.length === 1, "first retry wait");
  await flush();
  expect(reports).toHaveLength(1);
  expect(reports[0]).toContain("provider down");
  expect(clock.waits[0]!.ms).toBe(1_234);
  expect(memory.status().pending).toBe(1);
  expect(model.calls).toHaveLength(1); // 2+2 is ready but the waiting retry holds the only slot

  clock.waits[0]!.release();
  await until(() => model.open().length === 1, "second try");
  model.take("[s0]", "[s1]").resolve("  \n "); // empty after trim: a failure, not a node
  await until(() => clock.waits.length === 2, "second retry wait");
  await flush();
  expect(reports).toHaveLength(1);
  expect(clock.waits[1]!.ms).toBe(1_234);
  expect(store.nodes.has(nodeKey(1, 0))).toBe(false);

  clock.waits[1]!.release();
  await until(() => model.open().length === 1, "third try");
  model.take("[s0]", "[s1]").resolve(summary("p0-1"));
  await until(() => store.nodes.has(nodeKey(1, 0)), "merge 0+2 saved");
  await until(() => model.open().length === 1, "merge 2+2");
  model.take("[s2]", "[s3]").reject(new Error("second node down"));
  await until(() => clock.waits.length === 3, "retry wait for 2+2");
  await flush();
  expect(reports).toHaveLength(2);
  expect(reports[1]).toContain("second node down");
  expect(clock.waits.map((wait) => wait.ms)).toEqual([1_234, 1_234, 1_234]);

  const calls = model.calls.length;
  const closing = track(memory.close());
  await until(() => closing.done, "close to cancel the retry wait");
  expect(closing.error).toBeUndefined();
  expect(clock.waits[2]!.signal.aborted).toBe(true);
  await flush();
  expect(model.calls).toHaveLength(calls);
  expect(store.nodes.has(nodeKey(1, 1))).toBe(false);
  expect(memory.status().pending).toBe(0);
  expect(reports).toHaveLength(2);
});

test("close cancels a real retry timer instead of waiting it out", async () => {
  const store = await openStore();
  const model = new Model();
  const reports: string[] = [];
  const memory = memoryFor(store, model, {
    nodeBytes: 16,
    retryMs: 2_147_483_647,
    report: (message) => reports.push(message),
  });
  memory.append("user", "[m0] a long user message");
  await until(() => model.open().length === 1, "leaf call");
  model.take("[m0]").reject(new Error("offline"));
  await until(() => reports.length === 1, "failure report");
  await flush();
  expect(memory.status().pending).toBe(1);

  const closing = track(memory.close());
  await until(() => closing.done, "close despite a 24-day retry timer");
  expect(model.calls).toHaveLength(1);
});

test("an unprintable rejection is still reported and retried", async () => {
  const store = await openStore();
  const model = new Model();
  const clock = new Clock();
  const reports: string[] = [];
  const memory = memoryFor(store, model, {
    nodeBytes: 16,
    retryMs: 777,
    wait: clock.wait,
    report: (message) => reports.push(message),
  });
  memory.append("user", "[m0] a long user message");
  await until(() => model.open().length === 1, "leaf call");
  model.take("[m0]").reject(Object.create(null)); // String() of it throws
  await until(() => clock.waits.length === 1, "retry wait");
  expect(reports).toHaveLength(1);
  expect(reports[0]).toContain("unprintable error");
  expect(clock.waits[0]!.ms).toBe(777);

  clock.waits[0]!.release();
  await until(() => model.open().length === 1, "retry call");
  model.take("[m0]").resolve(summary("s0"));
  await until(() => store.nodes.has(nodeKey(0, 0)), "leaf saved");
  expect(store.nodes.get(nodeKey(0, 0))?.text).toBe(summary("s0"));
  expect(model.calls).toHaveLength(2);
});

test("an async reporter's rejection is contained and the retry proceeds", async () => {
  const unhandled: unknown[] = [];
  const listener = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", listener);
  try {
    const store = await openStore();
    const model = new Model();
    const clock = new Clock();
    let reported = 0;
    const memory = memoryFor(store, model, {
      nodeBytes: 16,
      wait: clock.wait,
      report: async () => {
        reported++;
        throw new Error("reporter down");
      },
    });
    memory.append("user", "[m0] a long user message");
    await until(() => model.open().length === 1, "leaf call");
    model.take("[m0]").reject(new Error("offline"));
    await until(() => clock.waits.length === 1, "retry wait");
    await flush();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(reported).toBe(1);
    expect(unhandled).toEqual([]);

    clock.waits[0]!.release();
    await until(() => model.open().length === 1, "retry call");
    model.take("[m0]").resolve(summary("s0"));
    await until(() => store.nodes.has(nodeKey(0, 0)), "leaf saved");
    expect(model.calls).toHaveLength(2);
    expect(unhandled).toEqual([]);
  } finally {
    process.off("unhandledRejection", listener);
  }
});

for (const mode of ["discards", "returns"] as const) {
  test(`a reporter that ${mode} memory.close() does not deadlock the failing job`, async () => {
    const store = await openStore();
    const model = new Model();
    const clock = new Clock();
    const reporter: { closing?: Tracked<void> } = {};
    const memory: Memory = memoryFor(store, model, {
      nodeBytes: 16,
      wait: clock.wait,
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
    await flush();
    expect(clock.waits.every((wait) => wait.signal.aborted)).toBe(true);
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
  expect(store.viewSnapshot).toEqual({ version: 1, length: 10, parts: [[3, 0], [1, 4]], compacting: false });
  await flush();
  expect(model.calls).toHaveLength(0);
  await memory.close();

  const restoredStore = await reopen(store);
  const restored = memoryFor(restoredStore, new Model(), { viewBytes: 1_000 });
  expect(addresses(restored)).toEqual(["0+8", "8+2"]);
  expect(restored.status().viewBytes).toBe(24);
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
  const memory = memoryFor(store, model, { nodeBytes: 16_000 });
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

test("zoom validates addresses and returns whole messages or both child lines; date is local time", async () => {
  const store = await openStore();
  const big = Array.from({ length: 1_500 }, (_, k) => `línea ${k}: résumé 🙂 payload`).join("\n");
  expect(big.length).toBeGreaterThan(30_000);
  const dates = Array.from({ length: 6 }, (_, i) => new Date(2026, 0, 2 + i, 3, 4, 5, 6));
  const messages = [
    ["user", big],
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

  expect(memory.zoom(0, 1)).toBe(`0+0|user: ${big}`);
  expect(memory.zoom(1, 1)).toBe("1+0|talk: short reply");
  expect(memory.zoom(5, 1)).toBe("5+0|user: [m5] unsummarized tail message");
  expect(memory.zoom(0, 2)).toBe("0+1|user: digest second line\n1+1|leaf one");
  expect(memory.zoom(2, 2)).toBe("2+1|leaf two\n3+1|leaf three");
  expect(memory.zoom(0, 4)).toBe("0+2|pair zero one\n2+2|pair two three");
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
  for (const [id, n] of invalid) expect(memory.zoom(id, n)).toBe(`No line ${id}+${n}.`);

  dates.forEach((date, i) => expect(memory.date(i)).toBe(date.toLocaleString()));
  for (const id of [-1, 6, 0.5]) expect(memory.date(id)).toBe(`No message ${id}.`);
});
