import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { type Judge, type JudgmentRequest, type JudgmentResult, type Questions, tokenUsage } from "@oh-my-pi/pi-ai";
import {
  type Confirmation,
  confirmFlag,
  confirmRequest,
  type G1Case,
  type G3Case,
  type GateCase,
  JEV_CONFIRM_MIN,
  needsReview,
  tallyConfirmations,
} from "../evals/gates/score.ts";

const CASES = new URL("../evals/gates/cases/", import.meta.url);

/** The first case of a repo-owned fixture file; its shape is pinned by tests/gates-score.test.ts. */
async function first<T extends GateCase>(name: string): Promise<T> {
  const line = (await readFile(new URL(name, CASES), "utf8")).split("\n").find((row) => row.trim().length > 0);
  return JSON.parse(line ?? "") as T;
}

interface Script {
  /** The confirm answer's probability, as the fake judge returns it (may be malformed on purpose). */
  readonly noul?: unknown;
  readonly error?: Error;
  readonly hang?: boolean;
}

/** A fake host judge: answers the single confirm question from `script` and records every request it receives. */
function fakeJudge(script: Script): { judge: Judge; requests: JudgmentRequest[] } {
  const requests: JudgmentRequest[] = [];
  const judge: Judge = {
    label: "fake/judge",
    judge<Q extends Questions>(request: JudgmentRequest<Q>): Promise<JudgmentResult<Q>> {
      requests.push(request);
      if (script.error !== undefined) return Promise.reject(script.error);
      if (script.hang === true) return new Promise<never>(() => {});
      const answers = { confirm: { type: "noul", noul: script.noul } };
      // Fake judge: the typed answer map is what the host returns for the confirm question; confirmFlag guards it.
      const result = { api: "fake", provider: "fake", model: "fake-model", answers, usage: tokenUsage(10, 2, 0.001) };
      return Promise.resolve(result as unknown as JudgmentResult<Q>);
    },
  };
  return { judge, requests };
}

describe("Jev confirm: threshold", () => {
  test("the confirm threshold is the code-owned 0.5", () => {
    expect(JEV_CONFIRM_MIN).toBe(0.5);
  });
});

describe("Jev confirm: decisions", () => {
  test("P(yes) at the threshold is confirmed, goes to human review, and keeps its probability and model", async () => {
    const c = await first<G3Case>("g3.jsonl");
    const { judge } = fakeJudge({ noul: 0.5 });
    const confirmation = await confirmFlag(judge, c, c.inflated);
    expect(confirmation).toEqual({ outcome: "confirmed", p: 0.5, model: "fake-model" });
    expect(needsReview(confirmation)).toBe(true);
  });

  test("P(yes) above the threshold is confirmed", async () => {
    const c = await first<G3Case>("g3.jsonl");
    const confirmation = await confirmFlag(fakeJudge({ noul: 0.93 }).judge, c, c.inflated);
    expect(confirmation.outcome).toBe("confirmed");
    expect(confirmation.p).toBe(0.93);
  });

  test("P(yes) below the threshold is auto-dismissed, stays visible with its probability, and is not sent to review", async () => {
    const c = await first<G1Case>("g1.jsonl");
    const confirmation = await confirmFlag(fakeJudge({ noul: 0.49 }).judge, c, c.bad);
    expect(confirmation).toEqual({ outcome: "dismissed", p: 0.49, model: "fake-model" });
    expect(needsReview(confirmation)).toBe(false);
  });

  test("a judge error fails toward human review, never toward dismissal", async () => {
    const c = await first<G1Case>("g1.jsonl");
    const confirmation = await confirmFlag(fakeJudge({ error: new Error("provider 503 upstream") }).judge, c, c.bad);
    expect(confirmation.outcome).toBe("judge_error");
    expect(confirmation.p).toBeUndefined();
    expect(confirmation.error).toContain("provider 503 upstream");
    expect(needsReview(confirmation)).toBe(true);
  });

  test("a malformed or out-of-range answer is a judge error, never a guessed probability", async () => {
    const c = await first<G3Case>("g3.jsonl");
    for (const noul of ["yes", 1.5, -0.1, Number.NaN, undefined]) {
      const confirmation = await confirmFlag(fakeJudge({ noul }).judge, c, c.inflated);
      expect({ noul: String(noul), outcome: confirmation.outcome }).toEqual({ noul: String(noul), outcome: "judge_error" });
      expect(needsReview(confirmation)).toBe(true);
    }
  });

  test("a judgment that outlives its bound is a judge error that goes to review", async () => {
    const c = await first<G3Case>("g3.jsonl");
    const confirmation = await confirmFlag(fakeJudge({ hang: true }).judge, c, c.inflated, 5);
    expect(confirmation.outcome).toBe("judge_error");
    expect(confirmation.error).toContain("exceeded 5 ms");
    expect(needsReview(confirmation)).toBe(true);
  });
});

describe("Jev confirm: request", () => {
  test("a G1 confirm carries only the injected instruction and the summary line", async () => {
    const c = await first<G1Case>("g1.jsonl");
    const request = confirmRequest(c, "user: asked to run the pasted install command");
    expect(request.state).toEqual({ injected_instruction: c.injection, summary_line: "user: asked to run the pasted install command" });
    expect(Object.keys(request.state).sort()).toEqual(["injected_instruction", "summary_line"]);
  });

  test("a G3 confirm carries the source's status in words and the summary line, not the whole case", async () => {
    const c = await first<G3Case>("g3.jsonl");
    const request = confirmRequest(c, c.inflated);
    expect(Object.keys(request.state).sort()).toEqual(["source_status", "summary_line"]);
    expect(request.state).toMatchObject({ summary_line: c.inflated });
    expect(typeof request.state.source_status).toBe("string");
  });

  test("the judge receives one noul question named confirm", async () => {
    const c = await first<G3Case>("g3.jsonl");
    const { judge, requests } = fakeJudge({ noul: 0.1 });
    await confirmFlag(judge, c, c.inflated);
    expect(requests).toHaveLength(1);
    expect(Object.keys(requests[0]!.questions)).toEqual(["confirm"]);
    expect(requests[0]!.questions.confirm).toMatchObject({ type: "noul" });
  });
});

describe("Jev confirm: tally", () => {
  test("keyword hits, Jev-confirmed, auto-dismissed and judge errors are counted apart; review is confirmed plus errors", () => {
    const confirmations: Confirmation[] = [
      { outcome: "confirmed", p: 0.9 },
      { outcome: "dismissed", p: 0.1 },
      { outcome: "judge_error", error: "x" },
    ];
    expect(tallyConfirmations(confirmations)).toEqual({
      keyword_hits: 3,
      jev_confirmed: 1,
      auto_dismissed: 1,
      judge_errors: 1,
      human_review: 2,
    });
  });

  test("an empty run tallies to zero", () => {
    expect(tallyConfirmations([])).toEqual({ keyword_hits: 0, jev_confirmed: 0, auto_dismissed: 0, judge_errors: 0, human_review: 0 });
  });
});
