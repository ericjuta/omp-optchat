Type: prototype
Status: resolved
Blocked by:

# Does the view fold behave as described?

## Question

Does append-then-fit with the most-due rule keep the view under budget, tile every message, change mostly near its end, and wait correctly when parents aren't built yet? The prototype would push messages of different sizes, delay or fail compactor builds, shrink the budget, and watch the parts and the shared-prefix length. Cases: one huge message, a burst of 100 short ones, a compactor 30 seconds behind, a budget smaller than the recent tail.

## Answer

Resolved by omp-optchat's implementation and its tests, not by a separate prototype. The fold lives in `src/memory.ts` (HEAD: `coarsen` at line 377, `commit` at line 412). It is tested in `tests/memory.test.ts` by these named tests (HEAD line numbers):

- 213: admission stops eight unbuilt leaves ahead, however many jobs are free.
- 279: an over-long source is summarized through every page, then reduced to one leaf.
- 399: short sources become nodes verbatim without a model call, measured in UTF-8 bytes.
- 509: an unresolved early leaf stalls only its ancestors; the right subtree still completes.
- 959: settle resolves per caller once every view line is a summary, without waiting for merges.
- 1040: restart restores the persisted live tiling instead of replaying today's complete tree.
- 1287: the last-message age prefers 8+1|9+1 over 0+4|4+4 at T10.
- 1309: the main view's bytes sawtooth from upper to half, and available parents do not retile between batches.
- 1407: the default main upper is 128000 bytes, and an overflow batch reaches 64000 with a 16000-byte context.
- 1469: the view budget counts UTF-8 bytes of summaries, not UTF-16 units.

Where this differs from the original design: omp-optchat merges the adjacent pair whose last message is oldest, `(T - last) / 2^l`, not the design's start-based `due` (`docs/design/optchat-jev.md` §2.4). The view budget is a sawtooth, 128,000 down to 64,000 bytes.

Gaps not covered by a named test: a burst of 100 short messages, a budget smaller than the recent tail, and an explicit assertion that the view tiles `0..T` after every append. The plan adds these as tests in its Milestone 2 and 3 work, and records them in its Decision Log.
