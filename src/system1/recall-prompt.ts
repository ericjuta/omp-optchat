/**
 * The judge wording of chat_recall: the relevance question asked per view line and the sibling choice asked per
 * descent level. recall.ts reads these; the recall eval (evals/recall) tunes this file. A string here changes what the
 * judge is asked, never the control flow, bounds, state shape or thresholds.
 */

/** The relevance question asked of each view line; `{line}` becomes the line's `id+n` key, which is also its state key. */
export const RECALL_SCORE_INSTRUCTION = "Line {line} holds information needed to answer the question";

export interface RecallDescentPrompt {
  readonly instructions: string;
  readonly criteria: Readonly<Record<"first" | "second", string>>;
}

/** One choice between two sibling lines, where the first and second are the older and newer halves. */
export const RECALL_DESCENT: RecallDescentPrompt = {
  instructions: "Which line more likely holds the information that answers the question?",
  criteria: { first: "the first line holds the answer", second: "the second line holds the answer" },
};
