# Automated research loop (reference: mapped onto OMP `/ratchet`)

How an agent can improve OptChat + Jev unattended, one experiment at a time, scored by `rubric.md`.

**Status: reference only.** Not implemented by `plans/optchat-jev.md` (user direction, 2026-10-11). The OMP host already ships a loop of this shape as `/ratchet` and the eval-kernel `ratchet(flow)`. This file says how to aim that machinery at OptChat, and what the omp-optchat evidence runner covers.

## What the host provides

- `ratchet(flow)` (eval kernel) builds a trusted eval for one LLM flow and hill-climbs it one change per round, keeping only changes that also win on held-out cases. The `/ratchet` command runs the same loop from the chat. State lives under `.omp/ratchet/<flow>/` (`docs/research/omp-capabilities.md` §1.6).
- We rely on the host for the parts a loop must not get wrong: approvals, the dev and held-out split, keep and revert decisions, and held-out acceptance. Check each one against the installed version before a run; the rest of this file says what we expect.

## Flows (one ratchet flow each)

1. **Compressor prompt.** The summary instructions in omp-optchat's `src/prompts.ts`. Scored by M4 (claim support) and M1 (recall by age).
2. **Jev question wording.** The question texts of the rules, prefetch and value gates, once they exist. Scored by M5a calibration against labels.
3. **Thresholds.** `--optchat-rule-add`, `--optchat-prefetch-k` and `--optchat-prefetch-min`. Scored by M3, M5b and M6b.

Structural changes (new gates, the write path, the view rules) are not a ratchet flow. They need a human-approved experiment file first.

## One round

1. Read `experiments/results.jsonl`, the current Pareto front, and the newest adversarial failures.
2. Write `experiments/NNN-<slug>.md` before running anything: the single change, the hypothesis ("prefetch k 8 → 4 cuts cost per turn by 10% with no M2 loss"), the metric expected to move, and the budget.
3. Apply the change on a branch named `exp/NNN-<slug>`.
4. Run cheap checks first: unit tests in the omp-optchat repository (`bun test tests`), then M6d prefix stability with fake models. Stop early if a hard gate fails.
5. Run the `dev` split end to end (three repeats).
6. Score, append to `results.jsonl`, and apply the acceptance rule in `rubric.md` section 4.
7. If it qualifies, run `heldout` once. Accept only if it holds there too.
8. Record the outcome and what was learned in the experiment file. Merge accepted branches; keep rejected ones for reference.
9. Add any new failure case to the `adversarial` split.

Steps that need a human (confirming flagged status-inflation cases for hard gate G3, structural changes) don't block the loop: mark the experiment `needs human`, leave the branch unmerged, and move on to the next experiment.

## End-to-end checks: the omp-optchat evidence runner

The omp-optchat repository has `bun run evidence:recall` (`package.json`, script `scripts/evidence-recall.ts`). It is the place for end-to-end recall checks (M1, M2) and any run that touches a real host. Read its header before a run to confirm whether it calls a model and what it spends. Do not start it without the budget stated in the experiment file.

## Roles

- **Proposer**: an agent that reads the current best configuration, recent results and open failures, and proposes exactly one change with a hypothesis.
- **Runner**: the host's ratchet for flow-level changes, and deterministic scripts (`evals/run.ts`, `evals/score.ts`, not yet written) for the rest.
- **Judge**: a model role other than `judge` (Jev), from a different family than the session model and the compactor. Used only where a metric says "judge".
- **Human**: owns the generator, judge prompt, scorer, heldout data, budgets and thresholds for the hard gates. The loop proposes changes to these in writing; it never makes them.

## Search space, in order

Start where changes are cheap and deterministic; move outward only when the inner layer stops paying.

1. **Constants and thresholds**: the view upper and target budgets (128k/64k, 256k/128k bytes), `NODE` (256, 384, 512, 768), `TRIES`, prefetch `k` (0, 4, 8, 16) and depth (1, 2), rule add threshold, the compactor model (`--optchat-model`) and its effort.
2. **Prompts**: the compactor prompt (`src/prompts.ts`), the agent's system prompt, Jev question wording and question sets.
3. **Structure**: new gates, search over the raw log, codemode retrieval strategies, topic indexes, changes to the turn loop. These need a human-approved experiment file before they start.

## Budgets and stop rules

- Each experiment file states a dollar and time budget; the runner stops when either is reached.
- Stop the loop after five consecutive rejected experiments on the same layer, and move to the next layer or ask a human.
- Re-run the baseline whenever a model version or price changes; old rows are not comparable across model versions.
- A run whose price is unknown is reported with `unknown` cost (`rubric.md` section 3). Never compare a run with a zero where the price is missing.

## Guarding against overfitting

- `heldout` is checked only at acceptance and its contents are never shown to the proposer.
- Refresh `dev` with new seeds every 10 accepted experiments.
- When a threshold moves by more than 0.1 in one experiment, re-check it on replayed real sessions before accepting.

## Experiment file template

    # NNN: <one-line change>

    Hypothesis: <what should move, by how much, and why>
    Change: <exact constants, prompt diff, or code change>
    Layer: constants | prompts | structure
    Budget: $<n>, <n> minutes
    Configs run: <baseline id> vs <candidate id>, splits, repeats

    ## Result
    <scorecard deltas with confidence intervals; gates>

    ## Decision
    accepted | rejected | needs human, and why

    ## Learned
    <one to three sentences future proposers should know>
