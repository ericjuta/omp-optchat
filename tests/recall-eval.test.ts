import { describe, expect, test } from "bun:test";
import { type Expected, grade, keyMatches } from "../evals/recall/grade.ts";
import type { RecallOutcome } from "../src/system1/recall.ts";

const FOUND = (id: number, text = "text"): RecallOutcome => ({
  kind: "found",
  question: "q",
  path: [{ id, n: 1, text: "line" }],
  others: [],
  message: { id, text, shownBytes: text.length, totalBytes: text.length },
});
const NONE: RecallOutcome = { kind: "none", min: 0.5, best: 0.2 };
const KEYED: Expected = { gold: 10, also: [12], no: [13], key: [["$17", "$30 cap"]] };

describe("recall grader", () => {
  test("judged ids decide first: gold and also pass, no fails even with the key in its text", () => {
    expect(grade(FOUND(10), KEYED)).toMatchObject({ pass: true, judged: true, explanation: "pass: the answer is the gold message" });
    expect(grade(FOUND(12), KEYED)).toMatchObject({ pass: true, judged: true, explanation: "pass: the answer is message 12, which also answers" });
    expect(grade(FOUND(13, "spend $17, $30 cap"), KEYED)).toMatchObject({ pass: false, judged: true, explanation: "fail: answered message 13 at depth 1" });
    expect(grade(NONE, KEYED)).toEqual({ pass: false, explanation: "fail: no view line reached min 0.5 (best p=0.20)" });
  });

  test("an unjudged id is graded by the key, ignoring case and whitespace; without a key it fails", () => {
    expect(keyMatches("a  B\n c", [["x"], ["a b", "B C"]])).toBe(true);
    expect(grade(FOUND(11, "Live spend about $17 of the $30\n  CAP."), KEYED)).toMatchObject({
      pass: true,
      judged: false,
      explanation: "pass: message 11 is unjudged and contains the answer key",
    });
    expect(grade(FOUND(11, "spend about $17 only"), KEYED)).toMatchObject({
      pass: false,
      judged: false,
      explanation: "fail: answered message 11 at depth 1 (unjudged, no answer-key match)",
    });
    expect(grade(FOUND(11, "$17 of the $30 cap"), { gold: 10 })).toMatchObject({
      pass: false,
      judged: false,
      explanation: "fail: answered message 11 at depth 1",
    });
  });
});
