import { describe, expect, test } from "bun:test";
import { grade } from "../evals/recall/grade.ts";
import type { RecallOutcome } from "../src/system1/recall.ts";

const FOUND = (id: number): RecallOutcome => ({
  kind: "found",
  question: "q",
  path: [{ id, n: 1, text: "line" }],
  others: [],
  message: { id, text: "text", shownBytes: 4, totalBytes: 4 },
});
const NONE: RecallOutcome = { kind: "none", min: 0.5, best: 0.2 };

describe("recall grader", () => {
  test("passes the gold or an also id, fails anything else", () => {
    expect(grade(FOUND(10), 10, [12]).pass).toBe(true);
    expect(grade(FOUND(12), 10, [12])).toMatchObject({ pass: true, explanation: "pass: the answer is message 12, which also answers" });
    expect(grade(FOUND(11), 10, [12])).toMatchObject({ pass: false, explanation: "fail: answered message 11 at depth 1" });
    expect(grade(NONE, 10, [12]).pass).toBe(false);
  });

  test("without also, only the gold passes", () => {
    expect(grade(FOUND(12), 10).pass).toBe(false);
  });
});
