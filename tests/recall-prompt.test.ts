import { describe, expect, test } from "bun:test";
import type { JudgmentRequest, Questions } from "@oh-my-pi/pi-ai";
import { type ViewLine, scoreViewLines } from "../src/system1/prefetch.ts";
import { recall, type RecallMemory } from "../src/system1/recall.ts";
import { fakeJudge, noul } from "./helpers/fake-judge.ts";

const QUESTION = "What is the staging database port?";
const TEXTS = Array.from({ length: 200 }, (_, id) => `message ${id} ${"filler words ".repeat(24)}`);
const LINES: ViewLine[] = TEXTS.map((text, id) => ({ id, n: 1, text }));

/** Every view line scores zero, so recall returns `none` after its scoring requests: the requests are what is compared. */
const wide: RecallMemory = {
  viewLines: () => LINES.map((line) => ({ ...line })),
  lineAt: () => undefined,
  page: () => {
    throw new Error("nothing is found, so no page is read");
  },
  rank: () => [],
};

const zeroes = (request: JudgmentRequest<Questions>) =>
  Object.fromEntries(Object.keys(request.questions).map((key) => [key, noul(0)]));

describe("chat_recall relevance requests", () => {
  test("relevance requests are byte-identical to the prefetch scorer's at the shipped wording", async () => {
    const recalled = fakeJudge(zeroes);
    const outcome = await recall(wide, { judge: recalled, question: QUESTION, min: 0.5 });
    expect(outcome.kind).toBe("none");

    const prefetch = fakeJudge(zeroes);
    await scoreViewLines(prefetch, { question: QUESTION }, LINES, "the question", new AbortController().signal, 5_000);

    // Four chunks at the shipped state and question limits, so the comparison covers packing and ordering.
    expect(recalled.requests.length).toBeGreaterThan(1);
    expect(recalled.requests.map((request) => JSON.stringify(request)).sort()).toEqual(
      prefetch.requests.map((request) => JSON.stringify(request)).sort(),
    );
  });
});
