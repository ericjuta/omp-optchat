import { afterEach, describe, expect, test } from "bun:test";
import * as zod from "@oh-my-pi/omptype/zod";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseMetadata, readTextPage, type MessageMetadata } from "../src/archive.ts";
import { captureWorkReports } from "../src/reports.ts";
import { Store, type Kind, type Message } from "../src/store.ts";
import {
  discoverWork, registerWorkDiscoveryTool, renderWorkDiscovery,
  WORK_DISCOVERY_MARK, WORK_DISCOVERY_MAX_RESULTS, WORK_DISCOVERY_PASSAGE_BYTES,
  WORK_DISCOVERY_PREFIX_BYTES, WORK_DISCOVERY_RESULT_BYTES, WORK_DISCOVERY_SCAN_BYTES,
  WORK_DISCOVERY_SCAN_MESSAGES,
  type WorkDiscoveryQuery, type WorkDiscoveryResult,
} from "../src/work-discovery.ts";

const DATE = "2026-11-07T09:00:00.000Z";
const WORK = { source: "task", completeness: "full", name: "MigrationScout", agentId: "agent-7" } as const;

function row(i: number, kind: Kind, text: string, metadata?: MessageMetadata, date = DATE): Message {
  return {
    i, kind, text, date, size: kind.length + 2 + Buffer.byteLength(text, "utf8"),
    ...(metadata === undefined ? {} : { metadata: parseMetadata(metadata) }),
  };
}

function discover(messages: readonly Message[], query: WorkDiscoveryQuery = {}, upperBound = messages.length): WorkDiscoveryResult {
  return discoverWork(messages, query, { upperBound });
}

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (let cleanup = cleanups.pop(); cleanup; cleanup = cleanups.pop()) await cleanup();
});

async function storeFixture(): Promise<{ store: Store; directory: string }> {
  const directory = await mkdtemp(join(tmpdir(), "optchat-work-discovery-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const store = await Store.open(join(directory, "chat"));
  cleanups.push(() => store.close());
  return { store, directory };
}

function report(i: number, text = "The migration failed at a unique constraint", name = "MigrationScout"): Message {
  return row(i, "work", text, { work: { ...WORK, name } });
}

describe("discoverWork trusted captures", () => {
  test("finds the original recorded task and captured finding through admitted metadata in a reopened Store", async () => {
    const { store, directory } = await storeFixture();
    const invocation = 'task {"tasks":[{"task":"Investigate the failed migration","name":"MigrationScout"}]}';
    const call = store.append("tool", invocation, new Date(DATE));
    const capture = await captureWorkReports({
      source: "task", timestamp: Date.parse(DATE) + 1_000, text: "MigrationScout completed",
      details: { results: [{ id: "agent-7", agent: "MigrationScout", exitCode: 0, output: "The migration failed at a unique constraint" }] },
    });
    const captured = capture.reports[0]!;
    const resultMessage = store.append("work", captured.body, new Date(captured.timestamp), { work: captured.work, resultFor: call.i });
    await store.close();
    const reopened = await Store.open(join(directory, "chat"));
    cleanups.push(() => reopened.close());
    const result = discover(reopened.messages, { question: "migration constraint" });
    expect(result.captures).toHaveLength(1);
    const hit = result.captures[0]!;
    expect(hit.report.messageId).toBe(resultMessage.i);
    expect(hit.report.text).toContain("unique constraint");
    expect(hit.call).toEqual({ messageId: call.i, offset: 0, end: Buffer.byteLength(invocation), next: null, text: invocation, tool: "task", relation: "task-or-command" });
    expect(hit.originalTaskOrCommand).toBe(call.i);
    expect(hit.capturedAt).toBe("2026-11-07T09:00:01.000Z");
    expect(hit.completeness).toBe("full");
    expect(hit.identities).toEqual({ workId: null, agentId: "agent-7", name: "MigrationScout", callId: null, runId: null, reportId: null });
    expect(result.scope.upperBound).toBe(2);
    expect(result.next).toBeNull();
    expect(reopened.readMessagePage(hit.report.messageId, hit.report.offset, WORK_DISCOVERY_PASSAGE_BYTES).text).toBe(hit.report.text);
  });

  test("reused names, agent ids and even job ids stay separate and page newest first", () => {
    const messages = [
      row(0, "tool", 'bash {"command":"migrate old"}'),
      row(1, "work", "old migration report", { work: { ...WORK, id: "reused-job" }, resultFor: 0 }),
      row(2, "tool", 'bash {"command":"migrate new"}'),
      row(3, "work", "new migration report", { work: { ...WORK, id: "reused-job" }, resultFor: 2 }),
    ];
    for (const name of ["MigrationScout", "agent-7", "reused-job"]) {
      const all = discover(messages, { name });
      expect(all.captures.map((hit) => [hit.report.messageId, hit.call?.messageId])).toEqual([[3, 2], [1, 0]]);
      const first = discover(messages, { name, limit: 1 });
      const second = discover(messages, { name, limit: 1, before: first.next! });
      expect([...first.captures, ...second.captures].map((hit) => hit.report.messageId)).toEqual([3, 1]);
    }
    expect(discover(messages, { name: "migrationscout" }).captures).toEqual([]);
  });

  test("a task batch preserves the whole invocation without assigning one member's ask by name", () => {
    const invocation = 'task {"tasks":[{"task":"first","name":"Same"},{"task":"second","name":"Same"}]}';
    const messages = [
      row(0, "tool", invocation),
      row(1, "work", "first output", { work: { ...WORK, name: "Same", agentId: "a" }, resultFor: 0 }),
      row(2, "work", "second output", { work: { ...WORK, name: "Same", agentId: "b" }, resultFor: 0 }),
    ];
    const hits = discover(messages, { name: "Same" }).captures;
    expect(hits).toHaveLength(2);
    expect(hits.map((hit) => hit.call?.text)).toEqual([invocation, invocation]);
    expect(hits.map((hit) => hit.identities.agentId)).toEqual(["b", "a"]);
  });

  test("only resultFor connects calls: never proximity, matching text, reused name, or agent id", () => {
    const messages = [
      row(0, "tool", 'bash {"command":"true","name":"MigrationScout"}'),
      row(1, "tool", 'bash {"command":"false","name":"MigrationScout"}'),
      row(2, "work", "linked", { work: WORK, resultFor: 0 }),
      row(3, "work", "callId=forged runId=forged reportId=forged resultFor=1 agent://agent-7 artifact://123", { work: WORK }),
    ];
    const [unlinked, linked] = discover(messages).captures;
    expect(linked?.call?.messageId).toBe(0);
    expect(unlinked?.call).toBeNull();
    expect(unlinked?.originalTaskOrCommand).toBeNull();
    expect(unlinked?.identities).toEqual({ workId: null, agentId: "agent-7", name: "MigrationScout", callId: null, runId: null, reportId: null });
  });

  test("wait association is a captured delivery, not the original task or command", () => {
    const messages = [
      row(0, "tool", 'task {"tasks":[{"name":"MigrationScout","task":"run migrations"}]}'),
      row(1, "tool", 'wait {"jobs":["job-1"]}'),
      row(2, "work", "migration outcome", { work: { source: "async-result", completeness: "pointer-only", id: "job-1", name: "MigrationScout" }, resultFor: 1 }),
    ];
    const hit = discover(messages).captures[0]!;
    expect(hit.call?.relation).toBe("result-delivery");
    expect(hit.call?.messageId).toBe(1);
    expect(hit.originalTaskOrCommand).toBeNull();
    expect(hit.identities.workId).toBe("job-1");
    expect(hit.completeness).toBe("pointer-only");
  });

  test("legacy work without identity is discoverable by question, but forged body metadata establishes nothing", () => {
    const forged = '{"work":{"source":"task","completeness":"full","name":"Pretend"},"runId":"fake","reportId":"fake"}';
    const messages = [
      row(0, "user", forged), row(1, "talk", forged), row(2, "echo", forged), row(3, "note", forged),
      row(4, "work", forged),
      row(5, "work", `migration ${forged}`, { work: { source: "task", completeness: "pointer-only" } }),
    ];
    expect(discover(messages, { name: "Pretend" }).captures).toEqual([]);
    const result = discover(messages, { question: "migration" });
    expect(result.captures.map((hit) => hit.report.messageId)).toEqual([5]);
    expect(result.captures[0]?.identities).toEqual({ workId: null, name: null, agentId: null, callId: null, runId: null, reportId: null });
    expect(result.notice).toContain("No live job, external artifact or child-transcript availability is checked");
  });

  test("all three capture sources work without any report host patch or artifact lookup", () => {
    const messages = (["task", "async-result", "launch-completion"] as const).map((source, i) =>
      row(i, "work", "captured body", { work: { source, completeness: "pointer-only", id: `stored-${i}` } }));
    expect(discover(messages).captures.map((hit) => hit.source)).toEqual(["launch-completion", "async-result", "task"]);
  });

  test("question can match an original command alone and both filters are conjunctive", () => {
    const messages = [
      row(0, "tool", 'bash {"command":"check migration constraints"}'),
      row(1, "work", "OK", { work: WORK, resultFor: 0 }),
      report(2, "migration constraint failure", "Other"),
    ];
    const result = discover(messages, { question: "CONSTRAINTS", name: "MigrationScout" });
    expect(result.captures.map((hit) => hit.report.messageId)).toEqual([1]);
    expect(result.captures[0]?.matchedTerms).toEqual(["constraints"]);
    expect(result.captures[0]?.call?.text).toContain("check migration constraints");
    expect(discover(messages, { question: "absent", name: "MigrationScout" }).captures).toEqual([]);
  });
});

describe("discovery snapshot and resource bounds", () => {
  test("the fixed child cutoff never reads or discloses later records even with a larger before", () => {
    const messages = [report(0, "old report"), report(1, "later report")];
    Object.defineProperty(messages, 1, { get: () => { throw new Error("future record was read"); } });
    const result = discover(messages, { name: "MigrationScout", before: 999 }, 1);
    expect(result.captures.map((hit) => hit.report.text)).toEqual(["old report"]);
    expect(result.scope.upperBound).toBe(1);
    expect(result.scope.before).toBe(1);
    expect(discover(messages, {}, 0).captures).toEqual([]);
  });

  test("empty/no-hit results state only the searched cutoff and never invent availability", () => {
    const result = discover([row(0, "talk", "migration report exists in child transcript")], { question: "migration" });
    expect(result.captures).toEqual([]);
    expect(result.scope.upperBound).toBe(1);
    expect(result.scope.stopped).toBe("end");
    expect(result.next).toBeNull();
    expect(result.notice).toContain("Stored captures only");
  });

  test("metadata scans are bounded and a no-hit page still returns a usable cursor", () => {
    const messages = Array.from({ length: WORK_DISCOVERY_SCAN_MESSAGES + 7 }, (_, i) => row(i, "talk", "no work"));
    messages[0] = report(0);
    const first = discover(messages, { name: "MigrationScout" });
    expect(first.captures).toEqual([]);
    expect(first.scope.inspectedMessages).toBeLessThanOrEqual(WORK_DISCOVERY_SCAN_MESSAGES);
    expect(first.scope.stopped).toBe("scan-messages");
    expect(first.next).not.toBeNull();
    const older = discover(messages, { name: "MigrationScout", before: first.next! });
    expect(older.captures.map((hit) => hit.report.messageId)).toEqual([0]);
    expect(older.next).toBeNull();
  });

  test("text scans stop at the byte budget; prefix truncation is not capture incompleteness", () => {
    const body = "x".repeat(WORK_DISCOVERY_PREFIX_BYTES + 50_000);
    const messages = Array.from({ length: 80 }, (_, i) => report(i, body));
    const miss = discover(messages, { question: "absent" });
    expect(miss.scope.stopped).toBe("scan-bytes");
    expect(miss.scope.scannedTextBytes).toBeLessThanOrEqual(WORK_DISCOVERY_SCAN_BYTES);
    expect(miss.scope.truncatedPrefixes).toBeGreaterThan(0);
    expect(miss.next).not.toBeNull();
    const hit = discover(messages, { name: "MigrationScout", limit: 1 }).captures[0]!;
    expect(hit.completeness).toBe("full");
    expect(Buffer.byteLength(hit.report.text)).toBe(WORK_DISCOVERY_PASSAGE_BYTES);
    expect(hit.report.next).not.toBeNull();
  });

  test("terms beyond a report's search prefix are not fabricated as a match", () => {
    const messages = [report(0, "x".repeat(WORK_DISCOVERY_PREFIX_BYTES) + " hiddenFinding")];
    const result = discover(messages, { question: "hiddenFinding" });
    expect(result.captures).toEqual([]);
    expect(result.scope.truncatedPrefixes).toBe(1);
    expect(result.notice).toContain("bounded text prefixes");
    expect(discover(messages, { name: "MigrationScout" }).captures).toHaveLength(1);
  });

  test("UTF-8 passage offsets roundtrip into the original report, including supplementary characters", () => {
    const body = "😀 café ".repeat(220) + "CONSTRAINT evidence " + "é".repeat(2_000);
    const result = discover([report(0, body)], { question: "constraint" });
    const passage = result.captures[0]!.report;
    expect(passage.offset).toBeGreaterThan(0);
    expect(passage.text).toContain("CONSTRAINT evidence");
    expect(passage.text).not.toContain("�");
    const exact = readTextPage(body, passage.offset, WORK_DISCOVERY_PASSAGE_BYTES);
    expect(passage.text).toBe(exact.text);
    expect(passage.end).toBe(passage.offset + Buffer.byteLength(passage.text));
    expect(passage.next).toBe(exact.next);
  });

  test("Unicode case expansion never turns a lowercase search index into an invalid citation", () => {
    const body = "İ".repeat(900) + " targetword " + "suffix".repeat(600);
    const hit = discover([report(0, body)], { question: "targetword" }).captures[0]!;
    expect(hit.report.text).toContain("targetword");
    expect(readTextPage(body, hit.report.offset, WORK_DISCOVERY_PASSAGE_BYTES).text).toBe(hit.report.text);
  });

  test("escaped JSON output stays bounded and the first unreturned capture is retried, not skipped", () => {
    const messages = Array.from({ length: 20 }, (_, i) => report(i, "\u0000".repeat(2_000)));
    const found: number[] = [];
    let before = messages.length;
    let sawByteStop = false;
    while (true) {
      const result = discover(messages, { limit: WORK_DISCOVERY_MAX_RESULTS, before });
      expect(Buffer.byteLength(renderWorkDiscovery(result), "utf8")).toBeLessThanOrEqual(WORK_DISCOVERY_RESULT_BYTES);
      expect(result.captures.length).toBeGreaterThan(0);
      found.push(...result.captures.map((hit) => hit.report.messageId));
      sawByteStop ||= result.scope.stopped === "returned-bytes";
      if (result.next === null) break;
      expect(result.next).toBeLessThan(before);
      before = result.next;
    }
    expect(sawByteStop).toBe(true);
    expect(found).toEqual(Array.from({ length: 20 }, (_, i) => 19 - i));
  });

  test("association lookups count against scan bytes and records without scanning intervening history", () => {
    const messages = Array.from({ length: 100 }, (_, i) => row(i, "talk", "unrelated"));
    messages[0] = row(0, "tool", 'bash {"command":"' + "x".repeat(20_000) + '"}');
    messages[99] = row(99, "work", "report", { work: WORK, resultFor: 0 });
    const result = discover(messages, { limit: 1 });
    expect(result.scope.inspectedMessages).toBe(2);
    expect(result.scope.scannedTextBytes).toBe(WORK_DISCOVERY_PREFIX_BYTES + 6);
    expect(result.captures[0]?.call?.messageId).toBe(0);
    expect(result.scope.truncatedPrefixes).toBe(1);
  });

  test("a pre-aborted query reads no record and retains a conservative continuation", () => {
    const controller = new AbortController();
    controller.abort();
    const messages = [report(0)];
    Object.defineProperty(messages, 0, { get: () => { throw new Error("aborted read"); } });
    const result = discoverWork(messages, {}, { upperBound: 1, signal: controller.signal });
    expect(result.captures).toEqual([]);
    expect(result.scope.inspectedMessages).toBe(0);
    expect(result.scope.stopped).toBe("aborted");
    expect(result.next).toBe(1);
  });

  test("invalid filters and cutoffs fail before reading history", () => {
    const messages = [report(0)];
    for (const query of [
      { question: "" }, { question: "a".repeat(1_001) }, { question: "?!" },
      { name: "" }, { name: "é".repeat(129) }, { limit: 0 }, { limit: 21 }, { limit: 1.5 },
      { before: -1 }, { before: Number.NaN }, { before: Number.POSITIVE_INFINITY },
    ]) expect(() => discover(messages, query)).toThrow();
    for (const upperBound of [-1, 0.1, 2, Number.POSITIVE_INFINITY]) {
      expect(() => discoverWork(messages, {}, { upperBound })).toThrow();
    }
    expect(discover(messages, { before: 0 }).captures).toEqual([]);
  });
});

interface RegisteredTool {
  name: string;
  approval: string;
  loadMode: string;
  parameters: { safeParse(input: unknown): { success: boolean } };
  execute(id: string, query: WorkDiscoveryQuery, signal?: AbortSignal, update?: undefined, current?: ExtensionContext): Promise<{
    content: Array<{ type: string; text: string }>;
    details: { next: number | null; upperBound: number; captures: number[] };
  }>;
}

function registration(run: (query: WorkDiscoveryQuery, current: ExtensionContext | undefined, signal: AbortSignal | undefined) => WorkDiscoveryResult): RegisteredTool {
  const tools: RegisteredTool[] = [];
  const pi = { zod, registerTool: (tool: RegisteredTool) => tools.push(tool) };
  registerWorkDiscoveryTool(pi as unknown as ExtensionAPI, run);
  expect(tools).toHaveLength(1);
  return tools[0]!;
}

describe("chat_work registration adapter", () => {
  test("registers a read-only tool and forwards live context, signal and filters", async () => {
    const messages = [report(0)];
    const context = {} as ExtensionContext;
    const controller = new AbortController();
    const query = { question: "migration", limit: 2, before: 1 };
    const tool = registration((input, current, signal) => {
      expect(input).toBe(query);
      expect(current).toBe(context);
      expect(signal).toBe(controller.signal);
      return discoverWork(messages, input, { upperBound: 1, signal });
    });
    expect(tool.name).toBe("chat_work");
    expect(tool.approval).toBe("read");
    expect(tool.loadMode).toBe("essential");
    const result = await tool.execute("call", query, controller.signal, undefined, context);
    expect(result.content[0]?.text.startsWith(WORK_DISCOVERY_MARK)).toBe(true);
    expect(result.details).toEqual({ next: null, upperBound: 1, captures: [0] });
    expect(JSON.parse(result.content[0]!.text.slice(WORK_DISCOVERY_MARK.length + 1)).captures[0].report.messageId).toBe(0);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(WORK_DISCOVERY_RESULT_BYTES);
  });

  test.each(["\\", "\u0000", "\""])("the whole tool envelope remains bounded for escaped source %j", async (character) => {
    const messages: Message[] = [];
    for (let i = 0; i < 40; i += 2) {
      messages.push(row(i, "tool", 'bash {"command":"' + character.repeat(10_000) + '"}'));
      messages.push(row(i + 1, "work", character.repeat(10_000), { work: WORK, resultFor: i }));
    }
    const tool = registration((query) => discover(messages, query));
    const result = await tool.execute("bounded", { limit: 20 });
    expect(result.details.captures.length).toBeGreaterThan(0);
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(WORK_DISCOVERY_RESULT_BYTES);
    expect(result.details.next).not.toBeNull();
  });

  test("the registration schema supports listing, question/name filters and conservative cursor zero", () => {
    const tool = registration(() => discover([]));
    for (const input of [{}, { question: "migration" }, { name: "A" }, { question: "migration", name: "A" }, { before: 0 }]) {
      expect(tool.parameters.safeParse(input).success).toBe(true);
    }
    for (const input of [{ name: "" }, { question: "" }, { limit: 21 }, { limit: 0 }, { before: -1 }, { before: 1.5 }]) {
      expect(tool.parameters.safeParse(input).success).toBe(false);
    }
  });

  test("a child callback keeps its frozen cutoff and fails closed on publication revocation or context change", async () => {
    const messages = [report(0, "old")];
    const upperBound = messages.length;
    const attached = {} as ExtensionContext;
    let live = true;
    let reads = 0;
    const tool = registration((query, current, signal) => {
      if (!live || current !== attached) throw new Error("parent view is not attached");
      reads++;
      return discoverWork(messages, query, { upperBound, signal });
    });
    messages.push(report(1, "new"));
    const result = await tool.execute("one", { before: 999 }, undefined, undefined, attached);
    expect(result.details).toEqual({ next: null, upperBound: 1, captures: [0] });
    await expect(tool.execute("two", {}, undefined, undefined, {} as ExtensionContext)).rejects.toThrow("not attached");
    live = false;
    await expect(tool.execute("three", {}, undefined, undefined, attached)).rejects.toThrow("not attached");
    expect(reads).toBe(1);
  });
});
