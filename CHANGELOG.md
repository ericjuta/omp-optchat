# Changelog

## 0.2.0 — 2026-10-11

- Correct merge priority to measure age from each sibling pair's last message.
- Batch the main view from 128 KB to 64 KB and preserve its exact tiling and unfinished batches in atomic, fsynced `view.json` snapshots, including legacy-log migration and crash recovery.
- Give compression a separate 16–32 KB built-only context and a 512-dash ruler.
- Share the effective host system prompt and compatible captured tool schemas between turns and compactions, without executing compressor tools or bypassing destination-model capabilities.
- Use four-line Anthropic cache blocks and coordinate concurrent compressor prefix writes, with cancellation, retry, and unsupported-transport boundaries. Main requests may wait for compressor writers but are not tracked as writers because host response hooks lack request identity.
- Extend real-host smoke coverage for shared prefixes, saved-view stability, and installed-artifact verification. Preserve the existing leaf scheduler, retry policy, log vocabulary, host safety, and thinking exclusion.

## 0.1.0 — 2026-10-05

- Add opt-in OMP OptChat sessions with a durable, append-only message log and binary contextual summary tree.
- Start fresh inference contexts from an incremental summary view while preserving active tool loops, steering, asides, and background reports.
- Provide lossless `zoom`, message dates, JSONL/text imports, and a private navigable HTML export.
- Add contextual background compression, UTF-8 budgets, fixed retries, cancellation, Linux single-writer locking, recovery fsync, and descriptor-anchored filesystem access.
- Keep native thinking and the host's private thinking tool out of memory.
- Add capability-gated provider cache markers, fail-closed host deadline handling, regression coverage, and real-OMP synthetic-provider smoke verification.

See README for the Linux requirement, the 25-second host settle limit, supported cache transports, and the stateless OpenAI launch setting.
