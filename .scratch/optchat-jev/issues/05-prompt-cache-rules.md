Type: research
Status: open
Blocked by:

# Prompt-cache rules and the per-turn blocks

## Question

Two parts.

1. For the provider the plan uses, what are the current prompt-caching rules: maximum breakpoints per request, entry lifetimes and prices, how far back a breakpoint looks for an earlier entry, minimum cacheable size, and which usage fields report cache reads and writes? Check whether the spec's choices still hold: 3 breakpoints in the view plus one at the end, short-lived entries only, no keep-alive pings. Take the rules from vendor documentation and label every claim with its source.
2. How does omp-optchat place its marks today? `docs/research/omp-capabilities.md` §2 (row "Cache marks") cites `src/cache.ts:17-19,52-123,213-323`. Official Anthropic image-capable routes split the view into four-line blocks with one 5-minute mark on the last whole block; other routes use fixed cuts. The leading view must be the first message (`leadingView`, `src/cache.ts:124`). Does a rules message or a prefetch message after the view change any byte of the view's prefix? The plan's Milestone 2 test checks the rules case. Answer for the prefetch block too, and state the cost of the extra uncached messages per turn. Plan Milestone 6 measures that cost.

Write the findings to `docs/research/prompt-cache.md`, with a citation for each claim. Vendor claims stay labelled as vendor claims.

## Measured prefetch bytes per turn (2026-10-13, Milestone 6)

Per user turn on a merged 229-line view, the `<prefetch>` block bytes from the `prefetch counts ... bytes` deltas in `/optchat status`: 0, 0, 0, 7155, 6915, 0 over six turns (two blocks). This is the uncached per-turn input the prefetch block adds after the view. Not measured: the rules block bytes and the main model's token counts for those turns.

## Comments

Ticket 03 is resolved (provider route: `judge` role for Jev, OMP roles for the agent and compactor). The provider for the agent is the session's own model, so part 1 covers the session provider that the user's host actually runs.
