# Preregistration: real-chat view-size check (2026-11-26)

Written before any paid call of this run. It follows `report-20261126.md`, where the 64,000-byte view tied the
128,000-byte default on a synthetic corpus at lower main-model cost.

## Question

On real chat histories, with the prefetch and recall gates on as in production, does a 64,000-byte view answer
as well as the 128,000-byte default, and does it cost less?

## Budget

Eric approved a hard cap of $30 for this run on 2026-11-26. It is separate from the $40 cap of the synthetic run.

- Runner: `--max-cost-usd 24`. A trial starts only if its whole reserve ($3.55) fits under what is left.
- Review: $6 is held for the blind reviewers. They run on the operator's agent account and their spend is not
  metered, so their actual cost is unknown, not $6 and not zero.
- Main-model and compressor spend are the host's reported costs. An unknown cost stops the run.
- Judge spend cannot be observed. Each host may send at most 60 judge calls, and every call sent is charged
  $0.01 against the cap. This is an allocation, not a measured charge.
- The cap is local admission. It is not a provider limit.

## Design

- Runner: `evals/retention/real-run.ts` at the commit that adds this file.
- Cases: the frozen, source-reviewed, privacy-screened 40-case set of the Clairic comparison (manifest
  `27182b85839d8c4f8314855b81a1c4335c50fdc9253c08b032e8ce01987bc523`). Labels are not changed.
- Left out before any call: the 12 cases of source-02. Its view is 62,613 bytes, so both budgets show the
  model the same view and the cases cannot differ by arm. That leaves 28 cases over three histories
  (628, 1,637 and 692 messages): 24 answerable and 4 missing-answer.
- Arms: `--optchat-view-bytes 128000` against `64000`. A provider-free run shows what each budget gives:
  source-01 331 lines (102 KB) against 79 lines (32 KB), source-03 189 (72 KB) against 79 (32 KB),
  source-04 376 (118 KB) against 85 (32 KB). A view over its budget coarsens to half the budget, as in production.
- Each trial: a fresh host over its own copy of the frozen store, one question, the same instruction in both
  arms, memory tools only. Two repetitions per case and arm: 112 trials.
- Gates: prefetch, `chat_recall`, `chat_decisions` and `chat_work` on. Rules, value hints, Clairic extraction
  and child packs off, since they do not bear on answering one question.
- Models: main `anthropic/claude-sonnet-5-5`, compressor `anthropic/claude-haiku-5-5`, judge: the operator's
  `judge` role.
- Before the cases, one question outside the frozen set runs on one source at both budgets, to check the live
  mechanics. Its spend counts. Its answer is not graded.

## Grading

- Each answer becomes a packet with a random id: question, accepted source label, wrong candidates, answer.
  The arm, model, cost and tool list are not shown. Both arms answer in the same form.
- Two reviewers grade every packet on their own: `correct` (the answer states the accepted answer, or for a
  missing-answer case says the chat does not state it) and `misleading` (it presents a wrong or superseded
  answer as the answer). A third reviewer settles disagreements, still blind.
- A failed trial counts as not correct.

## Decision rule

- Pooled over both repetitions: the 64,000-byte arm passes only if it has at most 2 fewer correct answers than
  the 128,000-byte arm, no more misleading answers than it plus 1, and at least 15% lower main-model cost.
- If it passes, I propose the default change to Eric with this evidence; this run changes no default and ships
  nothing. If it fails, 128,000 bytes stays and the question is closed.
- Also reported: case-level exact sign test (a case counts for an arm only when it wins both repetitions or
  wins one and ties one), judge calls, view lines, prompt tokens, latency.

## Limits known in advance

- Three selected engineering histories of one user; not a sample of users or of long chats. The longest is
  1,637 messages.
- Repetitions are not independent samples, and questions about one history are dependent.
- The cases were written for retrieval tools, not for whole-turn answers.
- Both arms see the same frozen tree; only the tiling differs. The 128,000-byte arm of source-03 is under its
  budget and is shown as saved.
