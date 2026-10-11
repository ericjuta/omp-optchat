Type: prototype
Status: open
Blocked by:

# Should the agent retrieve memory by writing code?

## Question (re-scoped 2026-10-11)

Does a retrieval script run in the OMP eval kernel find old facts in fewer steps and at lower cost than the agent zooming one level at a time, or than the prefetch gate? The kernel already has the pieces: `tool.zoom`, `tool.date`, `tool.work`, and `judge_batch` (`docs/research/omp-capabilities.md` §1.3). No new memory API is needed.

Run three strategies on the same probes, against a synthetic tree (fake summariser, planted facts at known ages):

1. zoom-only: the agent steps through `tool.zoom` one level per step;
2. prefetch top-k: the gate's logic (chunked `judge_batch` over the view lines, top 8 by probability, one-level zoom);
3. beam descent: `judge_batch` over the view lines, keep the top B, zoom each kept line, score its children, keep the top B overall, stop at level 0 or below a threshold.

Use a fake judge first, through the plan's `OptChatOptions.judge` seam. Jev comes later, once ticket 02 gives access. Report per strategy: probes found, agent steps, judge calls, zooms, and bytes returned. Decide whether the hackathon build includes codemode retrieval, the prefetch gate, or both, and the starting beam width and size cap.

Context: `docs/design/optchat-jev.md` §3.6 (reads only, bounded, tool-gated scripts) and §3.3 (prefetch). The answer feeds ticket 06 and the ablation list in `docs/evals/rubric.md`. The read-only rule needs a check: a script can call any enabled tool through `tool.<name>`, so the allowed set must be enforced and tested, not assumed.
