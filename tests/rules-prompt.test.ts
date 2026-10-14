import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { offeredRules, ruleSentences, triageQuestions, triageState } from "../src/system1/rules.ts";
import type { Rule } from "../src/system1/ledger.ts";

/**
 * The triage request frames, pinned to the bytes the inline wording produced before the wording moved into
 * src/system1/rules-prompt.ts. Changing these digests is a deliberate change to what the judge is asked, not a refactor.
 */
const PINNED: Record<string, { sha256: string; bytes: number }> = {
  noRulesOneSentence: { sha256: "f61a3fb91ffdbf722657f771f86c07ff9810d143989a2d15874f4c2bc8235c1d", bytes: 356 },
  rulesTwoSentences: { sha256: "82b593bfaba015f83bb6ca75e9f7ea7b24f1207226c0144556262ee151935428", bytes: 1437 },
  noRulesThreeSentences: { sha256: "9f100a4c638f472b9f5a0d1ebdcdd5a1bbaae36df28eb679877a072c66bfebfc", bytes: 1517 },
  rulesOneSentence: { sha256: "f71e6221cd7591d5645850e2432429064844855b14624ea3ea7f3bc1e70a611b", bytes: 617 },
};

const rule = (id: string, text: string, source: number): Rule => ({ id, text, source, at: source });
const offered = [rule("r1", "Answer in British English.", 3), rule("r7", "Never force push to main.", 9)];

const FRAMES: Record<string, { message: string; rules: Rule[] }> = {
  noRulesOneSentence: { message: "always use tabs", rules: [] },
  rulesTwoSentences: { message: "Run the migration now.\nFrom now on, always back up the db first.", rules: offered },
  noRulesThreeSentences: { message: "Keep answers short. Ask before deleting files! Is that fine?", rules: [] },
  rulesOneSentence: { message: "Stop using emojis.", rules: offered },
};

/** The exact request body the judge receives for one message: state plus questions, as recall and triage send it. */
function frameOf(message: string, rules: readonly Rule[]): string {
  const sentences = ruleSentences(message);
  return JSON.stringify({ state: triageState(message, sentences), questions: triageQuestions(offeredRules(rules), sentences) });
}

describe("rules triage judge wording", () => {
  for (const [name, { message, rules }] of Object.entries(FRAMES)) {
    test(`the ${name} request is byte-identical to the pinned frame`, () => {
      const frame = frameOf(message, rules);
      expect({ sha256: createHash("sha256").update(frame).digest("hex"), bytes: Buffer.byteLength(frame) }).toEqual(PINNED[name]!);
    });
  }
});
