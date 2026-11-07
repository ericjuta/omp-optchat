# Frozen real-chat review rubric

This rubric evaluates source support, not whether a model followed instructions. Freeze its hash with the cases before collecting arm outputs. Reviewers must not inspect arm identities, other reviewers' judgments, or aggregate scores.

## Source-label review

Review each question against its complete frozen source history. Record whether it has an answer as of its specified cutoff. For an answerable question, cite exact UTF-8 byte ranges and state what each range supports. Identify plausible superseded, contradicted, proposed-only or wrong-version answers. A completion claim proves that someone reported completion; only an appropriately linked original tool result supports an observed result, and only to the extent its content demonstrates it.

For missing-answer cases, explain what information is absent and what related text could be mistaken for it. Searching unsuccessfully is not sufficient to label absence. If full-history review cannot establish the label, reject or replace the case before freezing. Do not invent a gold answer to fill a category.

Question authoring and source-label review must finish before any arm sees the question. Reviewers receive source packets, not outputs. Keep review text private.

## Output review

Give each output a randomized opaque identifier. Show the question, its historical cutoff, independently accepted source labels, the returned text and reopenable source citations. Do not show its arm, model, cost or timing. Output shape can reveal its origin; describe this limitation in the final report.

Assign `usableSupport` true only if the returned material directly supports an accepted answer in context. A keyword match, task announcement, superseded decision or extracted number with the wrong release is not usable support. For a missing-answer case this field must be false; absence is evaluated separately.

Assign `misleading` true when an output presents an incorrect or superseded answer as the relevant candidate, or omits a necessary qualifier so its asserted answer is wrong. An explicit unverified extraction can still be misleading. A raw passage that visibly contains a proposal or an old decision is not automatically an assertion of current truth. Record a short reason and the decisive source citation for every misleading judgment.

Assign `abstained` true when the output declines to identify an answer. A deterministic list of passages without an answer claim is `not-applicable` for answer abstention, not automatic successful abstention. Report that distinction rather than crediting the deterministic arm with perfect absent-answer accuracy.

Assign `citationValid` true only after each claimed support citation reopens to the stated source bytes in the frozen snapshot. Set it to `not-applicable` for outputs without citations, and false if any claimed citation is invalid. Source identity and message ID must both agree.

Record operational errors separately from omissions. Never turn a failed request into a correct abstention. Exclude failed and blocked rows from answer-abstention counts. Keep latency and cost outside review packets. Unknown cost remains unknown even if a request returned nothing.

Before aggregation, verify the manifest, accepted-label artifact, snapshot/question bindings, output hashes and B/C shared evidence. Do not infer these bindings from matching case IDs. Sum known individual call receipts even when another call in the same row has unknown cost. Reconcile an evaluation-wide ledger that includes arm calls, grading and other charged attempts. A boolean declaration of resolved accounting is not a spending ledger. The total stays unknown while any charge is unresolved.

## Aggregation and decision

Report each arm's answerable-case support coverage, misleading cases, absent-case false answers, citation failures, operational failures, latency median and p90, and known spend plus unknown-cost count. Report calibration and held-out splits separately, with category breakdowns. Treat both repetitions of one question as paired observations, not independent questions.

For the held-out default decision, a case is supported only if both repetitions provide usable support. A case is misleading if either repetition is misleading. Compare C with B by case. Their source passages are identical, so retrieval coverage cannot establish an extraction benefit.

After independent per-output grading, present B/C pairs with randomized left/right order and no arm labels. Reviewers choose left, right or tie for correctly identifying the supported answer with less ambiguity. Bind each preference to both exact output packet IDs and their SHA-256 digests, and retain the randomized left/right mapping. A preference from a different run is invalid even if its case and repetition match. An extra extraction line earns no preference by itself. Incorrect extraction is not useful even if it is short or confident. Missing-answer cases prefer a justified refusal over a misleading candidate, not over an equally clear lack of support. Inconsistent preferences across repetitions count as a case-level tie.

Report discordant paired preferences and a two-sided exact sign-test p-value. C passes the proposed default gate only with a significant preference advantage (p < 0.05), no decrease in supported-case coverage, no increase in misleading cases, valid claimed citations, and a complete run within the approved best-effort request/allocation limits without known overruns. Actual charges may remain unknown under the user's explicitly approved $50 policy; allocations must never be reported as actual spend. Otherwise the result rejects or fails to establish the default-on case. Arm A is a comparator, not a substitute for the C-versus-B decision.

There is no automatic default-switching scorer. Produce an auditable case-level worksheet from accepted, output-bound reviews, then independently verify its counts, exact sign test and evaluation-wide accounting before making a default recommendation.

Resolve reviewer disagreements by an independent adjudicator with source access, still blind to arm identity. Do not change frozen source labels after seeing results without invalidating and disclosing the affected evaluation. A judgment correction must keep its original record and reason.
