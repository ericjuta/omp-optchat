import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Memory, utf8Bytes, utf8Prefix, type CompactionRequest, type MemoryOptions, type Summarize } from "../src/memory.ts";
import { SCALE } from "../src/prompts.ts";
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

test("compactor sees only built summary lines without addresses, and its whole input", async () => {
  const store = await openStore();
  const model = new Model();
  const memory = memoryFor(store, model, { nodeBytes: 16, jobs: 1, viewBytes: 1_000_000 });
  const big = Array.from({ length: 1_500 }, (_, k) => `línea ${k}: résumé 🙂 payload`).join("\n");
  expect(utf8Bytes(big)).toBeGreaterThan(40_000);
  const texts = ["[m0] first request about the parser", `[m1] ${big}`, "[m2] reply about the results"];
  memory.append("user", texts[0]!);
  memory.append("echo", texts[1]!);
  memory.append("talk", texts[2]!);
  expect(utf8Bytes(SCALE)).toBe(512);

  await until(() => model.calls.length === 1, "leaf 0");
  const leaf0 = model.calls[0]!;
  expect(chatLines(leaf0.request.context)).toEqual([]);
  expect(leaf0.request.instruction).toContain(`\nuser: ${texts[0]}`);
  expect(leaf0.request.instruction).toContain(SCALE);
  expect(leaf0.request.instruction).toContain("at most 16 bytes");
  expect(leaf0.request.feedback).toEqual([]);
  leaf0.resolve("[s0] alpha\nbeta");

  await until(() => model.calls.length === 2, "leaf 1");
  const leaf1 = model.calls[1]!;
  // Prior line flattened, no id+n| prefix, and no raw text of either message.
  expect(chatLines(leaf1.request.context)).toEqual(["[s0] alpha beta"]);
  expect(leaf1.request.context).not.toContain("[m0]");
  expect(leaf1.request.context).not.toContain("línea");
  expect(leaf1.request.context).not.toContain(PLACEHOLDER);
  // The 40 KB message arrives whole, newlines kept, never cut.
  expect(leaf1.request.instruction).toContain(`\necho: ${texts[1]}`);
  leaf1.resolve("[s1] gamma");

  await until(() => model.calls.length === 3, "leaf 2 before the merge");
  const leaf2 = model.calls[2]!;
  expect(label(leaf2)).toBe("[m2]");
  expect(chatLines(leaf2.request.context)).toEqual(["[s0] alpha beta", "[s1] gamma"]);
  leaf2.resolve("[s2] delta");

  await until(() => model.calls.length === 4, "merge 0+2");
  const merge = model.calls[3]!;
  // Context ends at the merge's last message even though message 2 is already summarized.
  expect(chatLines(merge.request.context)).toEqual(["[s0] alpha beta", "[s1] gamma"]);
  expect(merge.request.instruction).toContain("\n[s0] alpha beta\n[s1] gamma");
  expect(merge.request.instruction).not.toContain("[s2]");
  expect(merge.request.instruction).toContain(SCALE);

  for (const call of model.calls) {
    expect(call.request.context).not.toMatch(coordinates);
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
  expect(chatLines(merge.request.context)).toEqual([leaf0, leaf1, "[s2] short", leaf3]);
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
  expect(cut).toMatch(/limit is 20\b/);
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

test("live fit merges the most due built pair on append and on build, passes over unbuilt parents, and never splits", async () => {
  const store = await openStore();
  const model = new Model();
  // Leaf replies are 10 bytes, merge replies 6, a placeholder 29; tries 1 keeps one call per node.
  const memory = memoryFor(store, model, { nodeBytes: 8, viewBytes: 40, tries: 1 });
  const expectView = async (view: string[], bytes: number) => {
    await flush();
    expect(addresses(memory)).toEqual(view);
    expect(memory.status().viewBytes).toBe(bytes);
  };
  const append = async (i: number) => {
    memory.append("user", `[m${i}] a long user message`);
    await until(() => model.open().some((call) => label(call) === `[m${i}]`), `leaf ${i} call`);
  };
  const leaf = async (i: number) => {
    model.take(`[m${i}]`).resolve(`[s${i}]`.padEnd(10, "."));
    await until(() => store.nodes.has(nodeKey(0, i)), `leaf ${i}`);
  };
  const merge = async (l: number, i: number, markers: string[], reply: string) => {
    model.take(...markers).resolve(reply);
    await until(() => store.nodes.has(nodeKey(l, i)), `merge ${l}:${i}`);
  };

  await append(0);
  await expectView(["0+1"], 29);
  await leaf(0);
  await expectView(["0+1"], 10);
  await append(1);
  await leaf(1);
  await expectView(["0+1", "1+1"], 20);
  await append(2);
  await expectView(["0+1", "1+1", "2+1"], 49); // over budget, but 0+2 is not built yet
  await leaf(2);
  await append(3);
  await leaf(3);
  await append(4);
  await expectView(["0+1", "1+1", "2+1", "3+1", "4+1"], 69);
  await leaf(4);
  await expectView(["0+1", "1+1", "2+1", "3+1", "4+1"], 50);

  // Building 2+2 refits: the older 0|1 pair is passed over because its parent is unbuilt.
  await merge(1, 1, ["[s2]", "[s3]"], "[p2-3]");
  await expectView(["0+1", "1+1", "2+2", "4+1"], 36);
  // Under budget, a newly built parent does not coarsen anything.
  await merge(1, 0, ["[s0]", "[s1]"], "[p0-1]");
  await expectView(["0+1", "1+1", "2+2", "4+1"], 36);

  await append(5);
  await expectView(["0+2", "2+2", "4+1", "5+1"], 51);
  await leaf(5);
  await expectView(["0+2", "2+2", "4+1", "5+1"], 32);
  await append(6);
  await expectView(["0+2", "2+2", "4+1", "5+1", "6+1"], 61);
  await merge(2, 0, ["[p0-1]", "[p2-3]"], "[p0-3]");
  await expectView(["0+4", "4+1", "5+1", "6+1"], 55);
  await merge(1, 2, ["[s4]", "[s5]"], "[p4-5]");
  await expectView(["0+4", "4+2", "6+1"], 41);
  await leaf(6);
  await expectView(["0+4", "4+2", "6+1"], 22);
});

test("live view stays an aligned tiling that never splits and fits whenever a built pair can merge", async () => {
  const store = await openStore();
  let replies = 0;
  const model = new Model({ auto: () => "r".repeat(3 + ((replies++ * 7) % 10)) }); // 3..12 bytes
  const viewBytes = 60;
  const memory = memoryFor(store, model, { nodeBytes: 12, viewBytes });
  const fullTree = (t: number) => {
    let count = 0;
    for (let width = 1; width <= t; width *= 2) count += Math.floor(t / width);
    return count;
  };

  let previous: Array<[number, number]> = [];
  for (let t = 1; t <= 40; t++) {
    memory.append(t % 3 === 0 ? "talk" : "user", `message ${t} ${"x".repeat(t)}`);
    await until(() => store.nodes.size === fullTree(t) && memory.status().pending === 0, `tree for ${t} messages`);
    await flush();
    const lines = chatLines(memory.render());
    const parts = lines.map((line): [number, number] => {
      const [id, n] = line.slice(0, line.indexOf("|")).split("+").map(Number);
      return [id!, n!];
    });

    let next = 0;
    for (const [id, n] of parts) {
      expect(id).toBe(next);
      expect(n & (n - 1)).toBe(0);
      expect(id % n).toBe(0);
      next = id + n;
    }
    expect(next).toBe(t);
    for (const [id, n] of previous) {
      expect(parts.some(([start, width]) => start <= id && id + n <= start + width)).toBe(true);
    }
    const bytes = lines.reduce((sum, line) => sum + utf8Bytes(line.slice(line.indexOf("|") + 1)), 0);
    expect(memory.status().viewBytes).toBe(bytes);
    expect(memory.render()).not.toContain(PLACEHOLDER);
    // With every parent built, an over-budget view must have no mergeable pair left.
    const mergeable = parts.some(([id, n], k) => parts[k + 1]?.[1] === n && id % (2 * n) === 0);
    if (bytes > viewBytes) expect(mergeable).toBe(false);
    previous = parts;
  }
});

// Each stored message folds with the history length it had when appended, not today's length.
const replays = [
  {
    // At T=6 the view [0+2, 2+2, 4, 5] is over budget. Historical due: level-1 pair 6/8
    // beats leaves 4|5 at 2/4. Replaying with T=10 (or fitting once at the end) would
    // instead pick 4|5 (6/4 > 10/8) and keep 0+2, 2+2, 4+2.
    name: "historical age",
    leaves: [12, 12, 12, 12, 12, 12, 1, 1, 1, 1],
    levels: [0, 3, 4, 5],
    viewBytes: 18,
    view: ["0+4", "4+2", "6+1", "7+1", "8+1", "9+1"],
    bytes: 11,
  },
  {
    // At T=10 the view is 21 bytes; dues: 0+2|2+2 10/8, 4|5 6/4, 6|7 4/4, 8|9 2/4.
    // The most due pair is neither the first nor the newest candidate.
    name: "most due pair",
    leaves: [6, 6, 6, 6, 8, 1, 1, 1, 1, 7],
    levels: [0, 1, 1, 1],
    viewBytes: 20,
    view: ["0+2", "2+2", "4+2", "6+1", "7+1", "8+1", "9+1"],
    bytes: 13,
  },
];

for (const replay of replays) {
  test(`load replays append and fit per message: ${replay.name}`, async () => {
    const seeded = await openStore();
    const t = replay.leaves.length;
    for (let i = 0; i < t; i++) seeded.append("user", `[m${i}] seeded message`);
    for (let l = 0, width = 1; width <= t; l++, width *= 2) {
      for (let i = 0; (i + 1) * width <= t; i++) {
        const bytes = l === 0 ? replay.leaves[i]! : replay.levels[l]!;
        saveText(seeded, l, i, String.fromCharCode(l === 0 ? 97 + i : 64 + l).repeat(bytes));
      }
    }
    const store = await reopen(seeded);
    const model = new Model();
    const memory = memoryFor(store, model, { viewBytes: replay.viewBytes });

    expect(addresses(memory)).toEqual(replay.view);
    await flush();
    expect(model.calls).toHaveLength(0);
    expect(memory.status()).toEqual({
      messages: t,
      nodes: store.nodes.size,
      pending: 0,
      viewBytes: replay.bytes,
      parts: replay.view.length,
    });
  });
}

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

  const roomy = memoryFor(store, model, { viewBytes: 40 });
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
