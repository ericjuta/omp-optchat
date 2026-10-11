import type { ChoiceAnswer, Judge, Questions, ScoreAnswer } from "@oh-my-pi/pi-ai";
import { utf8Prefix } from "../memory.js";
import { judgeWithin } from "./judge.js";

/** The record text as judged. */
export const VALUE_STATE_BYTES = 24_000;
/** Wall bound for one hint request. */
export const VALUE_MS = 2_000;

const LABELS = ["decision", "preference", "finding", "noise"] as const;
const LEVELS: readonly [string, string, ...string[]] = ["low", "medium", "high"];

/** Fixed phrases only: a hint never carries message text or ids into the compaction instruction. */
const PHRASE: Record<(typeof LABELS)[number], string> = {
  decision: "a decision; keep the choice and its reason",
  preference: "a stated preference; keep it exactly",
  finding: "a finding; keep the fact and its source",
  noise: "low-value chatter; compress it hard",
};

const QUESTIONS: Questions = {
  label: {
    type: "choice",
    instructions: "What kind of record is this?",
    criteria: {
      decision: "a choice that was made",
      preference: "a stated wish or standing preference",
      finding: "a fact learned or result observed",
      noise: "greetings, acknowledgements, or filler",
    },
  },
  importance: {
    type: "score",
    instructions: "How much would losing this record's detail hurt later replies?",
    criteria: LEVELS,
  },
};

/**
 * One importance sentence for a leaf's compaction instruction, or undefined on any failure or timeout. Fixed
 * vocabulary only: the sentence never contains record text or message ids.
 */
export async function valueHint(
  judge: Judge,
  source: { readonly kind: string; readonly text: string },
  signal: AbortSignal,
): Promise<string | undefined> {
  try {
    const state = utf8Prefix(source.text, VALUE_STATE_BYTES);
    const result = await judgeWithin(judge, { state, questions: QUESTIONS }, VALUE_MS, signal);
    const label = (result.answers.label as ChoiceAnswer).choice as (typeof LABELS)[number];
    if (!Object.hasOwn(PHRASE, label)) return undefined;
    const score = (result.answers.importance as ScoreAnswer).score;
    const level = score < 0.5 ? "low" : score < 1.5 ? "medium" : "high";
    return `This record is ${PHRASE[label]}. Its importance is ${level}.`;
  } catch {
    return undefined;
  }
}
