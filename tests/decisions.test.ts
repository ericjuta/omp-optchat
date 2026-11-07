import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as zod from "@oh-my-pi/omptype/zod";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { readTextPage, type MessageMetadata } from "../src/archive.ts";
import {
  DECISIONS_LIMITS,
  DECISIONS_MARK,
  gatherDecisions,
  registerDecisionsTool,
  renderDecisions,
  type CompletedDecisionResult,
  type DecisionLimits,
  type DecisionReader,
} from "../src/decisions.ts";
import { Store, type Kind } from "../src/store.ts";

type Row = readonly [Kind, string, MessageMetadata?];

function source(rows: readonly Row[], completed?: ReadonlyMap<number, CompletedDecisionResult>) {
  const reads: { id: number; offset: number; maxBytes: number }[] = [];
  const observed: number[] = [];
  const reader: DecisionReader = {
    page(id, offset, maxBytes) {
      reads.push({ id, offset, maxBytes });
      const row = rows[id];
      if (!row) throw new Error(`outside test snapshot: ${id}`);
      return { ...readTextPage(row[1], offset, maxBytes), kind: row[0], ...(row[2] === undefined ? {} : { metadata: row[2] }) };
    },
    completedResult(id) { observed.push(id); return completed?.get(id); },
  };
  return { reader, reads, observed };
}

const reversal: readonly Row[] = [
  ["user", "Use port 5432 for staging."],
  ["user", "Change staging to 6543."],
  ["user", "Revert it to 5432."],
  ["user", "Yesterday's failed attempt used 6543."],
];

describe("decision/correction derivation", () => {
  test("A -> B -> A stays A after a later historical mention of B, with exact replacement citations", async () => {
    const { reader } = source(reversal);
    const result = await gatherDecisions(reader, "staging", { upperBound: reversal.length });
    expect(result.scan.complete).toBe(true);
    expect(result.project.decisions).toEqual([{ topic: "staging", status: "accepted", value: "5432", evidence: [2], reason: "unambiguous explicit decision in the scanned snapshot" }]);
    expect(result.timeline.map((event) => event.status)).toEqual(["superseded", "superseded", "accepted", "unresolved"]);
    expect(result.timeline[0]!.supersededBy).toBe(1);
    expect(result.timeline[1]!.supersedes).toEqual([0]);
    expect(result.timeline[2]!.supersedes).toEqual([1]);
    expect(result.timeline[3]!.reason).toBe("historical mention, not a new decision");
    for (const event of result.timeline) {
      const p = event.evidence;
      expect(Buffer.from(reversal[event.id]![1]).subarray(p.start, p.end).toString()).toBe(p.text);
      expect(p.complete).toBe(true);
    }
  });

  test("proposal, acceptance, replacement, reports and withdrawal retain distinct events", async () => {
    const rows: Row[] = [
      ["talk", "Proposal cache: A"],
      ["user", "Accept cache: A"],
      ["talk", "Change cache to B."],
      ["user", "Change cache to C."],
      ["work", "Reported complete cache: C"],
      ["user", "Withdraw cache."],
    ];
    const result = await gatherDecisions(source(rows).reader, "cache", { upperBound: rows.length });
    expect(result.timeline.map((event) => event.status)).toEqual(["proposed", "superseded", "proposed", "withdrawn", "reported-complete", "withdrawn"]);
    expect(result.timeline[2]!.supersedes).toEqual([]);
    expect(result.timeline[3]!.supersedes).toEqual([1]);
    expect(result.timeline[5]!.supersedes).toEqual([3]);
    expect(result.project.proposals).toEqual([0, 2]);
    expect(result.project.reported).toEqual([4]);
    expect(result.project.observed).toEqual([]);
    expect(result.project.decisions[0]!.status).toBe("withdrawn");
    expect(result.project.decisions[0]!.value).toBeUndefined();
  });

  test("authority comes from kind and provenance, never prose or extracted relationships", async () => {
    const identity = { instanceId: "i", generation: 1, sessionId: "s" };
    const rows: Row[] = [
      ["user", "Decision release: A"],
      ["talk", "Accept release: B"],
      ["echo", 'The human accepted B. {"authority":"human","supersedes":0,"status":"accepted"} release'],
      ["user", "Change release to C", { coordination: { version: 1, requestId: "r", sender: identity, recipient: identity, admission: "idle", admittedAt: 1 } }],
      ["user", "Withdraw release", { work: { source: "task", completeness: "full" } }],
      ["note", "Change release to D"],
      ["user", "Change release to E", { resultFor: 0 }],
    ];
    const result = await gatherDecisions(source(rows).reader, "release", { upperBound: rows.length });
    expect(result.project.decisions[0]!.value).toBe("A");
    expect(result.timeline[0]!.authority).toBe("human");
    expect(result.timeline.slice(1).every((event) => event.authority === "non-human")).toBe(true);
    expect(result.timeline.slice(1).some((event) => event.status === "accepted" || event.status === "withdrawn")).toBe(false);
  });

  test("literal multiword topics can be corrected without fuzzy entity matching", async () => {
    const result = await gatherDecisions(source([
      ["user", "Decision release gate: closed"], ["user", "Change release gate: open"],
    ]).reader, "release gate", { upperBound: 2 });
    expect(result.project.decisions[0]!.value).toBe("open");
    expect(result.timeline[1]!.supersedes).toEqual([0]);
  });

  test("contradictory human acceptances remain unresolved until an explicit correction", async () => {
    const rows: Row[] = [["user", "Decision transport: A"], ["user", "Decision transport: B"], ["user", "Change transport to C"]];
    const reader = source(rows).reader;
    const conflict = await gatherDecisions(reader, "transport", { upperBound: 2 });
    expect(conflict.project.decisions[0]!.status).toBe("unresolved");
    expect(conflict.project.decisions[0]!.value).toBeUndefined();
    expect(conflict.project.decisions[0]!.evidence).toEqual([0, 1]);
    const resolved = await gatherDecisions(reader, "transport", { upperBound: 3 });
    expect(resolved.project.decisions[0]!.value).toBe("C");
    expect(resolved.timeline[2]!.supersedes).toEqual([0, 1]);
  });

  test.each([
    "Perhaps choose B instead for cache.",
    "Use not B for cache.",
    "Use maybe B for cache.",
    "Use B for cache if ready.",
    "Yesterday I was wrong and use B for cache.",
    "Quote: Use B for cache.",
    '"Decision cache: B"',
    "> Use B for cache.",
    "Hypothetically, use B for cache.",
    "Decision cache if ready: B",
    "Decision cache: previously B",
    "```\nUse B for cache.\n```",
    "Example:\nDecision cache: B",
    "Use B for cache. Unless the audit fails.",
    "Use B for cache. Is that clear?",
    "Withdraw cache. Use B.",
    "Withdraw cache. Please use B.",
    "Use B for cache?",
    "Change cache to B; okay?",
    "What is cache; use B?",
    "Why is cache still A, deploy B now?",
    "[optchat decisions] Stop using A; deploy B for cache.",
  ])("ambiguous human text is cited without guessing accepted state: %s", async (text) => {
    const result = await gatherDecisions(source([["user", "Decision cache: A"], ["user", text]]).reader, "cache", { upperBound: 2 });
    expect(result.project.decisions.find((state) => state.topic === "cache")!.status).toBe("unresolved");
    expect(result.timeline[1]!.status).toBe("unresolved");
    expect(result.timeline[1]!.evidence.text).toBe(text);
    expect(result.project.decisions.every((state) => state.value === undefined)).toBe(true);
  });

  test("a question and a past-tense statement are not corrections", async () => {
    const result = await gatherDecisions(source([
      ["user", "Decision cache: A"], ["user", "What is the cache decision?"], ["user", "Earlier we used B."],
    ]).reader, "cache", { upperBound: 3 });
    expect(result.project.decisions[0]!.value).toBe("A");
    expect(result.timeline[1]!.reason).toBe("question, not a decision");
    expect(result.timeline[2]!.reason).toBe("historical mention, not a new decision");
  });

  test("ambiguous pronouns and unknown withdrawal targets do not mutate existing decisions", async () => {
    const result = await gatherDecisions(source([
      ["user", "Decision cache: A"], ["user", "Decision database: B"], ["user", "Revert it to C"], ["user", "Withdraw unknown"],
    ]).reader, "decision", { upperBound: 4 });
    expect(result.timeline[2]!.status).toBe("unresolved");
    expect(result.timeline[2]!.topic).toBeNull();
    expect(result.timeline[0]!.status).toBe("accepted");
    expect(result.timeline[1]!.status).toBe("accepted");
    expect(result.project.decisions.every((state) => state.status === "unresolved")).toBe(true);
  });

  test("Unicode and whitespace citations are exact, not normalized claims", async () => {
    const text = '  Decision café: "漢字 😀"  ';
    const result = await gatherDecisions(source([["user", text]]).reader, "café", { upperBound: 1 });
    expect(result.project.decisions[0]!.value).toBe("漢字 😀");
    expect(result.timeline[0]!.evidence.text).toBe(text);
    expect(result.timeline[0]!.evidence.end).toBe(Buffer.byteLength(text));
    expect(result.timeline[0]!.evidence.complete).toBe(true);
  });

  test("no supported decision is explicitly unresolved, not an empty success claim", async () => {
    const result = await gatherDecisions(source([["talk", "I think the cache might be ready"]]).reader, "cache", { upperBound: 1 });
    expect(result.project.decisions).toEqual([]);
    expect(result.project.unresolved).toEqual([0]);
    expect(renderDecisions("cache", result)).toContain("unresolved: no supported decision");
    const empty = await gatherDecisions(source([]).reader, "cache", { upperBound: 0 });
    expect(empty.scan.complete).toBe(true);
    expect(renderDecisions("cache", empty)).toContain("unresolved: no supported decision");
  });
});

describe("completion evidence", () => {
  test("human, agent, work and tool prose can only report completion", async () => {
    const rows: Row[] = [["user", "Tests passed."], ["talk", "Tests passed."], ["work", "Tests passed."], ["echo", "Tests passed."]];
    const result = await gatherDecisions(source(rows).reader, "tests", { upperBound: 4 });
    expect(result.timeline.map((event) => event.status)).toEqual(Array(4).fill("reported-complete"));
    expect(result.project.observed).toEqual([]);
    expect(result.project.decisions[0]!.status).toBe("unresolved");
  });

  test("observed completion requires a trusted result adapter, actual tool linkage, and exact supporting bytes", async () => {
    const text = '🚀 résultat: {"passed":3,"failed":0}';
    const start = Buffer.byteLength("🚀 résultat: ");
    const rows: Row[] = [["tool", "test runner call"], ["echo", text, { resultFor: 0 }]];
    const completion = new Map([[1, { topic: "tests", start, end: Buffer.byteLength(text) }]]);
    const observed = source(rows, completion);
    const result = await gatherDecisions(observed.reader, "tests", { upperBound: 2 });
    expect(observed.observed).toEqual([1]);
    expect(result.project.observed).toEqual([1]);
    expect(result.timeline[0]!.resultFor).toBe(0);
    expect(result.timeline[0]!.evidence.text).toBe('{"passed":3,"failed":0}');
    expect(result.timeline[0]!.evidence.start).toBe(start);
    expect(result.project.decisions[0]!.status).toBe("unresolved"); // Execution does not accept a decision.
    const noAttestation = await gatherDecisions(source(rows).reader, "tests", { upperBound: 2 });
    expect(noAttestation.project.observed).toEqual([]);
  });

  test.each(["user", "talk", "work", "note", "tool"] as const)("a completion adapter cannot launder %s prose into observation", async (kind) => {
    const fixture = source([["tool", "run tests"], [kind, "Tests passed.", { resultFor: 0 }]], new Map([[1, { topic: "tests", start: 0, end: 13 }]]));
    const result = await gatherDecisions(fixture.reader, "tests", { upperBound: 2 });
    expect(fixture.observed).toEqual([]);
    expect(result.project.observed).toEqual([]);
  });

  test.each([undefined, 1, 2, 99, -1, 0.5])("unlinked/future tool result (%s) cannot prove completion", async (resultFor) => {
    const fixture = source([["talk", "run tests"], ["echo", "Tests passed.", resultFor === undefined ? undefined : { resultFor }]], new Map([[1, { topic: "tests", start: 0, end: 13 }]]));
    const result = await gatherDecisions(fixture.reader, "tests", { upperBound: 2 });
    expect(fixture.observed).toEqual([]);
    expect(result.project.observed).toEqual([]);
  });

  test("a non-tool predecessor and a partial work report never prove completion", async () => {
    const fixture = source([
      ["talk", "run tests"], ["echo", "Tests passed.", { resultFor: 0 }],
      ["tool", "run tests"], ["echo", "Tests passed.", { resultFor: 2, work: { source: "async-result", completeness: "pointer-only" } }],
    ], new Map([[1, { topic: "tests", start: 0, end: 13 }], [3, { topic: "tests", start: 0, end: 13 }]]));
    const result = await gatherDecisions(fixture.reader, "tests", { upperBound: 4 });
    expect(fixture.observed).toEqual([]);
    expect(result.project.observed).toEqual([]);
    expect(result.scan.complete).toBe(false);
  });

  test.each([[1, 4], [0, 1], [-1, 4], [0, 99], [4, 4], [NaN, 4]])("invalid or split UTF-8 span %s-%s is unresolved", async (start, end) => {
    const result = await gatherDecisions(source([["tool", "run tests"], ["echo", "😀 tests", { resultFor: 0 }]], new Map([[1, { topic: "tests", start, end }]])).reader, "tests", { upperBound: 2 });
    expect(result.project.observed).toEqual([]);
    expect(result.scan.gaps).toEqual([{ id: 1, reason: "invalid trusted completion citation" }]);
  });
});

describe("bounded source access", () => {
  test("snapshot is exclusive and later corrections cannot enter it", async () => {
    const fixture = source(reversal);
    const result = await gatherDecisions(fixture.reader, "staging", { upperBound: 2 });
    expect(fixture.reads.map((read) => read.id)).toEqual([0, 1]);
    expect(result.project.decisions[0]!.value).toBe("6543");
    expect(result.scan.upperBound).toBe(2);
  });

  test("message-count truncation is disclosed and cannot certify current state", async () => {
    const fixture = source(reversal);
    const result = await gatherDecisions(fixture.reader, "staging", { upperBound: 4, maxMessages: 2 });
    expect(fixture.reads.map((read) => read.id)).toEqual([2, 3]);
    expect(result.scan.complete).toBe(false);
    expect(result.scan.from).toBe(2);
    expect(result.timeline.some((event) => event.status === "accepted")).toBe(false);
    expect(result.project.decisions.some((state) => state.value !== undefined)).toBe(false);
  });

  test("long sources are bounded, not parsed from a misleading prefix", async () => {
    const text = `Use A for cache.\n${"漢😀".repeat(2_000)}\nActually use B.`;
    const fixture = source([["user", text]]);
    const result = await gatherDecisions(fixture.reader, "cache", { upperBound: 1 });
    expect(fixture.reads).toHaveLength(1);
    expect(result.scan.bytes).toBeLessThanOrEqual(DECISIONS_LIMITS.messageBytes);
    expect(result.scan.complete).toBe(false);
    expect(result.timeline[0]!.status).toBe("unresolved");
    const p = result.timeline[0]!.evidence;
    expect(p.complete).toBe(false);
    expect(p.text).not.toContain("\uFFFD");
    expect(Buffer.from(text).subarray(p.start, p.end).toString()).toBe(p.text);
  });

  test("scan bytes and event/output budgets fail closed instead of dropping a correction", async () => {
    for (const limits of [{ maxScanBytes: 32 }, { maxEvents: 1 }, { maxEvidenceBytes: 26 }]) {
      const fixture = source(reversal);
      const result = await gatherDecisions(fixture.reader, "staging", { upperBound: 4, ...limits });
      expect(result.scan.complete).toBe(false);
      expect(result.project.decisions.every((state) => state.status === "unresolved")).toBe(true);
      expect(result.project.decisions.every((state) => state.value === undefined)).toBe(true);
      const bytes = result.timeline.reduce((sum, event) => sum + event.evidence.end - event.evidence.start, 0);
      expect(bytes).toBeLessThanOrEqual(limits.maxEvidenceBytes ?? DECISIONS_LIMITS.evidenceBytes);
      expect(result.scan.bytes).toBeLessThanOrEqual(limits.maxScanBytes ?? DECISIONS_LIMITS.scanBytes);
    }
  });

  test("a slow result adapter cannot evade the deadline after the final source read", async () => {
    let now = 0;
    const fixture = source([["tool", "run tests"], ["echo", "Tests passed.", { resultFor: 0 }]]);
    const result = await gatherDecisions({
      page: fixture.reader.page,
      completedResult() { now = 2; return { topic: "tests", start: 0, end: 13 }; },
    }, "tests", { upperBound: 2, timeoutMs: 1, clock: () => now });
    expect(result.scan.complete).toBe(false);
    expect(result.scan.stopped).toBe("time bound");
    expect(result.project.observed).toEqual([]);
  });

  test("deadline is checked after a slow read; cancellation and reader revocation propagate", async () => {
    const fixture = source(reversal);
    let now = 0;
    const result = await gatherDecisions({ page(...args) { now = 2; return fixture.reader.page(...args); } }, "staging", { upperBound: 4, timeoutMs: 1, clock: () => now });
    expect(result.scan.stopped).toBe("time bound");
    expect(result.scan.complete).toBe(false);
    expect(result.timeline).toEqual([]);
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(gatherDecisions(fixture.reader, "staging", { upperBound: 4, signal: controller.signal })).rejects.toThrow("cancelled");
    const revoked: DecisionReader = { page() { throw new Error("revoked"); } };
    await expect(gatherDecisions(revoked, "staging", { upperBound: 4 })).rejects.toThrow("revoked");
  });

  test("abort during reading is not swallowed or converted to a successful partial result", async () => {
    const controller = new AbortController();
    const fixture = source(reversal);
    await expect(gatherDecisions({ page(...args) { controller.abort(new Error("cancelled during read")); return fixture.reader.page(...args); } }, "staging", { upperBound: 4, signal: controller.signal })).rejects.toThrow("cancelled during read");
  });

  test("invalid configuration and a reader exceeding its byte contract are rejected", async () => {
    const fixture = source(reversal);
    const bad: Partial<DecisionLimits>[] = [{ upperBound: -1 }, { upperBound: 1.5 }, { maxMessages: 0 }, { maxEvents: 0 }, { maxScanBytes: 3 }, { maxMessageBytes: Infinity }, { maxEvidenceBytes: -1 }, { timeoutMs: -1 }, { maxMessages: DECISIONS_LIMITS.messages + 1 }];
    for (const limits of bad) await expect(gatherDecisions(fixture.reader, "staging", { upperBound: 4, ...limits })).rejects.toThrow(RangeError);
    await expect(gatherDecisions(fixture.reader, " ", { upperBound: 4 })).rejects.toThrow(RangeError);
    await expect(gatherDecisions(fixture.reader, "x".repeat(1_001), { upperBound: 4 })).rejects.toThrow(RangeError);
    expect(fixture.reads).toEqual([]);
    const oversized: DecisionReader = { page() { return { kind: "user", text: "12345", next: null, totalBytes: 5 }; } };
    await expect(gatherDecisions(oversized, "12345", { upperBound: 1, maxMessageBytes: 4 })).rejects.toThrow("bounded page contract");
  });

  test("tool output is not recursively treated as a new decision", async () => {
    const fixture = source([["user", "Decision cache: A"], ["echo", `${DECISIONS_MARK} Decision cache: B`]]);
    const result = await gatherDecisions(fixture.reader, "cache", { upperBound: 2 });
    expect(result.timeline).toHaveLength(1);
    expect(result.project.decisions[0]!.value).toBe("A");
  });

  test("derivation survives Store reopen with no decision state file and no source mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "optchat-decisions-"));
    let store: Store | undefined;
    try {
      store = await Store.open(join(root, "chat"));
      for (const [kind, text] of reversal) store.append(kind, text);
      const upperBound = store.messages.length;
      const first = await gatherDecisions({ page: (id, offset, bytes) => store!.readMessagePage(id, offset, bytes) }, "staging", { upperBound });
      await store.close();
      store = await Store.open(join(root, "chat"));
      const again = await gatherDecisions({ page: (id, offset, bytes) => store!.readMessagePage(id, offset, bytes) }, "staging", { upperBound });
      expect(again).toEqual(first);
      expect(store.messages).toHaveLength(upperBound);
      expect(again.project.decisions[0]!.value).toBe("5432");
    } finally {
      await store?.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("chat_decisions registration", () => {
  test("is read-only, defaults to project-state, forwards mode/context/signal, and preserves exact citations", async () => {
    interface Registered {
      name: string;
      approval: string;
      description: string;
      parameters: { parse(input: unknown): unknown; safeParse(input: unknown): { success: boolean } };
      execute(id: string, input: { question: string; mode?: "timeline" | "project-state" }, signal?: AbortSignal, update?: undefined, context?: ExtensionContext): Promise<{ content: { type: string; text: string }[] }>;
    }
    const tools: Registered[] = [];
    const pi = { zod, registerTool: (tool: Registered) => { tools.push(tool); } } as unknown as ExtensionAPI;
    const seen: unknown[][] = [];
    registerDecisionsTool(pi, async (question, mode, current, signal) => {
      seen.push([question, mode, current, signal]);
      const result = await gatherDecisions(source(reversal).reader, question, { upperBound: reversal.length, signal });
      return renderDecisions(question, result, mode);
    });
    expect(tools).toHaveLength(1);
    const tool = tools[0]!;
    expect(tool.name).toBe("chat_decisions");
    expect(tool.approval).toBe("read");
    expect(tool.parameters.safeParse({ question: "staging", mode: "write" }).success).toBe(false);
    expect(tool.parameters.safeParse({ question: "" }).success).toBe(false);
    expect(tool.parameters.safeParse({ question: "x".repeat(1_001) }).success).toBe(false);
    const context = {} as ExtensionContext;
    const controller = new AbortController();
    const project = await tool.execute("1", { question: "staging" }, controller.signal, undefined, context);
    expect(seen[0]).toEqual(["staging", "project-state", context, controller.signal]);
    expect(project.content[0]!.text).toContain('staging: accepted "5432"');
    expect(project.content[0]!.text).toContain("zoom(2, 1, 0)");
    expect(project.content[0]!.text).toContain("Revert it to 5432.");
    const timeline = await tool.execute("2", { question: "staging", mode: "timeline" });
    expect(seen[1]![1]).toBe("timeline");
    expect(timeline.content[0]!.text).toContain(`${DECISIONS_MARK} timeline:`);
    expect(timeline.content[0]!.text).toContain("message 1: superseded");
    expect(timeline.content[0]!.text).toContain("scan complete");
  });
});
