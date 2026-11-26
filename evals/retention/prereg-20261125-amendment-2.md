# Amendment 2 to prereg-20261125.md (2026-11-26)

Written after the report and its hand-check (`report-20261125.md`), and before any rerun answer was seen. Eric approved it on 2026-11-26 (he chose "fix the runner and rerun the 512-record cells").

## Why

The hand-check found that all 21 visible quotes behind the `fabricated-citation` grades at 512 records are word for word in the cited record. The runner counted original text only from `zoom` (n=1) and `work` results. The view arm also has `chat_search` and `chat_evidence`, which return original text. A quote read through them was graded as fabricated. The artifacts kept only 240 characters of each answer and no tool names, so the finished cells cannot be regraded.

## What changes

- Runner (`scripts/evidence/host.ts`): a `chat_search` snippet and a `chat_evidence` passage now count as original text of the record they name. An error result still counts for nothing. A search snippet is the record's text on one line (its whitespace flattened) and at most 240 bytes, so a quote copied from a snippet is accepted as the tool showed it.
- Artifact: each question now keeps the turn's final text (at most 16,384 characters) and the name of every tool called. `zoomedSourceRecord` is now true when any of these tools returned text of a source record.
- The scorer (`scripts/evidence/scoring.ts`), the corpus, the questions, the prompt and the models do not change.
- Driver: `RETENTION_ONLY=<regex>` runs only the matching cells.

## What is rerun

The six view-arm cells at 512 records: seeds 1, 2 and 3, at 128,000 and 64,000 bytes. The whole-history cells are reused: their citations are checked against the seeded records, which this change does not touch. The 48- and 128-record cells are not rerun; the views lost nothing there.

    cp .verify/retention-20261125/cell-s?-512-off.json .verify/retention-20261126/
    RETENTION_ONLY='-512-on-' evals/retention/run.sh 27.09 .verify/retention-20261126 1 2 3

## Budget

The $40 total cap stands. The first run spent $16.44, of which $3.53 is the three reused cells. The driver gets $27.09 ($40 less the $12.91 spent on cells outside the new directory), and counts the reused cells as spent. Expected spend is about $7, an estimate from the first run.

## Reading the result

- The rerun replaces the 512-record view rows of the report. The first run's rows stay in the report, marked as graded with the narrower rule.
- The decision rule is the same: 64,000 bytes is worth a real-chat check only if it loses at most 2 pooled answers to 128,000 bytes and cuts main-model cost by at least 15%. No default changes from this run.
- New view-arm answers are new samples, not a regrade: a different result may come from sampling as well as from the grading change. The stored answers and tool names will show which tools the failing citations came from.
- The reused whole-history cells ran on an earlier commit than the rerun cells. `src/` is the same.
