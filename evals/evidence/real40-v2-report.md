# Real-chat comparison: Clairic becomes opt-in

## Decision

The completed comparison fails the preregistered default-on gate. Starting with 0.16.1, Clairic extraction is off unless `--optchat-extract` is supplied. `--no-optchat-extract` still wins. Deterministic `chat_evidence` and judge-backed `chat_recall` remain enabled.

This is a default decision, not a claim that extraction can never help. No prompts, thresholds, retrieval settings or source labels were tuned on these results.

## Frozen comparison

- Manifest: `27182b85839d8c4f8314855b81a1c4335c50fdc9253c08b032e8ce01987bc523`.
- Evaluated implementation: commit `49c7233`; implementation digest `ec12d7d1451246f1e59a39f2dd0ddbe9b8d7406d7cf242cb8810b79e7d061b1b`.
- Forty independently source-reviewed questions from four frozen engineering histories: eight each about decisions, corrections, reports, exact facts and missing answers.
- Ten calibration cases and thirty held-out cases, fixed before calls. Two repetitions per case; repetitions are not independent samples.
- A: production `chat_recall`; B: deterministic `chat_evidence`; C: B's identical passages plus production Clairic rendering.
- All 240 outputs completed. All 1,352 returned citations reopened. Four independent reviewers graded randomized packets, then 80 randomized B/C pairs. All 352 decisive review citations reopened; identical outputs had no conflicting grades.
- Recall served `cloudflare/clef` on all 490 judge operations, not Jev. Eighty extraction operations used `cloudflare/clairic` through OpenRouter, with Cloudflare reported as provider.

## Held-out results

Support requires usable evidence in both repetitions. A misleading case has a misleading candidate in either repetition. Raw passages are not treated as assertions, so this is not a generated-answer accuracy comparison. The thirty held-out cases include 24 answerable questions and six missing-answer questions.

| Arm | Supported / 24 answerable | Misleading / 30 | False candidates / 6 missing | Median latency | p90 latency |
|---|---:|---:|---:|---:|---:|
| A: recall | 17 | 0 | 0 | 2,488 ms | 3,455 ms |
| B: deterministic evidence | 10 | 0 | 0 | 31 ms | 53 ms |
| C: evidence + Clairic | 10 | 9 | 1 | 376 ms | 434 ms |

Case-level paired usefulness favored C once and B four times, with 25 ties. Disagreeing repetition preferences count as ties. The two-sided exact sign-test p-value is 0.375, not below the frozen 0.05 threshold. The 95% Clopper–Pearson interval for C's share of discordant preferences is 0.005–0.716. This small sample does not establish a usefulness improvement. The increase in misleading cases also independently fails the default-on rule.

The ten calibration cases yielded seven supported answerable cases for each arm; C had four misleading cases versus zero for A and B. Calibration results are not pooled into the held-out test. Full category counts and review-artifact hashes are in [real40-v2-result.json](real40-v2-result.json).

## Cost and limitations

The user approved a $50 **best-effort target**, explicitly without a provider-enforced invoice ceiling. Local admission allocated $32.25: $16 for review overhead, $12.25 for recall operations and $4 for extraction operations. These are retained risk allowances, not measured charges. Every admitted operation has a matching settlement receipt; no known allowance overrun occurred.

All 570 paid operations have unknown actual billing. Recall's winner-only catalog diagnostic sums to about $1.095, but omits possible fallback billing and is not an invoice. Source/output reviewers' host-account charges are also unknown. The total actual cost is therefore **unknown**, not zero and not $32.25.

The histories are selected engineering conversations, not a representative user sample. Output shapes can reveal an arm despite randomized names. Source spans prove where text occurred, not that it is the correct answer. Private histories, questions, outputs and review text remain outside Git. The earlier v1 freeze and its offline receipts are preserved, not rewritten.

## Reproduction

Use commit `49c7233` with the private frozen manifest and source artifacts. The later opt-in change intentionally changes the current implementation digest, so running the old manifest against the release tree must fail closed. The private 43-file implementation archive has SHA-256 `49fdaecbc9eeddbd2bfff90c65ca96a78ffe3b8b5e7d79ed73120d393a943688`.
