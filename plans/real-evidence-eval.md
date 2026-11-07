# Evaluate real-chat recall and Clairic

## Purpose / Big Picture

Measure whether Clairic improves the usefulness of evidence from real saved conversations without adding misleading answers. This plan follows `.agent/PLANS.md`. It does not assume that locating text proves the text answers the question. The user first approved a $5 hard cap, then explicitly approved a $50 best-effort target without a provider-enforced guarantee. The earlier exact-manifest approval requirement remains: freeze and present the manifest SHA before paid calls.

## Progress

- [x] (2026-11-07) Inspected the existing synthetic runner, grading contract and prior manifest.
- [x] (2026-11-07) Froze 40 private real-chat questions and independently accepted source labels: 32 supported and eight scoped missing-answer cases. Reopened all 208 independent-review citation spans against original UTF-8 bytes. Retained original candidate labels and created separately hashed approved artifacts.
- [x] Built the separate real-snapshot runner. Offline runtime checks cover concurrent invocations with serialized reservations, cancellation settlement, retained unknown-cost reservations, final-call overspend refusal, citation validation and input admission. These checks make no real provider calls.
- [x] Repository verification before the best-effort revision passed: 2,599 unit tests, 56 host tests, and the synthetic-model/real-OMP smoke with ten host processes and 38 requests. The revised evaluation-only budget code then passed its separate strict typecheck and the repository typecheck. Its provider-free runtime smoke exercised exact-policy validation, request-byte rejection, per-arm counts, full allocation exhaustion, unknown/failed allocation retention, overrun halt, concurrent invocation and cancellation halt.
- [ ] Freeze the protocol and get exact-SHA approval before paid calls.
- [ ] Run the three arms and independently grade anonymized outputs.
- [ ] Record the default decision, limitations and measured results; ship any resulting production change only after normal release verification.

## Surprises & Discoveries

The old `evals/evidence/run.ts` builds synthetic head summaries and checks spend after calls. Unknown extractor costs do not advance its spend counter. It cannot demonstrate a strict $5 ceiling unchanged. Its grader treats deterministic retrieval and extraction differently, so its success rates are not directly comparable answer-accuracy rates.

A read-only request through host credential resolution to OpenRouter `GET /api/v1/key` returned `limit: null`, `limit_remaining: null`, `limit_reset: null`, and `effective_budget: null`. No inference call was made. The current key supplies no provider-side budget ceiling. OpenRouter's limits documentation says its in-flight reservation applies only to some accounts and excludes non-token fees; do not assume it enforces this evaluation's $5 cap. Sources: https://openrouter.ai/docs/api_reference/limits and https://openrouter.ai/docs/guides/community/extractions. Clairic's public price is $0.10 per million input tokens, but that alone does not establish a per-request upper bound across passes or retries.

## Decision Log

On 2026-11-07 the user approved the proposed 40-question real-chat comparison. Use eight questions each about decisions, corrections, reports, exact facts and missing answers. Freeze source histories before querying arms. Keep transcripts and per-case answers private under ignored `.verify/real-evidence/` or an external cache. Do not rewrite earlier frozen evals.

Use real stored summaries for recall. A synthetic head-summary rebuild would measure a different navigation surface. Preserve production recall's concurrent judge calls and deadlines: serialize reservation accounting, not the admitted model invocations. Drain every admitted request before ending the case. A winning host result's estimated or partial cost is not proof of complete attempt-level billing. Arm A is production recall, arm B is deterministic evidence, and arm C is the same evidence plus the production Clairic renderer. Use the shipped limits and thresholds. Do not tune them on held-out results.

Split cases by a deterministic seeded, category-stratified assignment into 10 calibration cases and 30 held-out cases before any run. Calibration checks only the mechanics and grading protocol; any protocol change requires a new freeze before held-out calls. Report both sets separately. Two repetitions use the same snapshots and questions. Keep arms and outputs hidden from source-label reviewers; anonymize arm identity during output review as far as output shape permits.

The first freeze stopped before paid calls because no enforceable $5 ceiling was available. The user then said "$50 is fine" and selected "Yes, proceed best-effort" after disclosure that the route is uncapped and some charges are unknown. This explicitly replaces the hard-cap prerequisite; it does not make an estimated cost a known charge.

The revised protocol allocates $16 for source/output review overhead, up to 1,200 recall operations at $0.025 each, and up to 80 extraction operations at $0.05 each. These sum to $50. The allowances are conservative risk allocations, not measured prices or guaranteed upper bounds. Failed and unknown operations retain their full allocations. Reject requests above 262,144 UTF-8 bytes before dispatch. Stop new admission on cancellation, exhausted call limits, a known charge above its allowance, or invalid accounting. Production host-internal attempts remain part of one operation and may have unknown billing. Do not claim that this enforces the actual provider invoice.

For the default decision, keep Clairic default-on only if independent blind paired review prefers C's usefulness over B significantly (two-sided exact sign test, p < 0.05), supported-answer coverage does not fall, the paired misleading-case count does not increase, citations reopen correctly, and the run completes within the approved request/allocation limits without known overruns. Report unknown billing separately; the user-approved best-effort policy does not establish an actual dollar ceiling. C contains B's same passages, so increased retrieval coverage is not a meaningful primary gate. Review usefulness as correctly identifying the relevant supported answer with less ambiguity, not simply providing an extra model line. Count comparisons by case across repetitions, not as independent repeated samples; inconsistent repetition preferences are ties. Report exact paired uncertainty and category counts. A completed comparison that fails or remains inconclusive recommends default-off; production changes require the full repo gates and installed-plugin smoke. A blocked or incomplete comparison has no measured default verdict and leaves the current installation unchanged. Do not infer general accuracy from this small corpus.

## Outcomes & Retrospective

The original freeze completed 80 deterministic B runs with no operational failures. All 640 returned citations reopened exactly. No answer-quality grading or paid recall/Clairic evaluation calls had run before the budget revision. Preserve the original manifest, outputs and 43-file implementation archive; its archive SHA is `82459b8eaa9056636b2669c9ea0f2e5ae41ac1d78e8010d93cb2c5492341515a`. v0.16.0 remains unchanged while the comparison is prepared. Source-label reviewers run as ordinary OMP task agents; their host-account usage is not metered by the evaluation runner. Do not describe the total preparation effort as free or include those calls in a claimed zero-dollar total.

The candidate corpus uses four existing frozen engineering-session snapshots, not a random sample of current users or all conversation domains. Any result applies first to these selected historical cases. Two repetitions measure within-case variation; they do not double the independent sample size. Historical questions and source cutoffs must not be presented as current product facts.

## Context and Orientation

`src/system1/evidence.ts` retrieves bounded passages. `src/system1/extract.ts` calls OpenRouter through host-resolved credentials and renders unverified occurrences. `src/system1/recall.ts` navigates stored summaries with the host judge. `evals/recall/judge.ts` provides host judge access and metering. `evals/evidence/run.ts` and `grade.ts` are prior synthetic evaluation artifacts and stay unchanged.

A snapshot is an immutable copy of source messages and stored summary nodes at a fixed cutoff. A supporting citation identifies a source message and exact byte range that answers the question in its historical context. A superseded statement is not current support when the question asks for the final decision. A missing-answer label requires review of the frozen source, not merely a retrieval miss.

## Plan of Work

Prepare private case and reviewer packets without seeing arm outputs. Independently review all labels against frozen histories; resolve disagreements before model calls. Hash source files, cases, labels, runner and relevant production modules in a public manifest that contains no transcript text or private paths.

Screen the complete selected snapshots, including summary nodes, for credential material before admitting them to model calls. Screen outgoing states as well. Ordinary mentions of secrets or token counts are not credentials, so broad lexical flags require private review. Report only locations and classes for suspected secrets. Do not silently redact frozen histories or print secret values. If a source needs redaction, create a new disclosed snapshot and repeat the freeze and label review as needed.

Add a separate real-snapshot runner at `evals/evidence/real-run.ts`. It must preserve message IDs and actual summary nodes, refuse changed inputs, refuse output overwrites, and support provider-free preflight and arm B. Save rendered outputs, citations, elapsed time, served model identity and known-or-unknown costs privately. Reopen cited source bytes as part of preflight and grading.

Use source-grounded blind review for supported answers, misleading answers, abstentions and citation validity. Also report retrieval coverage separately: B supplies passages, not an asserted answer. Grade an arm's returned usable support consistently while recording C's explicit wrong extraction separately. Do not count B's refusal to assert anything as evidence that B answers absent questions correctly.

## Concrete Steps

Run commands from the repository root. The private wrapper is `.verify/real-evidence/corpus-v1/manifest-real40-v2.json`; its hash is recorded in the public freeze receipt. Run each command once into its new output directory:

```sh
bun evals/evidence/real-run.ts --manifest .verify/real-evidence/corpus-v1/manifest-real40-v2.json --out .verify/real-evidence/preflight-real40-v2 --mode preflight
bun evals/evidence/real-run.ts --manifest .verify/real-evidence/corpus-v1/manifest-real40-v2.json --out .verify/real-evidence/b-real40-v2 --mode B
```

Preflight uses a logical clock and is not measured performance. Arm B uses production timing, two repetitions and no credential resolution or provider requests. Reopen output citations and report latency separately from support quality. Preserve this frozen protocol; store subsequent run receipts outside its implementation hash.

Run `bun run typecheck`, `bun run test`, `bun run test:host`, and `OPTCHAT_SMOKE_OMP=/home/ericjuta/.bun/bin/omp bun run smoke` for permanent runner integration. Explicitly typecheck `evals/evidence/real-*.ts`, which are outside the normal source check. Expected results are successful exit codes and no provider attempts in offline smoke.

After exact-SHA approval, execute the frozen live command once into a new output directory. Grade anonymized outputs without changing gold labels to accommodate observed answers. A genuinely incorrect gold requires invalidating the affected comparison and reporting it, not silently rescoring for a favorable outcome.

## Validation and Acceptance

Acceptance requires 40 reviewed real questions, frozen snapshots and labels, all three arms on identical inputs, two repetitions, independent output judgments, reopened citations, latency and honest cost reporting, and a default decision under the frozen rule. Finish offline checks before requesting exact-manifest approval. If approval or an admission prerequisite is missing, report that concrete blocker. Do not claim completion of the live comparison.

## Idempotence and Recovery

Never open a live store as a writer or mutate its logs. Never commit transcripts. Runs use unique output paths and stop on changed hashes. Preserve partial results after failure. Retry policy must be frozen before calls; default is no automatic retries, and errors remain visible.

## Artifacts and Notes

A parent-side hash check verified all 16 frozen source files against their recorded byte sizes and SHA-256 digests, covering 3,201 source messages across four snapshots. This checks snapshot integrity, not the correctness of case labels or model answers.

Four independent reviewers each examined ten questions without arm outputs or other reviewers' labels. Parent reconciliation found no answer-status or core-answer disagreements. All 208 primary and counterexample citation spans reopened exactly. Accepted absence labels apply only to their complete named snapshots and cutoffs, not to external accounts, later chats or world truth. Review artifacts, source inventory and approved labels remain private and separately hash-bound.

Private corpus, snapshots and outputs belong under `.verify/real-evidence/` or an external private cache. Public artifacts contain only hashes, aggregate counts, protocol and limitations. The historical synthetic evaluation and its decisions remain unchanged.

## Interfaces and Dependencies

Use the existing production recall, evidence gathering, extraction rendering and host credential APIs. The runner receives explicit snapshot and case paths, a manifest hash, selected arms and output directory. It never reads API secrets directly or prints credential contents. The public manifest binds every input needed to reproduce the comparison without publishing private text.
