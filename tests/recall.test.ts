import { describe, expect, test } from "bun:test";
import type { Answer, JudgmentRequest, Questions } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { BUILTIN_TOOL_NAMES, HIDDEN_TOOL_NAMES, normalizeToolName } from "@oh-my-pi/pi-coding-agent/tools/builtin-names";
import { utf8Length } from "../src/system1/judge.ts";
import { PREFETCH_QUESTIONS } from "../src/system1/prefetch.ts";
import {
  RECALL_PAGE_BYTES,
  RECALL_QUESTION_CHARS,
  recall,
  registerRecallTool,
  renderRecall,
  type RecallMemory,
  type RecallOutcome,
} from "../src/system1/recall.ts";
import { choice, fakeJudge, noul } from "./helpers/fake-judge.ts";

interface Span {
  readonly id: number;
  readonly n: number;
}

interface TreeOptions {
  /** The view's lines; by default every merged line of the tree. */
  readonly view?: readonly Span[];
  /** Lines that are not built: the view omits them and lineAt reports them missing. */
  readonly missing?: readonly string[];
}

/** A complete binary tree over `texts` (one message each). A node's summary is its messages' texts, joined. */
function treeMemory(texts: readonly string[], options: TreeOptions = {}): RecallMemory & { readonly pages: number[] } {
  const summary = (id: number, n: number) => texts.slice(id, id + n).join(" ");
  const missing = new Set(options.missing ?? []);
  const every: Span[] = [];
  for (let n = 2; n <= texts.length; n *= 2) for (let id = 0; id < texts.length; id += n) every.push({ id, n });
  const view = options.view ?? every;
  const pages: number[] = [];
  return {
    pages,
    viewLines: () =>
      view.filter((line) => !missing.has(`${line.id}+${line.n}`)).map((line) => ({ ...line, text: summary(line.id, line.n) })),
    lineAt: (id, n) => {
      if (missing.has(`${id}+${n}`) || id < 0 || n < 1 || id % n !== 0 || id + n > texts.length) return undefined;
      return { id, n, text: summary(id, n) };
    },
    page: (id) => {
      pages.push(id);
      const text = texts[id]!;
      return { text, next: null, totalBytes: utf8Length(text) };
    },
  };
}

type Answers = Record<string, Answer>;

/** The state a recall judgment carries. Recall builds it; these tests only read the fields they planted. */
interface Probed {
  readonly question?: string;
  readonly lines?: Readonly<Record<string, string>>;
  readonly first?: string;
  readonly second?: string;
}

/**
 * A judge that holds a line when its text contains `word`: P = high, or low otherwise. A choice picks the side
 * that holds the word, and gives each side its probability.
 */
function answerFor(word: string, high = 0.9, low = 0.1): (request: JudgmentRequest<Questions>) => Answers {
  return (request) => {
    // Recall built this state itself, so its shape is the contract under test rather than untrusted input.
    const probed = request.state as Probed;
    const answers: Answers = {};
    for (const [key, question] of Object.entries(request.questions)) {
      if (question.type === "choice") {
        const firstHolds = probed.first?.includes(word) ?? false;
        const secondHolds = probed.second?.includes(word) ?? false;
        answers[key] = choice(firstHolds ? "first" : "second", {
          first: firstHolds ? high : low,
          second: secondHolds ? high : low,
        });
      } else {
        answers[key] = noul(probed.lines?.[key]?.includes(word) ? high : low);
      }
    }
    return answers;
  };
}

/** A judge that never answers, and rejects once its own signal aborts. */
function hung(_request: JudgmentRequest<Questions>, signal: AbortSignal): Promise<Answers> {
  return new Promise<Answers>((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

function judged(outcome: RecallOutcome): Extract<RecallOutcome, { kind: "found" }> {
  if (outcome.kind !== "found") throw new Error(`expected found, got ${outcome.kind}`);
  return outcome;
}

const SEVEN = ["m0", "m1", "m2", "m3", "m4", "invoice 5", "m6", "m7"];

describe("recall: scoring and descent", () => {
  test("picks the line that holds the answer, then descends to the message that holds it", async () => {
    const memory = treeMemory(SEVEN);
    const judge = fakeJudge(answerFor("invoice"));
    const outcome = judged(await recall(memory, { judge, question: "where is the invoice?", min: 0.5 }));
    expect(outcome.message.id).toBe(5);
    expect(outcome.message.text).toBe("invoice 5");
    expect(outcome.path.at(-1)).toMatchObject({ id: 5, n: 1 });
    for (const step of outcome.path) expect(step.id <= 5 && 5 < step.id + step.n).toBe(true);
  });

  test("returns none, with the best probability, when no line reaches min", async () => {
    const memory = treeMemory(SEVEN);
    const outcome = await recall(memory, { judge: fakeJudge(answerFor("nothing-holds-this")), question: "where", min: 0.5 });
    expect(outcome).toEqual({ kind: "none", min: 0.5, best: 0.1 });
    expect(memory.pages).toHaveLength(0);
    expect(renderRecall(outcome)).toBe("[optchat recall] no view line reached recall-min 0.5 (best p=0.10); try chat_search or zoom");
  });

  test("a line whose probability equals min qualifies", async () => {
    const outcome = await recall(treeMemory(SEVEN), { judge: fakeJudge(answerFor("invoice")), question: "invoice", min: 0.9 });
    expect(judged(outcome).message.id).toBe(5);
  });

  test("ties go to the newer line, and a choice tie goes to the second, newer, child", async () => {
    const memory = treeMemory(["m0", "m1", "m2", "m3", "m4", "m5", "m6", "m7"], {
      view: [{ id: 0, n: 2 }, { id: 2, n: 2 }, { id: 4, n: 2 }, { id: 6, n: 2 }],
    });
    // Every line and every child holds the word, so every probability ties.
    const outcome = judged(await recall(memory, { judge: fakeJudge(answerFor("m")), question: "anything", min: 0.5 }));
    expect(outcome.path[0]).toMatchObject({ id: 6, n: 2 });
    expect(outcome.message.id).toBe(7);
  });

  test("a missing child is skipped: the other child is followed without a judge call", async () => {
    const texts = ["m0", "m1", "m2", "m3", "m4", "m5", "invoice 6", "m7"];
    const memory = treeMemory(texts, { view: [{ id: 4, n: 4 }], missing: ["4+2"] });
    const judge = fakeJudge(answerFor("invoice"));
    const outcome = judged(await recall(memory, { judge, question: "invoice", min: 0.5 }));
    expect(outcome.message.id).toBe(6);
    expect(outcome.path[1]).toMatchObject({ id: 6, n: 2 });
    expect(outcome.path[1]!.p).toBeUndefined();
    // One scoring request, then one choice between 6+1 and 7+1.
    expect(judge.requests).toHaveLength(2);
  });

  test("a line whose children are both missing fails honestly, without a page", async () => {
    const memory = treeMemory(SEVEN, { view: [{ id: 4, n: 4 }], missing: ["4+2", "6+2"] });
    const outcome = await recall(memory, { judge: fakeJudge(answerFor("invoice")), question: "invoice", min: 0.5 });
    expect(outcome).toEqual({ kind: "failed", reason: "no built children under line 4+4" });
    expect(memory.pages).toHaveLength(0);
  });

  test("judge calls are ceil(lines / PREFETCH_QUESTIONS) for scoring plus log2(n) choices", async () => {
    const texts = Array.from({ length: 128 }, (_, index) => (index === 77 ? "invoice 77" : `m${index}`));
    const judge = fakeJudge(answerFor("invoice"));
    const outcome = judged(await recall(treeMemory(texts), { judge, question: "invoice", min: 0.5 }));
    expect(outcome.message.id).toBe(77);
    expect(judge.requests).toHaveLength(Math.ceil(127 / PREFETCH_QUESTIONS) + Math.log2(outcome.path[0]!.n));
  });
});

describe("recall: failures and bounds", () => {
  test("a judge failure during scoring is failed, with no page read", async () => {
    const memory = treeMemory(SEVEN);
    const judge = fakeJudge(() => {
      throw new Error("provider down");
    });
    expect(await recall(memory, { judge, question: "invoice", min: 0.5 })).toEqual({ kind: "failed", reason: "provider down" });
    expect(memory.pages).toHaveLength(0);
  });

  test("a judge failure during descent is failed, with no page read", async () => {
    const memory = treeMemory(SEVEN);
    const scoring = answerFor("invoice");
    const judge = fakeJudge((request) => {
      if ("side" in request.questions) throw new Error("step failed");
      return scoring(request);
    });
    expect(await recall(memory, { judge, question: "invoice", min: 0.5 })).toEqual({ kind: "failed", reason: "step failed" });
    expect(memory.pages).toHaveLength(0);
  });

  test("a judge that never answers is cut at the recall bound, with no page read", async () => {
    const memory = treeMemory(SEVEN);
    const outcome = await recall(memory, { judge: fakeJudge(hung), question: "invoice", min: 0.5, timeoutMs: 50 });
    expect(outcome).toEqual({ kind: "failed", reason: "the recall bound passed" });
    expect(memory.pages).toHaveLength(0);
  });

  test("an abort before the call sends nothing to the judge", async () => {
    const controller = new AbortController();
    controller.abort();
    const judge = fakeJudge(answerFor("invoice"));
    expect(await recall(treeMemory(SEVEN), { judge, question: "invoice", min: 0.5, signal: controller.signal })).toEqual({
      kind: "failed",
      reason: "cancelled",
    });
    expect(judge.requests).toHaveLength(0);
  });

  test("an abort in flight ends the recall as cancelled", async () => {
    const controller = new AbortController();
    const judge = fakeJudge((request, signal) => {
      controller.abort();
      return hung(request, signal);
    });
    const outcome = await recall(treeMemory(SEVEN), { judge, question: "invoice", min: 0.5, signal: controller.signal });
    expect(outcome).toEqual({ kind: "failed", reason: "cancelled" });
  });

  test("the question is trimmed, flattened and bounded; an invalid one is never judged", async () => {
    const memory = treeMemory(SEVEN);
    const blank = fakeJudge(answerFor("invoice"));
    expect(await recall(memory, { judge: blank, question: "   ", min: 0.5 })).toMatchObject({ kind: "failed" });
    const long = fakeJudge(answerFor("invoice"));
    const tooLong = "a".repeat(RECALL_QUESTION_CHARS + 1);
    expect(await recall(memory, { judge: long, question: tooLong, min: 0.5 })).toMatchObject({ kind: "failed" });
    expect(blank.requests).toHaveLength(0);
    expect(long.requests).toHaveLength(0);

    const flat = fakeJudge(answerFor("invoice"));
    await recall(memory, { judge: flat, question: "  where is\n the   invoice ", min: 0.5 });
    const flatState = flat.requests[0]!.state as Probed; // recall built this state; its question is the contract under test
    expect(flatState.question).toBe("where is the invoice");

    const maximum = fakeJudge(answerFor("zzz"));
    const edge = await recall(memory, { judge: maximum, question: "a".repeat(RECALL_QUESTION_CHARS), min: 0.5 });
    expect(edge.kind).not.toBe("failed");
    expect(maximum.requests.length).toBeGreaterThan(0);
  });
});

describe("recall: the answering message", () => {
  test("the first page is bounded on a UTF-8 boundary, and the rest is reached by zoom", async () => {
    // "invoice" is 7 bytes, then 2-byte characters: 7 + 2 * 3996 = 7999 bytes fit, the next character would reach 8001.
    const texts = ["m0", "m1", "m2", "m3", "m4", `invoice${"é".repeat(5_000)}`, "m6", "m7"];
    const outcome = judged(await recall(treeMemory(texts), { judge: fakeJudge(answerFor("invoice")), question: "invoice", min: 0.5 }));
    expect(outcome.message.id).toBe(5);
    expect(outcome.message.text).toBe(`invoice${"é".repeat(3_996)}`);
    expect(outcome.message.shownBytes).toBe(7_999);
    expect(utf8Length(outcome.message.text)).toBeLessThanOrEqual(RECALL_PAGE_BYTES);
    expect(outcome.message.totalBytes).toBe(7 + 10_000);
    expect(renderRecall(outcome)).toContain("[bytes 0-7999 of 10007; zoom(5, 1, 7999) for the rest]");
  });
});

describe("registerRecallTool", () => {
  interface RegisteredTool {
    readonly name: string;
    readonly approval: string;
    readonly loadMode: string;
    execute(id: string, params: { question: string }, signal: AbortSignal | undefined, update: unknown, current: unknown): Promise<{
      content: Array<{ type: string; text: string }>;
    }>;
  }

  // Registration builds its schema through pi.zod; this test drives execute directly, so schemas are never validated.
  const schemaStub: unknown = new Proxy(() => schemaStub, { get: () => schemaStub, apply: () => schemaStub });

  function registered(run: Parameters<typeof registerRecallTool>[1]): RegisteredTool {
    const tools: RegisteredTool[] = [];
    const pi = { zod: schemaStub, registerTool: (tool: RegisteredTool) => void tools.push(tool) };
    // A two-member stand-in for the host API: only zod and registerTool are reached by registration.
    registerRecallTool(pi as unknown as ExtensionAPI, run);
    expect(tools).toHaveLength(1);
    return tools[0]!;
  }

  test("the tool's name never collides with an OMP builtin or alias, and it is a read-only essential tool", () => {
    const tool = registered(async () => "");
    const reserved: readonly string[] = [...BUILTIN_TOOL_NAMES, ...HIDDEN_TOOL_NAMES];
    expect(reserved).not.toContain(tool.name);
    expect(normalizeToolName(tool.name)).toBe(tool.name);
    expect(tool.approval).toBe("read");
    expect(tool.loadMode).toBe("essential");
  });

  test("execute returns run's text, and a rejected run surfaces as the tool's error", async () => {
    const signal = new AbortController().signal;
    const seen: Array<[string, AbortSignal | undefined]> = [];
    const ok = registered(async (question, _current, received) => {
      seen.push([question, received]);
      return "[optchat recall] answer";
    });
    expect(await ok.execute("call", { question: "where" }, signal, undefined, undefined)).toEqual({
      content: [{ type: "text", text: "[optchat recall] answer" }],
    });
    expect(seen).toEqual([["where", signal]]);
    const failing = registered(async () => {
      throw new Error("memory closed");
    });
    await expect(failing.execute("call", { question: "where" }, signal, undefined, undefined)).rejects.toThrow("memory closed");
  });
});

describe("renderRecall", () => {
  test("a found answer shows its path, then the message, and says where it ends", async () => {
    const outcome = judged(
      await recall(treeMemory(SEVEN), { judge: fakeJudge(answerFor("invoice")), question: "where is\nthe invoice", min: 0.5 }),
    );
    const text = renderRecall(outcome);
    expect(text.split("\n")[0]).toBe("[optchat recall] where is the invoice");
    expect(text).toContain("5+1|invoice 5 (p=0.90)");
    expect(text).toContain("message 5:\ninvoice 5\n[end of 9 bytes]");
  });

  test("a failure says so and never shows an answer", () => {
    const text = renderRecall({ kind: "failed", reason: "provider down" });
    expect(text.startsWith("[optchat recall] ")).toBe(true);
    expect(text).toContain("recall failed (provider down)");
    expect(text).not.toContain("message ");
  });
});
