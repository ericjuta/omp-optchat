/**
 * The judge wording of chat_recall: the relevance question asked per line (view lines, raw-log matches and the messages
 * under the scanned lines) and the choice among the near-tied top messages. recall.ts reads these; the recall eval
 * (evals/recall) tunes this file. A string here changes what the judge is asked, never the control flow, bounds, state
 * shape or thresholds.
 */

/** The relevance question asked of each line; `{line}` becomes the line's `id+n` key, which is also its state key. */
export const RECALL_SCORE_INSTRUCTION = "Line {line} holds information needed to answer the question";

export interface RecallPickPrompt {
  readonly instructions: string;
  /** One option per contending message; `{line}` becomes the message's `id+1` key, which is also its state key. */
  readonly criterion: string;
}

/**
 * One choice among the near-tied top messages, each shown as its own text, side by side in message order. Separately
 * scored messages of one topic all look relevant; shown together, the one that states the asked detail stands out.
 */
export const RECALL_PICK: RecallPickPrompt = {
  instructions:
    "Which message itself states the detail the question asks for? Prefer a message that says it in words over one that only shares the question's topic, names or wording, such as a command, a tool call, a file listing, a log or a status note about the same work. A summary of one message counts when it states the asked detail.",
  criterion: "message {line} states what the question asks for",
};
