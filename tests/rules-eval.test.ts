import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CASES_DIR, type RuleCase } from "../evals/rules/build-cases.ts";
import { expectedText, grade, summarize } from "../evals/rules/grade.ts";
import { oracleAnswers } from "../evals/rules/run.ts";
import { decideTriage, offeredRules, ruleSentences, type TriageDecision } from "../src/system1/rules.ts";

const RULE_ADD = 0.8;
const NONE: TriageDecision = { kind: "none" };
const ADD = (text: string): TriageDecision => ({ kind: "add", text });
const REPLACE = (replaces: string, text: string): TriageDecision => ({ kind: "replace", replaces, text });

async function loadCases(): Promise<RuleCase[]> {
  const rows: RuleCase[] = [];
  for (const file of ["synthetic.jsonl", "real.jsonl"]) {
    const text = await readFile(join(CASES_DIR, file), "utf8").catch(() => "");
    for (const line of text.split("\n")) if (line.trim().length > 0) rows.push(JSON.parse(line) as RuleCase);
  }
  return rows;
}

describe("rules grader", () => {
  test("a non-rule passes only when nothing is added or replaced", () => {
    expect(grade(NONE, { rule: false }, []).pass).toBe(true);
    expect(grade(ADD("x"), { rule: false }, []).pass).toBe(false);
    expect(grade(REPLACE("r1", "x"), { rule: false }, []).pass).toBe(false);
  });

  test("a rule passes on add, and fails on none or a replacement with no supersedes", () => {
    expect(grade(ADD("Always test."), { rule: true }, ["Always test."]).pass).toBe(true);
    expect(grade(NONE, { rule: true }, []).pass).toBe(false);
    expect(grade(REPLACE("r1", "Always test."), { rule: true }, []).pass).toBe(false);
  });

  test("a gold replacement passes only for the named offered rule", () => {
    const gold = { rule: true, supersedes: "r1" };
    expect(grade(REPLACE("r1", "x"), gold, []).pass).toBe(true);
    expect(grade(REPLACE("r2", "x"), gold, []).pass).toBe(false);
    expect(grade(ADD("x"), gold, []).replaceCorrect).toBe(false);
  });

  test("a mixed message's rule keeps exactly the named sentences", () => {
    const message = "Run the migration now. Always back up the database first.";
    const sentences = ruleSentences(message);
    const gold = { rule: true, keep: [1] };
    expect(expectedText(sentences, gold)).toBe("Always back up the database first.");
    expect(grade(ADD("Always back up the database first."), gold, sentences).pass).toBe(true);
    expect(grade(ADD(message), gold, sentences).pass).toBe(false);
  });

  test("confusion counts are one per case and the metrics follow them", () => {
    const rows = [
      { pass: true, tp: 1, fp: 0, fn: 0, tn: 0 },
      { pass: false, tp: 0, fp: 1, fn: 0, tn: 0 },
      { pass: false, tp: 0, fp: 0, fn: 1, tn: 0 },
      { pass: true, tp: 0, fp: 0, fn: 0, tn: 1 },
    ];
    const summary = summarize(rows);
    expect(summary.score).toBe(0.5);
    expect(summary.precision).toBe(0.5);
    expect(summary.recall).toBe(0.5);
    expect(summary.f1).toBe(0.5);
  });

  test("with no predicted adds precision is 0, and an empty set scores 0", () => {
    expect(summarize([{ pass: false, tp: 0, fp: 0, fn: 1, tn: 0 }]).precision).toBe(0);
    expect(summarize([]).score).toBe(0);
  });
});

describe("rules eval cases", () => {
  test("the oracle answers pass every loaded case through the production decision", async () => {
    const cases = await loadCases();
    expect(cases.filter((c) => c.tags[2] === "synthetic").length).toBeGreaterThanOrEqual(40);
    for (const c of cases) {
      const sentences = ruleSentences(c.message);
      const offered = offeredRules(c.rules.map((rule) => ({ ...rule, source: 0, at: 0 })));
      const decision = decideTriage(oracleAnswers(c, sentences), offered, RULE_ADD, c.message, sentences);
      expect(grade(decision, c.gold, sentences).pass).toBe(true);
    }
  });

  test("every synthetic category is present", async () => {
    const synthetic = (await loadCases()).filter((c) => c.tags[2] === "synthetic");
    const categories = new Set(synthetic.map((c) => c.tags[3]));
    for (const category of ["templated-rule", "one-off", "question", "hypothetical", "quoted-rule", "mixed-none", "mixed-rule", "supersede", "distractor"]) {
      expect(categories.has(category)).toBe(true);
    }
  });

  test("each stratum holds out round(0.4 x size) test cases", async () => {
    const cases = await loadCases();
    const strata = new Map<string, RuleCase[]>();
    for (const c of cases) strata.set(c.tags[0]!, [...(strata.get(c.tags[0]!) ?? []), c]);
    for (const [stratum, group] of strata) {
      const test = group.filter((c) => c.split === "test").length;
      expect({ stratum, test }).toEqual({ stratum, test: Math.round(0.4 * group.length) });
    }
  });
});
