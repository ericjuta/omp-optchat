import { describe, expect, test } from "bun:test";
import { type Expected, formatScores, grade, keyMatches, scoreSummary } from "../evals/recall/grade.ts";
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

describe("recall score summary", () => {
  const cases = new Map([
    ["a", { gold: 1, kind: "user" }],
    ["b", { gold: 2, kind: "echo" }],
    ["c", { gold: 3, kind: "echo" }],
    ["d", { gold: 4, kind: "talk" }],
  ]);
  const rows = [
    { prompt_id: "a", grade: true, found: 1 }, // user: gold
    { prompt_id: "a", grade: false, found: 9 }, // user: wrong answer
    { prompt_id: "b", grade: true, found: 20 }, // echo: credited through an also/key alternative, not the gold
    { prompt_id: "b", grade: true, found: 2 }, // echo: gold
    { prompt_id: "c", grade: false }, // echo: no answer
    { prompt_id: "c", grade: true, found: 21 }, // echo: credited alternative only
    { prompt_id: "d", grade: true, found: 4 }, // talk: gold
    { prompt_id: "gone", grade: true, found: 1 }, // case not in the run: skipped
  ];

  test("gold-only counts only passes that answered the gold, overall and per gold kind", () => {
    const s = scoreSummary(rows, cases);
    expect(s).toMatchObject({ n: 7, credited: 5, gold_only: 3 });
    expect(s.credited_rate).toBeCloseTo(5 / 7);
    expect(s.gold_only_rate).toBeCloseTo(3 / 7);
    expect(Object.keys(s.by_gold_kind)).toEqual(["echo", "talk", "user"]);
    expect(s.by_gold_kind.echo).toMatchObject({ n: 4, credited: 3, gold_only: 1, credited_rate: 0.75, gold_only_rate: 0.25 });
    expect(s.by_gold_kind.talk).toMatchObject({ n: 1, credited: 1, gold_only: 1, credited_rate: 1, gold_only_rate: 1 });
    expect(s.by_gold_kind.user).toMatchObject({ n: 2, credited: 1, gold_only: 1, credited_rate: 0.5, gold_only_rate: 0.5 });
  });

  test("an empty result set reports zero rates, and the printed form lists every kind", () => {
    expect(scoreSummary([], cases)).toEqual({ n: 0, credited: 0, credited_rate: 0, gold_only: 0, gold_only_rate: 0, by_gold_kind: {} });
    expect(formatScores(scoreSummary(rows, cases)).split("\n")).toEqual([
      "all: n 7, credited 5 (0.714), gold-only 3 (0.429)",
      "  echo: n 4, credited 3 (0.750), gold-only 1 (0.250)",
      "  talk: n 1, credited 1 (1.000), gold-only 1 (1.000)",
      "  user: n 2, credited 1 (0.500), gold-only 1 (0.500)",
    ]);
  });
});

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
