# Real-chat view-size check (2026-11-26)

Plan: `prereg-20261126-real.md`. Counts: `result-20261126-real.json`. Private answers, labels and reviews stay
outside git.

## Decision

The 64,000-byte view fails the preregistered rule on two of its three conditions. The 128,000-byte default
stays, and the view-size question is closed.

| Condition | Rule | Measured | Met |
|---|---|---|---|
| Correct answers lost | at most 2 | 1 (55/56 against 56/56) | yes |
| Misleading answers added | at most 1 | 2 (2 against 0) | no |
| Main-model cost saved | at least 15% | 13.7% ($1.84 against $2.13) | no |

## What was run

- 28 frozen, source-reviewed questions over three real engineering histories (628, 1,637 and 692 messages),
  24 answerable and 4 missing-answer. Two repetitions, two view budgets: 112 trials, all completed.
- Each trial: a fresh host over its own copy of the frozen store, one question, memory tools only, prefetch
  and `chat_recall` on. Main `anthropic/claude-sonnet-5-5`, compressor `anthropic/claude-haiku-5-5`, judge
  role served by `clef`.
- The 12 questions of a fourth history were left out before any call: its view is 62,613 bytes, the same
  under both budgets.
- Runner at `8a443e1`, host OMP 19.2.1. The plugin is unchanged.

## Results

| | 128,000 B | 64,000 B |
|---|---:|---:|
| Correct | 56/56 | 55/56 |
| Misleading | 0 | 2 |
| Median view lines | 331 | 85 |
| Main-model cost | $2.13 | $1.84 |
| Main prompt tokens | 5,712,740 | 3,723,580 |
| Main-model calls | 112 | 145 |
| Tool calls | 88 | 140 |
| Trials answered with no tool call | 15 | 6 |
| Judge calls (none refused) | 134 | 112 |
| Compressor cost | $0.19 | $0.23 |
| Median latency | 8.9 s | 9.5 s |

- By case: the larger view won 1, the smaller 0, 27 tied (exact sign test p=1.0). This run cannot show a
  difference in correctness; both arms are at the ceiling of these questions.
- The two misleading answers are both repetitions of one question in the 64,000-byte arm. Each gave the
  accepted value but wrongly described where the chat states it. The two reviewers disagreed on exactly
  these two packets, and the third reviewer graded them correct in value and misleading in wording.
- The smaller view sent 35% fewer prompt tokens but made 29% more main-model calls and 59% more tool calls,
  so the cost saving was 13.7%.
- No trial called `chat_recall`. The model used `chat_search` (39 trials against 25) and `zoom` (31 against 27).

## Spend

- Charged against the $30 cap: $7.27 by the runner ($6.86 for the 112 trials, $0.41 for one probe question
  outside the set). That is reported main-model and compressor cost plus a $0.01 allocation for each of the
  246 judge calls in the trials. The host's own cost diagnostic for those judge calls sums to $0.26; neither figure is
  an invoice.
- Three blind reviewers ran on the operator's agent account. Their cost is not metered: unknown, held at $6
  inside the cap.

## Limits

- Three selected histories of one user, the longest 1,637 messages. Not a sample of users or of long chats.
- 56/56 in the default arm: the questions are too easy to measure a small loss. A harder set could differ.
- Repetitions are not independent, and questions about one history are dependent.
- One question per fresh host. A long working session, where the view is re-sent every turn, was not measured;
  the per-turn saving there could be larger or smaller.
- Costs include prompt-cache effects of the run order.
- Reviewers saw the four answers to a question together, without arm labels. One reviewer listed the run
  directory and read the preregistration; neither opened the mapping or the results.
- `chat_recall` was on but never called, so this says nothing about it.
