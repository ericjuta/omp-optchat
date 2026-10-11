Type: prototype
Status: answered (synthetic), 2026-10-11
Blocked by:

# Should the agent retrieve memory by writing code?

## Question (re-scoped 2026-10-11)

Does a retrieval script run in the OMP eval kernel find old facts in fewer steps and at lower cost than the agent zooming one level at a time, or than the prefetch gate? The kernel already has the pieces: `tool.zoom`, `tool.date`, `tool.work`, and `judge_batch` (`docs/research/omp-capabilities.md` §1.3). No new memory API is needed.

Run three strategies on the same probes, against a synthetic tree (fake summariser, planted facts at known ages):

1. zoom-only: the agent steps through `tool.zoom` one level per step;
2. prefetch top-k: the gate's logic (chunked `judge_batch` over the view lines, top 8 by probability, one-level zoom);
3. beam descent: `judge_batch` over the view lines, keep the top B, zoom each kept line, score its children, keep the top B overall, stop at level 0 or below a threshold.

Use a fake judge first, through the plan's `OptChatOptions.judge` seam. Jev comes later, once ticket 02 gives access. Report per strategy: probes found, agent steps, judge calls, zooms, and bytes returned. Decide whether the hackathon build includes codemode retrieval, the prefetch gate, or both, and the starting beam width and size cap.

## Result (2026-10-11, synthetic, no provider calls)

Harness: `bun run evidence:retrieval` (`scripts/retrieval-compare.ts`, `scripts/retrieval/`; test `tests/retrieval-compare.test.ts`). A real `Memory` over a real `Store` in a temp directory, 256 messages, 12 planted facts (topic phrase + unique value) at known ages, a fake summariser that drops values always and drops topics with merge depth, and a fake judge whose P is topic-word overlap. Budget: 24 agent calls per probe; $0, no model. Artifacts: `.scratch/optchat-jev/retrieval/seed-1.json`, `seed-2.json` (re-runs are byte-identical).

| Strategy | Found (seed 1 / 2) | Agent steps | Judge calls | Zoom calls | Bytes returned |
|---|---|---|---|---|---|
| zoom-only | 3/12 / 5/12 | 230 / 193 | 0 | 230 / 193 | 76,575 / 63,251 |
| zoom with depth ≤ 4 | 3/12 / 5/12 | 223 / 181 | 0 | 223 / 181 | 101,629 / 92,068 |
| `chat_search` | 12/12 / 12/12 | 24 / 24 | 0 | 12 / 12 | 8,704 / 8,393 |
| prefetch top-8 | 3/12 / 5/12 | 227 / 188 | 12 | 235 / 195 | 79,234 / 64,713 |
| `chat_recall` | 3/12 / 5/12 | 12 / 12 | 42 / 37 | 8 / 8 | 9,807 / 8,818 |
| beam descent (B = 2, script) | 3/12 / 5/12 | 12 / 12 | 42 / 34 | 39 / 30 | 3,540 / 2,883 |

Every summary-navigating strategy found exactly the facts whose topic survived in the view (3 and 5 of 12); a dropped topic gives them nothing to steer by. `chat_search` was the only mechanism that reached dropped topics. Among the navigators, `chat_recall` and beam reached the same facts in one agent step each instead of ~200 zoom calls, and beam returned the fewest bytes. Depth zoom saved few steps and returned more bytes.

What this does not show: real summary quality or drop rates (the summariser is a rule), Jev's judgement (the judge is lexical overlap, so all judge strategies share one failure mode), real agents' query words (probes name the topic exactly, which favours search), or cost and latency (judge calls are counted, not priced).

Decision: keep `chat_search` (deterministic, the only path to dropped details), `chat_recall` (one step instead of a zoom walk when the topic survives), and depth zoom (cheap to keep, no measured gain here). Codemode beam retrieval needs no new API and stays available through the eval kernel; it is not built into the plugin. Next evidence: the same probes with real summaries and Jev, under a stated budget.

Context: `docs/design/optchat-jev.md` §3.6 (reads only, bounded, tool-gated scripts) and §3.3 (prefetch). The answer feeds ticket 06 and the ablation list in `docs/evals/rubric.md`. The read-only rule needs a check: a script can call any enabled tool through `tool.<name>`, so the allowed set must be enforced and tested, not assumed.
