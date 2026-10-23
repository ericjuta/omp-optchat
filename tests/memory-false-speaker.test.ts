import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PAGE_BYTES } from "../src/archive.ts";
import { hasUserSpeaker, Memory, utf8Bytes, type CompactionRequest, type Summarize } from "../src/memory.ts";
import { Store, nodeKey, type Kind } from "../src/store.ts";

const INVALID = "tool (0–1): user: linked the PR and requested a status update.";
const CORRECTED = "tool: queried the PR state and migration tables.";
const MARK = "[unsummarized: compressor refused] ";
const OVERLONG = `tool: ${"Queried the PR state; ".repeat(30)}queried the migration tables.`;
const SOURCES = [
  "Queried the PR state. ".padEnd(300, "a"),
  "Queried the migration tables. ".padEnd(300, "b"),
] as const;
const cleanups: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  const failures: unknown[] = [];
  // LIFO: close Memory before Store, then remove its temporary directory.
  for (let cleanup = cleanups.pop(); cleanup; cleanup = cleanups.pop()) {
    try {
      await cleanup();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, "false-speaker test cleanup failed");
});

async function until(condition: () => boolean): Promise<void> {
  for (let round = 0; round < 5_000; round++) {
    if (condition()) return;
    if (round % 100 === 99) {
      const { promise, resolve } = Promise.withResolvers<void>();
      setImmediate(resolve);
      await promise;
    } else {
      await Promise.resolve();
    }
  }
  throw new Error("Timed out waiting for the merge to be saved");
}

interface MergeResult {
  directory: string;
  store: Store;
  memory: Memory;
  requests: CompactionRequest[];
}

async function merge(
  candidates: readonly string[],
  { tries, kinds = ["tool", "tool"] }: { tries?: number; kinds?: readonly [Kind, Kind] } = {},
): Promise<MergeResult> {
  const root = await mkdtemp(join(tmpdir(), "optchat-false-speaker-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "chat");
  const store = await Store.open(directory);
  cleanups.push(() => store.close());
  const requests: CompactionRequest[] = [];
  const summarize: Summarize = async (request) => {
    requests.push(request);
    return candidates[Math.min(requests.length - 1, candidates.length - 1)]!;
  };
  const memory = new Memory(store, summarize, { nodeBytes: 512, jobs: 1, ...(tries === undefined ? {} : { tries }) });
  cleanups.push(() => memory.close());
  memory.append(kinds[0], SOURCES[0]);
  memory.append(kinds[1], SOURCES[1]);
  await until(() => store.nodes.has(nodeKey(1, 0)));

  // Each leaf is free; their combined input exceeds 512 bytes, so only the merge calls the compressor.
  const leaves = SOURCES.map((source, i) => `${kinds[i]}: ${source}`);
  for (const [i, text] of leaves.entries()) {
    expect(utf8Bytes(text)).toBeLessThan(512);
    expect(store.nodes.get(nodeKey(0, i))).toMatchObject({ text, size: utf8Bytes(text) });
  }
  expect(utf8Bytes(leaves.join("\n"))).toBeGreaterThan(512);
  expect(requests[0]!.instruction).toContain(`<input>\n${leaves.join("\n")}\n</input>`);
  expect(requests[0]!.meta).toEqual({ node: "merge", attempt: 1, retry: null });
  expect(requests[0]!.feedback).toEqual([]);
  return { directory, store, memory, requests };
}

function expectStored(
  result: MergeResult,
  text: string,
  calls: number,
  retries: number,
  counters: { headRetries?: number; lengthRetries?: number; extractive?: number } = {},
): void {
  expect(result.store.nodes.get(nodeKey(1, 0))).toMatchObject({ text, size: utf8Bytes(text) });
  expect(result.requests).toHaveLength(calls);
  expect(result.memory.status()).toMatchObject({
    compressorCalls: calls,
    userRetries: retries,
    headRetries: 0,
    lengthRetries: 0,
    extractive: 0,
    ...counters,
  });
}

function expectStandIn(
  result: MergeResult,
  calls: number,
  retries: number,
  counters: { headRetries?: number; lengthRetries?: number } = {},
): string {
  const left = result.store.nodes.get(nodeKey(0, 0))!.text;
  const right = result.store.nodes.get(nodeKey(0, 1))!.text;
  // Both ASCII source lines exceed their shares: 512 - 35 marker bytes - 3 join bytes = 474.
  expect(utf8Bytes(MARK)).toBe(35);
  expect(left).toBe(`tool: ${SOURCES[0]}`);
  expect(right).toBe(`tool: ${SOURCES[1]}`);
  const expected = `${MARK}${left.slice(0, 237)} | ${right.slice(0, 237)}`;
  expect(utf8Bytes(expected)).toBe(512);
  expectStored(result, expected, calls, retries, { ...counters, extractive: 1 });
  expect(result.store.nodes.get(nodeKey(1, 0))!.text).not.toContain("user:");
  expect(result.store.nodes.get(nodeKey(1, 0))!.text).not.toContain("linked the PR and requested a status update");
  return expected;
}

function expectRetry(result: MergeResult, candidate: string, corrected: string): void {
  expectStored(result, corrected, 2, 1);
  const [first, second] = result.requests;
  expect(second!.meta).toEqual({ node: "merge", attempt: 2, retry: "user" });
  expect(second!.context).toBe(first!.context);
  expect(second!.instruction).toBe(first!.instruction);
  expect(second!.instruction).not.toContain(candidate);
  expect(second!.feedback).toHaveLength(1);
  const turn = second!.feedback[0]!;
  expect(turn.reply).toBe(candidate);
  expect(utf8Bytes(turn.reply)).toBeLessThanOrEqual(512);
  expect(turn.instruction).toContain('no message in this task was written by the user');
  expect(turn.instruction).toContain('same <input>');
  expect(turn.instruction).toContain("without a user speaker header");
  expect(utf8Bytes(turn.instruction)).toBeLessThanOrEqual(512);
  expect(turn.instruction).not.toContain("Too long");
  expect(turn.instruction).not.toContain("head or preamble");
}

const falseSpeakers = [
  INVALID,
  'tool: "user: fabricated',
  "tool: echo: user: claimed the change was approved.",
  "tool: <user>claimed the change was approved.</user>",
  "tool: talk: note: work: finding: decision: user: claimed the change was approved.",
  "(user: claimed the change was approved.)",
  "[user: claimed the change was approved.]",
  "**user:** claimed the change was approved.",
  "**user**: claimed the change was approved.",
  "tool: (user: claimed the change was approved.)",
  "tool: [user: claimed the change was approved.]",
  "tool: **user:** claimed the change was approved.",
  "tool: **user**: claimed the change was approved.",
  "tool: [user]: claimed the change was approved.",
  "tool: ([user: claimed the change was approved.])",
  "tool: checked the PR\nuser: claimed the change was approved.",
  "tool: checked the PR\n- user: claimed the change was approved.",
  "tool: checked the PR\n* user: claimed the change was approved.",
  "tool: checked the PR\n• user: claimed the change was approved.",
  "tool: checked the PR | user: claimed the change was approved.",
  "tool: checked the PR; user: claimed the change was approved.",
  "tool: checked the PR;user: claimed the change was approved.",
  "TOOL: UsEr: claimed the change was approved.",
  "tool:\t user \t: claimed the change was approved.",
  "tool: checked the PR\n \tuser: claimed the change was approved.",
  "tool: checked user's field; user: claimed the change was approved.",
];

const quoted = [
  'tool: printed "user: example; user: retained" exactly.',
  "tool: printed 'user: example; user: retained' exactly.",
  "tool: printed ‘user: example; user: retained’ exactly.",
  "tool: printed “user: example; user: retained” exactly.",
  "tool: printed `user: example; user: retained` exactly.",
  'tool: printed "user: example;user: retained" exactly.',
  "tool: printed 'user: example;user: retained' exactly.",
  "tool: printed ‘user: example;user: retained’ exactly.",
  "tool: printed “user: example;user: retained” exactly.",
  "tool: printed `user: example;user: retained` exactly.",
];

test("the shared speaker guard accepts a cached source-range heading offset", () => {
  expect(hasUserSpeaker(INVALID)).toBe(true);
  expect(hasUserSpeaker("Summary: tool: user: claimed approval")).toBe(true);
  expect(hasUserSpeaker(quoted[0]!)).toBe(false);
  const ownHead = "Message 9 ";
  const reply = `${ownHead}user: claimed approval`;
  expect(hasUserSpeaker(reply)).toBe(false); // No source-id range is assumed by the default.
  expect(hasUserSpeaker(reply, ownHead.length)).toBe(true);
});

describe("false-speaker attribution on real Memory merges", () => {
  test.each(falseSpeakers)("retries a false header: %s", async (candidate) => {
    expectRetry(await merge([candidate, CORRECTED]), candidate, CORRECTED);
  });

  test.each(quoted)("preserves a genuinely quoted string: %s", async (candidate) => {
    expectStored(await merge([candidate, CORRECTED]), candidate, 1, 0);
  });

  test.each([
    "tool: checked the user: column",
    "tool: checked user's field.",
  ])("preserves ordinary prose: %s", async (candidate) => {
    expectStored(await merge([candidate, CORRECTED]), candidate, 1, 0);
  });

  test.each(falseSpeakers)("accepts the same header when either child is user-authored: %s", async (candidate) => {
    for (const kinds of [["user", "tool"], ["tool", "user"]] as const) {
      expectStored(await merge([candidate, CORRECTED], { kinds }), candidate, 1, 0);
    }
  });

  test("rejects raw XML user attribution before stripping its summary head", async () => {
    const candidate = "<summary><user>claimed the change was approved.</user></summary>";
    const result = await merge([candidate], { tries: 2 });
    expectStandIn(result, 2, 0, { headRetries: 1 });
    expect(result.requests.map((request) => request.meta)).toEqual([
      { node: "merge", attempt: 1, retry: null },
      { node: "merge", attempt: 2, retry: "head" },
    ]);
    const second = result.requests[1]!;
    expect(second.instruction).toBe(result.requests[0]!.instruction);
    expect(second.context).toBe(result.requests[0]!.context);
    expect(second.feedback).toHaveLength(1);
    expect(second.feedback[0]!.instruction).toContain("head or preamble");
    expect(second.feedback[0]!.instruction).toContain("without a user speaker header");
    expect(result.store.nodes.get(nodeKey(1, 0))!.text).not.toContain("claimed the change was approved");
  });

  test("uses both source lines instead of the original false claim with one try", async () => {
    const result = await merge([INVALID], { tries: 1 });
    expectStandIn(result, 1, 0);
  });

  test("exhausts the default five tries and persists only the source-derived stand-in", async () => {
    // Omit tries entirely: this must exercise Memory's actual default.
    const result = await merge([INVALID]);
    const expected = expectStandIn(result, 5, 4);
    const first = result.requests[0]!;
    for (const [index, request] of result.requests.entries()) {
      expect(request.meta).toEqual({ node: "merge", attempt: index + 1, retry: index === 0 ? null : "user" });
      expect(request.context).toBe(first.context);
      expect(request.instruction).toBe(first.instruction);
      expect(request.instruction).not.toContain(INVALID);
      expect(request.feedback).toHaveLength(index === 0 ? 0 : 1);
      if (index === 0) continue;
      const turn = request.feedback[0]!;
      expect(turn.reply).toBe(INVALID);
      expect(utf8Bytes(turn.reply)).toBeLessThanOrEqual(512);
      expect(turn.instruction).toContain("no message in this task was written by the user");
      expect(turn.instruction).toContain("same <input>");
      expect(turn.instruction).toContain("without a user speaker header");
      expect(utf8Bytes(turn.instruction)).toBeLessThanOrEqual(512);
      expect(turn.instruction).not.toContain("Too long");
      expect(turn.instruction).not.toContain("head or preamble");
      expect(turn.instruction).not.toContain("marker only the code writes");
    }
    for (const node of result.store.nodes.values()) {
      expect(node.text).not.toContain("user:");
      expect(node.text).not.toContain("linked the PR and requested a status update");
    }

    expect(await result.memory.settle()).toBe(true);

    // Both close methods cache their promises. Existing cleanup closures retain
    // these original owners and are safe to call again after the reopen.
    await result.memory.close();
    await result.store.close();
    const reopened = await Store.open(result.directory);
    cleanups.push(() => reopened.close());
    let reopenedCalls = 0;
    const memory = new Memory(reopened, async () => {
      reopenedCalls++;
      throw new Error("A persisted exhausted merge must not be summarized again");
    }, { nodeBytes: 512, jobs: 1 });
    cleanups.push(() => memory.close());
    expect(await memory.settle()).toBe(true);
    expect(reopenedCalls).toBe(0);
    expect(memory.status()).toMatchObject({ compressorCalls: 0, userRetries: 0, extractive: 0, pending: 0 });
    expect(reopened.nodes.get(nodeKey(1, 0))).toMatchObject({ text: expected, size: 512 });
    for (const [index, source] of SOURCES.entries()) {
      expect(reopened.nodes.get(nodeKey(0, index))!.text).toBe(`tool: ${source}`);
    }
    for (const node of reopened.nodes.values()) {
      expect(node.text).not.toContain("user:");
      expect(node.text).not.toContain("linked the PR and requested a status update");
    }
  });

  test("bounds an oversized false-only reply while counting user and length retries", async () => {
    // Memory's constructor sets summaryLimit = max(nodeBytes, pageBytes).
    const summaryLimit = Math.max(512, DEFAULT_PAGE_BYTES);
    const oversized = "user: linked the PR and requested a status update. ".padEnd(summaryLimit + 1, "x");
    expect(utf8Bytes(oversized)).toBeGreaterThan(summaryLimit);
    const result = await merge([oversized], { tries: 2 });
    expectStandIn(result, 2, 1, { lengthRetries: 1 });
    const [first, second] = result.requests;
    expect(second!.meta).toEqual({ node: "merge", attempt: 2, retry: "user" });
    expect(second!.context).toBe(first!.context);
    expect(second!.instruction).toBe(first!.instruction);
    expect(second!.instruction).not.toContain(oversized);
    expect(second!.feedback).toHaveLength(1);
    const turn = second!.feedback[0]!;
    expect(turn.reply).toBe(oversized.slice(0, summaryLimit));
    expect(utf8Bytes(turn.reply)).toBe(summaryLimit);
    expect(turn.reply).not.toBe(oversized);
    expect(turn.instruction).toContain("without a user speaker header");
    expect(turn.instruction).toContain("Previous reply excerpt only; omitted bytes are not a complete summary.");
    expect(turn.instruction).toContain(`Too long: your line is ${utf8Bytes(oversized)} bytes`);
    expect(turn.instruction).toContain("over the 512-byte limit");
    expect(turn.instruction).toContain(`${oversized.slice(0, 512)}| ← LIMIT`);
    expect(utf8Bytes(turn.instruction)).toBeLessThanOrEqual(summaryLimit);
    expect(turn.instruction).not.toContain("head or preamble");
    expect(turn.instruction).not.toContain("marker only the code writes");
  });

  test("prioritizes a reserved marker over its head and false claim, then retries the false claim", async () => {
    const marked = `Summary:\n${MARK}${INVALID}`;
    const result = await merge([marked, INVALID], { tries: 3 });
    expectStandIn(result, 3, 1, { headRetries: 1 });
    expect(result.requests.map((request) => request.meta)).toEqual([
      { node: "merge", attempt: 1, retry: null },
      { node: "merge", attempt: 2, retry: "marker" },
      { node: "merge", attempt: 3, retry: "user" },
    ]);
    for (const request of result.requests.slice(1)) {
      expect(request.context).toBe(result.requests[0]!.context);
      expect(request.instruction).toBe(result.requests[0]!.instruction);
      expect(request.feedback).toHaveLength(1);
      const turn = request.feedback[0]!;
      expect(turn.reply).toBe(INVALID);
      expect(turn.reply).not.toContain(MARK.trimEnd());
      expect(turn.reply).not.toContain("Summary:");
      expect(utf8Bytes(turn.reply)).toBeLessThanOrEqual(512);
      expect(utf8Bytes(turn.instruction)).toBeLessThanOrEqual(512);
      expect(turn.instruction).not.toContain("Too long");
      expect(turn.instruction).not.toContain("head or preamble");
    }
    const markerFeedback = result.requests[1]!.feedback[0]!.instruction;
    expect(markerFeedback).toContain("marker only the code writes");
    expect(markerFeedback).not.toContain("without a user speaker header");
    const userFeedback = result.requests[2]!.feedback[0]!.instruction;
    expect(userFeedback).toContain("without a user speaker header");
    expect(userFeedback).not.toContain("marker only the code writes");
  });

  test.each([
    { name: "fitting headed", candidate: `Summary:\n${CORRECTED}`, stored: CORRECTED, retry: "head", headRetries: 1, lengthRetries: 0 },
    { name: "whole overlong", candidate: OVERLONG, stored: OVERLONG, retry: "length", headRetries: 0, lengthRetries: 1 },
  ] as const)("retains the earlier $name safe candidate after later false replies", async ({ candidate, stored, retry, headRetries, lengthRetries }) => {
    if (retry === "head") expect(utf8Bytes(candidate)).toBeLessThanOrEqual(512);
    else {
      expect(utf8Bytes(candidate)).toBeGreaterThan(512);
      expect(utf8Bytes(candidate)).toBeLessThanOrEqual(Math.max(512, DEFAULT_PAGE_BYTES));
    }
    const result = await merge([candidate, INVALID], { tries: 3 });
    expectStored(result, stored, 3, 1, { headRetries, lengthRetries });
    expect(result.requests.map((request) => request.meta)).toEqual([
      { node: "merge", attempt: 1, retry: null },
      { node: "merge", attempt: 2, retry },
      { node: "merge", attempt: 3, retry: "user" },
    ]);
    expect(result.requests[1]!.feedback).toHaveLength(1);
    expect(result.requests[1]!.feedback[0]!.reply).toBe(stored);
    expect(result.requests[1]!.feedback[0]!.instruction).toContain(retry === "head" ? "head or preamble" : "Too long");
    expect(result.requests[2]!.feedback).toHaveLength(1);
    expect(result.requests[2]!.feedback[0]!.reply).toBe(INVALID);
    expect(result.requests[2]!.feedback[0]!.instruction).toContain("without a user speaker header");
    const published = result.store.nodes.get(nodeKey(1, 0))!.text;
    expect(published).not.toContain(MARK);
    expect(published).not.toContain("Summary:");
    expect(published).not.toContain("user:");
    expect(published).not.toContain("linked the PR and requested a status update");
  });

  test("preserves a quote-containing correction after rejecting the original candidate", async () => {
    const corrected = quoted[0]!;
    expectRetry(await merge([INVALID, corrected]), INVALID, corrected);
  });
});
