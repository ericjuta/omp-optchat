# Changelog

## 0.4.0 — 2026-10-11

Tracks Wayfinder map [#2](https://github.com/ericjuta/omp-optchat/issues/2).

- **Requires OMP 18.9.0** (SDK packages pinned to 18.9.0; peers `>=18.9.0`). CI verifies both the pinned cohort and the latest published cohort on every push and weekly.
- Fix the idle-recap refusal ([#1](https://github.com/ericjuta/omp-optchat/issues/1)): host side turns (agent-attributed messages absent from the session branch) pass through without opening, reusing or poisoning a main turn. User text that mimics a recap stays ordinary input.
- Scheduling ([#3](https://github.com/ericjuta/omp-optchat/issues/3)): dependency-ready queues replace tree scans. Leaves are admitted while fewer than eight earlier leaves are unbuilt, and parents become ready as soon as both children exist. Failed calls release their slot at once and retry on the next appended message. `--optchat-retry-ms` is removed.
- The compactor tiling and its batch latch persist in `view.json` v2 together with the main view, in one atomic snapshot. Restarts reproduce the exact compactor prefix. v0.3.0 snapshots migrate once without changing the main tiling.
- Archive ([#4](https://github.com/ericjuta/omp-optchat/issues/4)): long records are summarized in bounded UTF-8 pages and reduced to a single leaf, with no truncation and no new IDs. `zoom(id, 1, offset)` returns 16 KB pages with `details.next`. If no shortening attempt fits a 16 KB safety ceiling, the leaf fails instead of being cut. Images in user, assistant, tool, and report messages are stored content-addressed and returned by `zoom` after restart. Records keep the host event timestamp.
- Subagents ([#5](https://github.com/ericjuta/omp-optchat/issues/5)): task, async, and launch reports are stored as `work` records with provenance (job ID, agent ID, name, source, completeness). They are captured before the ordinary tool cap, with full structured data and typed artifact hydration. A report is labeled incomplete when the host delivered only a preview. The new `work(name, offset)` tool retrieves them. Opt-in `--optchat-child-view` gives subagents a frozen, read-only snapshot with `zoom`/`date`/`work`. Every read and prompt injection checks both the parent's live publication and the child's adopting session. The snapshot is revoked on switch or shutdown and never opens a second writer.
- Host frontier ([#7](https://github.com/ericjuta/omp-optchat/issues/7)): `/optchat status` reports stateless-OpenAI, settlement-deadline, host-maintenance, request-correlation, and child-view caveats. Host APIs that OMP 18.9.0 does not expose are tracked upstream and are not worked around.
- Evidence ([#6](https://github.com/ericjuta/omp-optchat/issues/6)): `bun run evidence:recall` is an opt-in, budgeted, synthetic-only recall and usage runner against real models. It runs in an isolated HOME and agent directory, copies only the selected credentials, and checks the effective system prompt for private context before any call. `OPTCHAT_METRICS_FILE` records compressor usage as content-free JSON lines. Measured on OMP 18.9.0 with Sonnet 4.6 and Haiku 4.5: 15 of 16 recall questions correct, all 16 grounded in zoomed originals, none hallucinated, including after a process restart. See README for usage figures, which are a sample and not a savings claim.
- Task reports that OMP delivers as nested previews are recorded as incomplete. Agent IDs never authorize file reads.
- Import/export accept `work` records with metadata. `exportJsonl` provides a lossless export.

## 0.3.0 — 2026-10-11

- Automatically activate OptChat in main-agent sessions when the enabled plugin is discovered, for fresh installations and upgrades alike; `--optchat` is no longer required.
- Add `--no-optchat` as a session opt-out that takes precedence regardless of flag order, leaving ordinary context intact and creating no OptChat store or compressor work. Subagents remain inactive.
- Exercise isolated plugin linking, automatic discovery, default activation, and explicit opt-out against the real OMP host. Preserve existing memory-directory ownership and host compaction behavior; no global settings are changed.

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
