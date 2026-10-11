Type: grilling
Status: open
Blocked by: 03

# Eval scope for the hackathon

## Question

Which parts of `docs/evals/rubric.md` do we implement first? Decide: dataset sizes per split, which metrics are computed in v0, the judge model, the dollar budget per eval run, and which hard gates are enforced from day one.

## Comments

Scope note (2026-10-11): the eval harness and the automated research loop are out of scope for the current build, by the user's direction. The current plan (`plans/optchat-jev.md`) builds the gates and their checks, not the harness. This ticket decides the first harness when the build reaches that point. Until then, the rubric and schemas stay reference documents, and the loop is mapped onto OMP `/ratchet` in `docs/evals/autoresearch-loop.md`.
