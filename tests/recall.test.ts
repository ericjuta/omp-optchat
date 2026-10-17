import { describe, expect, test } from "bun:test";
import type { Answer, JudgmentRequest, Questions } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { BUILTIN_TOOL_NAMES, HIDDEN_TOOL_NAMES, normalizeToolName } from "@oh-my-pi/pi-coding-agent/tools/builtin-names";
import { utf8Length } from "../src/system1/judge.ts";
import { PREFETCH_QUESTIONS } from "../src/system1/prefetch.ts";
import {
  RECALL_K_MAX,
  RECALL_PAGE_BYTES,
  RECALL_SEEDS_MAX,
  RECALL_TEXT_BYTES,
  RECALL_QUESTION_CHARS,
  recall,
  registerRecallTool,
  renderRecall,
  type RecallMemory,
  type RecallOutcome,
} from "../src/system1/recall.ts";
import { DEFAULTS, readConfig } from "../src/config.ts";
import { choice, fakeJudge, noul, type FakeJudge } from "./helpers/fake-judge.ts";

interface Span {
  readonly id: number;
  readonly n: number;
}

interface TreeOptions {
  /** The view's lines; by default every merged line of the tree. */
  readonly view?: readonly Span[];
  /** Lines that are not built: the view omits them and lineAt reports them missing. */
  readonly missing?: readonly string[];
  /** What `rank` returns, best first; recall re-ranks the first SEARCH_MAX_LIMIT of it and takes the top `seeds`. */
  readonly ranked?: readonly number[];
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
    rank: (_question, limit) => (options.ranked ?? []).slice(0, limit),
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
}

/**
 * A judge that holds a line when its text contains `word`: P = high, or low otherwise. The pick favours the messages
 * that hold the word, each with its probability.
 */
function answerFor(word: string, high = 0.9, low = 0.1): (request: JudgmentRequest<Questions>) => Answers {
  return (request) => {
    // Recall built this state itself, so its shape is the contract under test rather than untrusted input.
    const probed = request.state as Probed;
    const holds = (key: string): boolean => probed.lines?.[key]?.includes(word) ?? false;
    const answers: Answers = {};
    for (const [key, question] of Object.entries(request.questions)) {
      if (question.type === "choice") {
        const keys = Object.keys(question.criteria);
        answers[key] = choice(keys.find(holds) ?? keys[0]!, Object.fromEntries(keys.map((id) => [id, holds(id) ? high : low])));
      } else {
        answers[key] = noul(holds(key) ? high : low);
      }
    }
    return answers;
  };
}

interface Script {
  /** What a line or message scores, by its `id+n` key. */
  readonly scores: Readonly<Record<string, number>>;
  /** What a key that `scores` does not name scores. Absent means 0. */
  readonly otherwise?: number;
  /** The pick's probability for each message key it is shown, 0 for a key not named. Absent: the pick request fails. */
  readonly pick?: Readonly<Record<string, number>>;
}

/** A judge scripted by key, so a test states each candidate's score and the pick's answer outright. */
function scripted(script: Script): (request: JudgmentRequest<Questions>) => Answers {
  return (request) => {
    const answers: Answers = {};
    for (const [key, question] of Object.entries(request.questions)) {
      if (question.type === "choice") {
        if (script.pick === undefined) throw new Error("pick unavailable");
        const probabilities = Object.fromEntries(Object.keys(question.criteria).map((id) => [id, script.pick![id] ?? 0]));
        const best = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]![0];
        answers[key] = choice(best, probabilities);
      } else {
        answers[key] = noul(script.scores[key] ?? script.otherwise ?? 0);
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

/** The keys the judge was asked to score, over every request (the pick is not a score). */
const scoredKeys = (judge: FakeJudge): string[] =>
  judge.requests.flatMap((request) => Object.keys(request.questions).filter((key) => key !== "pick"));

/** The requests that asked the pick. */
const picks = (judge: FakeJudge): JudgmentRequest<Questions>[] => judge.requests.filter((request) => "pick" in request.questions);

const SEVEN = ["m0", "m1", "m2", "m3", "m4", "invoice 5", "m6", "m7"];
const EIGHT_M = ["m0", "m1", "m2", "m3", "m4", "m5", "m6", "m7"];

describe("recall: scoring and the scan", () => {
  test("a message under the top line is found by the scan: the path is the covering line, then the message", async () => {
    const memory = treeMemory(SEVEN, { view: [{ id: 0, n: 4 }, { id: 4, n: 4 }] });
    const judge = fakeJudge(scripted({ scores: { "4+4": 0.9, "0+4": 0.2, "5+1": 0.95 } }));
    const outcome = judged(await recall(memory, { judge, question: "where is the invoice?", min: 0.5 }));
    expect(outcome.message).toMatchObject({ id: 5, text: "invoice 5" });
    expect(outcome.path).toMatchObject([{ id: 4, n: 4, p: 0.9 }, { id: 5, n: 1, p: 0.95 }]);
    expect(outcome.others).toEqual([]);
    // One request for the lines, one for the messages under the scanned line, no pick: one message leads.
    expect(judge.requests).toHaveLength(2);
    expect(picks(judge)).toHaveLength(0);
    expect(memory.pages).toEqual([5]);
  });

  test("a message under the 2nd to 4th ranked line at min is reachable though another line scored higher", async () => {
    for (const line of [2, 4, 6]) {
      const memory = treeMemory(EIGHT_M, { view: [{ id: 0, n: 2 }, { id: 2, n: 2 }, { id: 4, n: 2 }, { id: 6, n: 2 }] });
      const scores = { "0+2": 0.9, "2+2": 0.8, "4+2": 0.7, "6+2": 0.6, [`${line + 1}+1`]: 0.95 };
      const outcome = judged(await recall(memory, { judge: fakeJudge(scripted({ scores })), question: "q", min: 0.5 }));
      expect(outcome.message.id).toBe(line + 1);
      expect(outcome.path[0]).toMatchObject({ id: line, n: 2 });
    }
  });

  test("k widens the scan beyond four lines: the fifth line is scanned only when k allows it", async () => {
    const texts = Array.from({ length: 10 }, (_, index) => `m${index}`);
    const view = [0, 2, 4, 6, 8].map((id) => ({ id, n: 2 }));
    const scores = { "0+2": 0.9, "2+2": 0.8, "4+2": 0.7, "6+2": 0.6, "8+2": 0.5, "9+1": 0.95 };

    const narrow = fakeJudge(scripted({ scores }));
    const four = judged(await recall(treeMemory(texts, { view }), { judge: narrow, question: "q", min: 0.5 }));
    expect(scoredKeys(narrow)).not.toContain("9+1");
    expect(four.message.id).not.toBe(9);

    const wide = fakeJudge(scripted({ scores }));
    const five = judged(await recall(treeMemory(texts, { view }), { judge: wide, question: "q", min: 0.5, k: 5 }));
    expect(five.message.id).toBe(9);
    expect(five.path[0]).toMatchObject({ id: 8, n: 2 });
  });

  test("lines below min are never scanned, whatever k is", async () => {
    const memory = treeMemory(SEVEN, { view: [{ id: 0, n: 4 }, { id: 4, n: 4 }] });
    const judge = fakeJudge(scripted({ scores: { "0+4": 0.9, "4+4": 0.3, "2+1": 0.95, "5+1": 1 } }));
    const outcome = judged(await recall(memory, { judge, question: "q", min: 0.5, k: RECALL_K_MAX }));
    expect(outcome.message.id).toBe(2);
    expect(outcome.others.every((other) => other.id < 4)).toBe(true);
    for (const id of [4, 5, 6, 7]) expect(scoredKeys(judge)).not.toContain(`${id}+1`);
  });

  test("returns none, with the best probability, when no line reaches min", async () => {
    const memory = treeMemory(SEVEN);
    const judge = fakeJudge(answerFor("nothing-holds-this"));
    const outcome = await recall(memory, { judge, question: "where", min: 0.5 });
    expect(outcome).toEqual({ kind: "none", min: 0.5, best: 0.1 });
    // Nothing reached min, so nothing was scanned: one scoring request, no page.
    expect(judge.requests).toHaveLength(1);
    expect(memory.pages).toHaveLength(0);
    expect(renderRecall(outcome)).toBe("[optchat recall] no view line reached recall-min 0.5 (best p=0.10); try chat_search or zoom");
  });

  test("an empty store is none, and the judge is never asked", async () => {
    const judge = fakeJudge(answerFor("invoice"));
    expect(await recall(treeMemory([]), { judge, question: "invoice", min: 0.5 })).toEqual({ kind: "none", min: 0.5 });
    expect(judge.requests).toHaveLength(0);
  });

  test("a line whose probability equals min qualifies", async () => {
    const outcome = await recall(treeMemory(SEVEN), { judge: fakeJudge(answerFor("invoice")), question: "invoice", min: 0.9 });
    expect(judged(outcome).message.id).toBe(5);
  });

  test("ties go to the newer message, in the ranking and in the pick", async () => {
    const memory = treeMemory(EIGHT_M, { view: [{ id: 0, n: 2 }, { id: 2, n: 2 }, { id: 4, n: 2 }, { id: 6, n: 2 }] });
    // Every line and every message holds the word, so every probability ties, the pick's too.
    const judge = fakeJudge(answerFor("m"));
    const outcome = judged(await recall(memory, { judge, question: "anything", min: 0.5 }));
    expect(picks(judge)).toHaveLength(1);
    expect(outcome.message.id).toBe(7);
    expect(outcome.path[0]).toMatchObject({ id: 6, n: 2 });
  });

  test("a message whose node is not built is left out of the scan", async () => {
    const texts = ["m0", "m1", "m2", "m3", "m4", "m5", "m6", "invoice 7"];
    const memory = treeMemory(texts, { view: [{ id: 4, n: 4 }], missing: ["6+1"] });
    const judge = fakeJudge(answerFor("invoice"));
    const outcome = judged(await recall(memory, { judge, question: "invoice", min: 0.5 }));
    expect(outcome.message.id).toBe(7);
    expect(scoredKeys(judge).sort()).toEqual(["4+1", "4+4", "5+1", "7+1"]);
  });

  test("a line with no built message under it fails honestly, without a page", async () => {
    const memory = treeMemory(SEVEN, { view: [{ id: 4, n: 4 }], missing: ["4+1", "5+1", "6+1", "7+1"] });
    const judge = fakeJudge(answerFor("invoice"));
    const outcome = await recall(memory, { judge, question: "invoice", min: 0.5 });
    expect(outcome).toEqual({ kind: "failed", reason: "no built message under the top lines" });
    expect(judge.requests).toHaveLength(1);
    expect(memory.pages).toHaveLength(0);
  });

  test("a message under several scanned lines is scored once and takes the highest-ranked line as its cover", async () => {
    const memory = treeMemory(SEVEN, { view: [{ id: 0, n: 8 }, { id: 4, n: 4 }] });
    const judge = fakeJudge(scripted({ scores: { "0+8": 0.7, "4+4": 0.9, "5+1": 0.95 } }));
    const outcome = judged(await recall(memory, { judge, question: "invoice", min: 0.5 }));
    expect(outcome.message.id).toBe(5);
    expect(outcome.path[0]).toMatchObject({ id: 4, n: 4 });
    const keys = scoredKeys(judge);
    expect(keys.filter((key) => key === "5+1")).toHaveLength(1);
    // Eight messages, each once, though two scanned lines cover most of them.
    expect(keys.filter((key) => key.endsWith("+1"))).toHaveLength(8);
  });

  test("a message the first round already scored is not scored again by the scan", async () => {
    const memory = treeMemory(SEVEN, { view: [{ id: 0, n: 4 }, { id: 2, n: 1 }] });
    const judge = fakeJudge(scripted({ scores: { "0+4": 0.9, "2+1": 0.8 } }));
    const outcome = judged(await recall(memory, { judge, question: "q", min: 0.5 }));
    expect(scoredKeys(judge).filter((key) => key === "2+1")).toHaveLength(1);
    // The scanned line still covers it, so it answers under that line with its own round-one score.
    expect(outcome.message.id).toBe(2);
    expect(outcome.path).toMatchObject([{ id: 0, n: 4 }, { id: 2, n: 1, p: 0.8 }]);
  });

  test("judge calls are one scoring request per 64 lines, one per 64 scanned messages (up to 256), and one pick when two contend", async () => {
    const texts = Array.from({ length: 256 }, (_, index) => `m${index}`);
    const view = [0, 64, 128, 192].map((id) => ({ id, n: 64 }));
    const scores = { "0+64": 0.9, "64+64": 0.8, "128+64": 0.7, "192+64": 0.6, "10+1": 0.95, "200+1": 0.9 };
    const judge = fakeJudge(scripted({ scores, pick: { "200+1": 0.8, "10+1": 0.2 } }));
    const outcome = judged(await recall(treeMemory(texts, { view }), { judge, question: "q", min: 0.5 }));
    // All 256 messages sit under the four scanned lines, exactly the scan's cap.
    expect(scoredKeys(judge).filter((key) => key.endsWith("+1"))).toHaveLength(256);
    expect(judge.requests).toHaveLength(Math.ceil(4 / PREFETCH_QUESTIONS) + Math.ceil(256 / PREFETCH_QUESTIONS) + 1);
    expect(picks(judge)).toHaveLength(1);
    expect(outcome.message.id).toBe(200);
  });

  test("a line whose messages would pass the scan cap is skipped whole; with k above 1 it is listed as failed", async () => {
    const texts = Array.from({ length: 300 }, (_, index) => `m${index}`);
    const view = [0, 100, 200].map((id) => ({ id, n: 100 }));
    const scores = { "0+100": 0.9, "100+100": 0.8, "200+100": 0.7, "150+1": 0.95, "250+1": 0.99 };

    const single = fakeJudge(scripted({ scores }));
    const one = judged(await recall(treeMemory(texts, { view }), { judge: single, question: "q", min: 0.5 }));
    // The third line would bring the scan to 300 messages, so none of its messages is scored, even the best one.
    expect(one.message.id).toBe(150);
    expect(one.path[0]).toMatchObject({ id: 100, n: 100 });
    for (let id = 200; id < 300; id++) expect(scoredKeys(single)).not.toContain(`${id}+1`);
    expect(one.others).toEqual([]);

    const several = fakeJudge(scripted({ scores }));
    const two = judged(await recall(treeMemory(texts, { view }), { judge: several, question: "q", min: 0.5, k: 2 }));
    expect(two.message.id).toBe(150);
    expect(two.others.at(-1)).toMatchObject({ kind: "failed", id: 200, n: 100 });
    expect(renderRecall(two)).toContain("other 200+100 failed");
  });
});

describe("recall: the pick", () => {
  // Messages 3 and 1 lead within 0.1 of each other; message 2 is far behind. Line 0+8 covers all of them.
  const view = [{ id: 0, n: 8 }];
  const scores = { "0+8": 0.9, "3+1": 0.92, "1+1": 0.85, "2+1": 0.5 };

  test("decides among the messages within 0.1 of the best, shown side by side in message order", async () => {
    const judge = fakeJudge(scripted({ scores, pick: { "1+1": 0.7, "3+1": 0.3 } }));
    const outcome = judged(await recall(treeMemory(SEVEN, { view }), { judge, question: "q", min: 0.5 }));
    // Message 1 scored lower in the scan and wins the pick.
    expect(outcome.message.id).toBe(1);
    expect(outcome.path).toMatchObject([{ id: 0, n: 8 }, { id: 1, n: 1, p: 0.85 }]);
    expect(picks(judge)).toHaveLength(1);
    // Message 3 ranked first, yet it is listed after message 1; 2+1 is further than 0.1 from the best and is not offered.
    expect(Object.keys((picks(judge)[0]!.state as Probed).lines!)).toEqual(["1+1", "3+1"]);
  });

  test("a pick that fails or answers nothing keeps the score order", async () => {
    for (const pick of [undefined, {}]) {
      const judge = fakeJudge(scripted({ scores, pick }));
      const outcome = judged(await recall(treeMemory(SEVEN, { view }), { judge, question: "q", min: 0.5 }));
      expect(picks(judge)).toHaveLength(1);
      expect(outcome.message.id).toBe(3);
      expect(outcome.path.at(-1)).toMatchObject({ id: 3, p: 0.92 });
    }
  });

  test("at most 8 messages are offered, and their texts share 20,000 bytes", async () => {
    const texts = Array.from({ length: 10 }, (_, index) => `m${index} ${"a".repeat(4_500)}`);
    const judge = fakeJudge(scripted({ scores: {}, otherwise: 0.9, pick: {} }));
    judged(await recall(treeMemory(texts, { view: [{ id: 0, n: 10 }] }), { judge, question: "q", min: 0.5 }));
    expect(picks(judge)).toHaveLength(1);
    const lines = (picks(judge)[0]!.state as Probed).lines!;
    expect(Object.keys(lines)).toHaveLength(8);
    expect(Object.values(lines).reduce((sum, text) => sum + utf8Length(text), 0)).toBeLessThanOrEqual(20_000);
    // Each message keeps a real share of its text, so the pick has something to read.
    for (const text of Object.values(lines)) expect(text.startsWith("m")).toBe(true);
  });
});

describe("recall: k and the other candidates", () => {
  test("k=1 is the default: the same outcome and judge requests as leaving k out, and no others", async () => {
    const omitted = fakeJudge(answerFor("invoice"));
    const explicit = fakeJudge(answerFor("invoice"));
    const left = await recall(treeMemory(SEVEN), { judge: omitted, question: "invoice", min: 0.5 });
    const one = await recall(treeMemory(SEVEN), { judge: explicit, question: "invoice", min: 0.5, k: 1 });
    expect(one).toEqual(left);
    expect(explicit.requests).toEqual(omitted.requests);
    expect(judged(one).others).toEqual([]);
  });

  test("with k above 1 the losing messages are listed as others, best first; with k=1 none are", async () => {
    const scores = { "0+4": 0.9, "1+1": 0.95, "2+1": 0.6, "3+1": 0.4 };
    const outcomeFor = async (k: number) =>
      judged(await recall(treeMemory(SEVEN, { view: [{ id: 0, n: 4 }] }), { judge: fakeJudge(scripted({ scores })), question: "q", min: 0.5, k }));
    const one = await outcomeFor(1);
    expect(one.message.id).toBe(1);
    expect(one.others).toEqual([]);
    expect((await outcomeFor(2)).others).toEqual([{ kind: "answer", id: 2, p: 0.6 }]);
    const three = await outcomeFor(3);
    expect(three.others).toEqual([{ kind: "answer", id: 2, p: 0.6 }, { kind: "answer", id: 3, p: 0.4 }]);
    const text = renderRecall(three);
    expect(text).toContain("other message 2");
    expect(text).toContain("other message 3");
  });

  test("after a pick, the message it beat is listed as an other with its own score", async () => {
    const scores = { "0+8": 0.9, "3+1": 0.92, "1+1": 0.85, "2+1": 0.5 };
    const judge = fakeJudge(scripted({ scores, pick: { "1+1": 0.7, "3+1": 0.3 } }));
    const outcome = judged(await recall(treeMemory(SEVEN, { view: [{ id: 0, n: 8 }] }), { judge, question: "q", min: 0.5, k: 2 }));
    expect(outcome.message.id).toBe(1);
    expect(outcome.others).toEqual([{ kind: "answer", id: 3, p: 0.92 }]);
  });

  test("with k above 1, a line that holds no built message is listed as failed; with k=1 it is not", async () => {
    const view = [{ id: 0, n: 4 }, { id: 4, n: 4 }];
    const missing = ["4+1", "5+1", "6+1", "7+1"];
    const scores = { "0+4": 0.9, "4+4": 0.8, "1+1": 0.95, "2+1": 0.6, "3+1": 0.4 };
    const two = judged(
      await recall(treeMemory(SEVEN, { view, missing }), { judge: fakeJudge(scripted({ scores })), question: "q", min: 0.5, k: 2 }),
    );
    expect(two.message.id).toBe(1);
    expect(two.others).toEqual([{ kind: "answer", id: 2, p: 0.6 }, { kind: "failed", id: 4, n: 4, reason: expect.any(String) }]);
    expect(renderRecall(two)).toContain("other 4+4 failed");

    const one = judged(
      await recall(treeMemory(SEVEN, { view, missing }), { judge: fakeJudge(scripted({ scores })), question: "q", min: 0.5 }),
    );
    expect(one.message.id).toBe(1);
    expect(one.others).toEqual([]);
  });

  test("single messages below min are neither answered nor listed", async () => {
    const memory = treeMemory(["m0", "m1", "m2"], { view: [{ id: 0, n: 1 }, { id: 1, n: 1 }, { id: 2, n: 1 }] });
    const judge = fakeJudge(scripted({ scores: { "0+1": 0.9, "1+1": 0.3, "2+1": 0.6 } }));
    const outcome = judged(await recall(memory, { judge, question: "q", min: 0.5, k: 3 }));
    expect(outcome.message.id).toBe(0);
    expect(outcome.others).toEqual([{ kind: "answer", id: 2, p: 0.6 }]);
  });

  test("k outside 1 to RECALL_K_MAX, or not an integer, fails before any judge call", async () => {
    for (const k of [0, RECALL_K_MAX + 1, 1.5, Number.NaN]) {
      const judge = fakeJudge(answerFor("invoice"));
      expect(await recall(treeMemory(SEVEN), { judge, question: "invoice", min: 0.5, k })).toEqual({
        kind: "failed",
        reason: `k must be an integer from 1 to ${RECALL_K_MAX}`,
      });
      expect(judge.requests).toHaveLength(0);
    }
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

  test("a judge failure in the scan still answers from the first round when a message already reached min", async () => {
    // The view line is scanned, the scan request fails, and the raw-log match that reached min answers.
    const memory = treeMemory(SEVEN, { view: [{ id: 0, n: 4 }], ranked: [5] });
    const first = scripted({ scores: { "0+4": 0.9, "5+1": 0.95 } });
    let calls = 0;
    const judge = fakeJudge((request) => {
      if (++calls === 1) return first(request);
      throw new Error("scan failed");
    });
    const outcome = judged(await recall(memory, { judge, question: "invoice", min: 0.5, seeds: 1 }));
    expect(judge.requests).toHaveLength(2);
    expect(outcome.message.id).toBe(5);
    expect(outcome.raw).toBe(true);
  });

  test("when the scan fails and the first round left no answer, the recall fails with the scan's reason and reads no page", async () => {
    const memory = treeMemory(SEVEN, { view: [{ id: 0, n: 4 }] });
    const first = scripted({ scores: { "0+4": 0.9 } });
    let calls = 0;
    const judge = fakeJudge((request) => {
      if (++calls === 1) return first(request);
      throw new Error("scan failed");
    });
    expect(await recall(memory, { judge, question: "invoice", min: 0.5 })).toEqual({ kind: "failed", reason: "scan failed" });
    expect(memory.pages).toHaveLength(0);
  });

  test("a judge that never answers is cut at the recall bound, with no page read", async () => {
    const memory = treeMemory(SEVEN);
    const outcome = await recall(memory, { judge: fakeJudge(hung), question: "invoice", min: 0.5, timeoutMs: 50 });
    expect(outcome).toEqual({ kind: "failed", reason: "the recall bound passed" });
    expect(memory.pages).toHaveLength(0);
  });

  test("the recall bound cuts a hung scan, with no page read", async () => {
    const memory = treeMemory(SEVEN, { view: [{ id: 0, n: 4 }] });
    const first = scripted({ scores: { "0+4": 0.9 } });
    let calls = 0;
    const judge = fakeJudge((request, signal) => (++calls === 1 ? first(request) : hung(request, signal)));
    expect(await recall(memory, { judge, question: "invoice", min: 0.5, timeoutMs: 50 })).toEqual({
      kind: "failed",
      reason: "the recall bound passed",
    });
    expect(judge.requests).toHaveLength(2);
    expect(memory.pages).toHaveLength(0);
  });

  test("the recall bound cuts a hung pick, with no page read", async () => {
    const scores = { "0+8": 0.9, "3+1": 0.92, "1+1": 0.85 };
    const scoring = scripted({ scores });
    const judge = fakeJudge((request, signal) => ("pick" in request.questions ? hung(request, signal) : scoring(request)));
    const memory = treeMemory(SEVEN, { view: [{ id: 0, n: 8 }] });
    const outcome = await recall(memory, { judge, question: "q", min: 0.5, timeoutMs: 50 });
    expect(picks(judge)).toHaveLength(1);
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

describe("recall: raw-log seeds", () => {
  test("seeds 0 is the same recall as leaving seeds out: judge requests, outcome, rendering, and no rank call", async () => {
    const memory = treeMemory(SEVEN, { ranked: [5] });
    let ranks = 0;
    const counted: RecallMemory = {
      ...memory,
      rank: (question, limit) => {
        ranks++;
        return memory.rank(question, limit);
      },
    };
    const omitted = fakeJudge(answerFor("invoice"));
    const zero = fakeJudge(answerFor("invoice"));
    const left = await recall(counted, { judge: omitted, question: "invoice", min: 0.5, k: 3 });
    const none = await recall(counted, { judge: zero, question: "invoice", min: 0.5, k: 3, seeds: 0 });
    expect(none).toEqual(left);
    expect(zero.requests).toEqual(omitted.requests);
    expect(renderRecall(none)).toBe(renderRecall(left));
    expect(ranks).toBe(0);
  });

  test("a raw-log match is a single-message candidate in the same relevance request, and answers directly", async () => {
    const memory = treeMemory(SEVEN, { view: [{ id: 0, n: 4 }], ranked: [5] });
    const judge = fakeJudge(answerFor("invoice"));
    const outcome = judged(await recall(memory, { judge, question: "invoice", min: 0.5, seeds: 1 }));
    expect(outcome.message.id).toBe(5);
    expect(outcome.raw).toBe(true);
    expect(outcome.path).toEqual([{ id: 5, n: 1, text: "invoice 5", p: 0.9 }]);
    expect(judge.requests).toHaveLength(1);
    expect(Object.keys((judge.requests[0]!.state as Probed).lines!).sort()).toEqual(["0+4", "5+1"]);
    expect(renderRecall(outcome)).toContain("raw-log match: message 5 matched the question's words in the raw log");
  });

  test("a raw-log match that a view leaf already is stays one candidate: the view line", async () => {
    const memory = treeMemory(SEVEN, { view: [{ id: 5, n: 1 }, { id: 0, n: 4 }], ranked: [5, 6] });
    const judge = fakeJudge(answerFor("invoice"));
    const outcome = judged(await recall(memory, { judge, question: "invoice", min: 0.5, seeds: 2 }));
    expect(Object.keys((judge.requests[0]!.state as Probed).lines!).sort()).toEqual(["0+4", "5+1", "6+1"]);
    expect(outcome.message.id).toBe(5);
    expect(outcome.raw).toBeUndefined();
    expect(renderRecall(outcome)).not.toContain("raw-log match");
  });

  test("a seed's text is its message's first RECALL_TEXT_BYTES bytes", async () => {
    const texts = ["m0", "m1", "m2", "m3", "m4", `invoice${"é".repeat(5_000)}`, "m6", "m7"];
    const memory = treeMemory(texts, { view: [{ id: 0, n: 4 }], ranked: [5] });
    const judge = fakeJudge(answerFor("invoice"));
    const outcome = judged(await recall(memory, { judge, question: "invoice", min: 0.5, seeds: 1 }));
    const text = (judge.requests[0]!.state as Probed).lines!["5+1"]!;
    expect(utf8Length(text)).toBeLessThanOrEqual(RECALL_TEXT_BYTES);
    expect(text.startsWith("invoice")).toBe(true);
    expect(outcome.message.id).toBe(5);
  });

  test("seeds takes the top `seeds` of the raw-log ranking, ties keeping its order; a bad count fails before any judge call", async () => {
    const texts = Array.from({ length: 16 }, (_, index) => `m${index}`);
    const memory = treeMemory(texts, { view: [{ id: 0, n: 4 }], ranked: [10, 11, 12, 13, 14] });
    const judge = fakeJudge(answerFor("zzz"));
    // The question has no word of three or more characters, so no message outranks another and the search order stands.
    await recall(memory, { judge, question: "q", min: 0.5, seeds: 2 });
    expect(Object.keys((judge.requests[0]!.state as Probed).lines!).sort()).toEqual(["0+4", "10+1", "11+1"]);
    for (const seeds of [-1, RECALL_SEEDS_MAX + 1, 1.5, Number.NaN]) {
      const refused = fakeJudge(answerFor("zzz"));
      expect(await recall(memory, { judge: refused, question: "q", min: 0.5, seeds })).toEqual({
        kind: "failed",
        reason: `seeds must be an integer from 0 to ${RECALL_SEEDS_MAX}`,
      });
      expect(refused.requests).toHaveLength(0);
    }
  });

  test("the seeds are re-ranked for length: a short message with the question's rare word beats a long one with common words", async () => {
    // The word search would list the long dump first: it holds three of the question's words, the short answer one.
    const dump = `vault staging password ${"filler text ".repeat(700)}`;
    const texts = [dump, "zanzibar code is 4417", "vault staging", "vault staging", "vault password", "staging password"];
    const memory = treeMemory(texts, { view: [], ranked: [0, 1, 2, 3, 4, 5] });
    const judge = fakeJudge(scripted({ scores: { "1+1": 0.9 } }));
    const outcome = judged(await recall(memory, { judge, question: "zanzibar vault staging password", min: 0.5, seeds: 1 }));
    expect(Object.keys((judge.requests[0]!.state as Probed).lines!)).toEqual(["1+1"]);
    expect(outcome.message).toMatchObject({ id: 1, text: "zanzibar code is 4417" });
    expect(outcome.raw).toBe(true);
  });

  test("a seed competes with the messages under a scanned line: with k=2 the seed answers and the best scanned message is listed", async () => {
    const memory = treeMemory(SEVEN, { view: [{ id: 0, n: 4 }], ranked: [5] });
    const judge = fakeJudge(answerFor("invoice"));
    const outcome = judged(await recall(memory, { judge, question: "invoice", min: 0.05, k: 2, seeds: 1 }));
    expect(outcome.message.id).toBe(5);
    expect(outcome.raw).toBe(true);
    // The line 0+4 reached min, so its messages were scored too; the newest of the equal ones is listed.
    expect(outcome.others).toEqual([{ kind: "answer", id: 3, p: 0.1 }]);
  });
});

describe("recall-seeds flag", () => {
  const flagsOf = (values: Record<string, string>): ExtensionAPI =>
    ({ getFlag: (name: string) => values[name] }) as unknown as ExtensionAPI;

  test("takes integers from 0 to 32, defaults to the shipped value, and fails closed otherwise", () => {
    expect(readConfig(flagsOf({}), "/tmp/unused").gates.recallSeeds).toBe(DEFAULTS.recallSeeds);
    expect(readConfig(flagsOf({ "optchat-recall-seeds": "0" }), "/tmp/unused").gates.recallSeeds).toBe(0);
    expect(readConfig(flagsOf({ "optchat-recall-seeds": "8" }), "/tmp/unused").gates.recallSeeds).toBe(8);
    expect(readConfig(flagsOf({ "optchat-recall-seeds": "32" }), "/tmp/unused").gates.recallSeeds).toBe(32);
    for (const value of ["-1", "33", "2.5", "x", "", "1e1"]) {
      expect(() => readConfig(flagsOf({ "optchat-recall-seeds": value }), "/tmp/unused")).toThrow("--optchat-recall-seeds");
    }
  });
});

describe("recall-k flag", () => {
  const flagsOf = (values: Record<string, string>): ExtensionAPI =>
    ({ getFlag: (name: string) => values[name] }) as unknown as ExtensionAPI;

  test("defaults to 1, takes integers from 1 to 8, and fails closed otherwise", () => {
    expect(readConfig(flagsOf({}), "/tmp/unused").gates.recallK).toBe(1);
    expect(readConfig(flagsOf({ "optchat-recall-k": "1" }), "/tmp/unused").gates.recallK).toBe(1);
    expect(readConfig(flagsOf({ "optchat-recall-k": "8" }), "/tmp/unused").gates.recallK).toBe(8);
    for (const value of ["0", "9", "2.5", "x", "", "-1"]) {
      expect(() => readConfig(flagsOf({ "optchat-recall-k": value }), "/tmp/unused")).toThrow("--optchat-recall-k");
    }
  });
});
