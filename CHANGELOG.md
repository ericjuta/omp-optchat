# Changelog

## Unreleased

- **Session-model fallback:** when the `judge` role has no candidate, OptChat's judge is the session model, marked as a fallback. Only the tool gate runs on it. Rules, prefetch, value-score and recall are inactive, `/optchat status` says why, and `chat_recall` stays registered and answers that it is inactive, so tool definitions do not change. Before, with no role candidate, all five gates ran on the session model.
- **Gate counters in `/optchat status`:** per gate, judge calls, failures and outcomes (tool gate allowed/asked/blocked; rules added/replaced; prefetch blocks and bytes; value-score hints; recall answered/none/failed), in memory for the session. Printed only while a gate is on; with every gate off, status is unchanged.
- A judge factory that throws is now recorded under the gate's label (for example `rules: ...`), not its purpose string.

## 0.7.0 — 2026-10-11

- **`chat_search(text, kind, limit, before)`:** finds stored messages containing every word of `text`, case-insensitively, newest first, with ~240-byte snippets and `before` paging. It reads the original log, so it reaches names, paths, numbers and errors that summaries dropped. Memory tool calls and search/recall results are never hits. Child views search only their snapshot. Always on with memory, like `zoom`.
- **`zoom(id, n, depth)`:** opens up to 4 levels at once (`2^depth` lines). `depth` 1 is the old behavior, byte for byte.
- **Recall gate (on by default; `--no-optchat-recall`):** registers `chat_recall(question)`. The judge scores the view lines, the best line at or above `--optchat-recall-min` (default 0.5) is opened, and one two-way choice per level leads to a single message, returned with its descent path and first 8 KB. At most ⌈lines/64⌉ + log₂ n judge calls, 20 s overall and 5 s per call. Failures return an explicit "recall failed" result.
- Tool names carry a `chat_` prefix because OMP reserves `search` (alias of `grep`) and `recall` (builtin).
- The tool gate never screens `chat_search` or `chat_recall`. `/optchat status` shows the recall gate. The memory guide in the system prompt documents both tools, so its bytes change once (the evidence runner's pinned system-block size is 6277 bytes).
- Memory-only harnesses (integration tests, smoke, `evidence:recall`) also opt out of the recall gate.
- **`bun run evidence:retrieval`:** offline, deterministic comparison of zoom, zoom depth, `chat_search`, prefetch, `chat_recall` and a scripted beam descent over a synthetic tree with planted facts (fake summariser and judge, no provider calls). Two seeds: summary navigators found only the facts whose topic survived in the view (3/12, 5/12); `chat_search` found 12/12; `chat_recall` needed one agent step where zoom needed about 200. Mechanics only, not a quality claim; details in ticket 10.

## 0.6.0 — 2026-10-11

- **System One gates (all on by default; opt out per gate with `--no-optchat-rules`, `--no-optchat-prefetch`, `--no-optchat-value-score`, `--no-optchat-tool-gate`):** Four judge-backed gates use the host's `judge` role: standing rules (`--optchat-rules`, with `/optchat rules` and `/optchat rules remove ID`), view prefetch for each user message (`--optchat-prefetch`), a one-sentence importance hint per compacted leaf (`--optchat-value-score`), and a tool-call gate (`--optchat-tool-gate`). Thresholds: `--optchat-rule-add`, `--optchat-prefetch-k`, `--optchat-prefetch-min`, `--optchat-tool-ask`. A failed judge changes nothing and the session keeps running; the tool gate fails closed.
- **Upgrading (behavior change):** the gates send judged text to the `judge` role's provider and cost up to two judge requests per user message, one per long compacted leaf and one per screened tool call. Set `modelRoles.judge` in OMP's `config.yml` (for example `openrouter/~typesafe/jev-latest`); with no credentialed judge the gates do not run. Opt out per gate, or pass all four `--no-optchat-*` gate flags for 0.5.0 behavior.
- A rule keeps only the sentences of the message that the judge rates as standing instructions; a one-sentence message is kept whole.
- Standing rules are stored in `ledger.jsonl` beside the chat log. Shutdown waits up to 1.5 s for queued rule triage, then abandons it, so a triage never writes after the store closes.
- With every gate opted out, context and `/optchat status` match 0.5.0. The evidence runner opts its hosts out, so its benchmark keeps measuring memory alone.
- Planning kit ported into the repository: `AGENTS.md`, `plans/`, `docs/`, `.scratch/`, `vendor/`, `.agent/`, and project skills in `.omp/skills/`. Documentation only; no runtime change.

## 0.5.0 — 2026-10-11

Tracks Wayfinder map [#9](https://github.com/ericjuta/omp-optchat/issues/9). SDK packages pinned to 18.9.1 (peers stay `>=18.9.0`).

- **Durability (#11):** Add real-subprocess SIGKILL recovery coverage for image-bearing appends, summary commits, and history imports; publish HTML exports from fsynced private staging files without overwriting existing targets, then fsync the parent directory.
- **Archive GC (#12):** Reclaim unreferenced image blobs and abandoned image/view staging files after validated writer startup, preserving replayed references and reporting nonfatal cleanup failures.
- **Behavior change:** Sessions inside git repositories no longer use `~/.omp/agent/optchat`. Each worktree gets its own memory under `optchat-worktrees/` beside that directory, and a new worktree starts empty. Sessions outside git keep the global store. `--optchat-dir ~/.omp/agent/optchat` restores the old single shared memory.
- A startup lock conflict (another live session holds the store directory) now deactivates OptChat for that session, as `--no-optchat` does, with one warning, instead of refusing every prompt. Corrupt or otherwise unreadable stores still refuse prompts.
- **Benchmark (#10, #13):** `bun run evidence:recall` gains paired OptChat on/off arms (`--arms on,off`), compressor comparison (`--compressors`), per-question turns, adversarial and long corpora (up to 40 projects and 512 records), a subagent-memory experiment (`--experiments child`), `--main-context-window`, and a hard dollar ceiling (`--max-cost-usd`, at most $30). The dollar ceiling uses byte-based bounds, a pinned main output cap, per-host compressor reservations that release completed calls at their observed cost, and main-model pricing for refusal fallbacks. Artifacts are schema `optchat-evidence-recall/3`, with main, compressor, auxiliary, and estimated maintenance usage. The `--max-calls` ceiling is 2000 and the `--deadline-ms` ceiling is 30 minutes. Measured on Sonnet 5.5 and Haiku 5.5 (see README "0.5.0 measurements", n = 3 per setting):
  - When history fits the context, both arms answered 24/24, and OptChat cost $0.13–0.20 more per run.
  - Past the context window, OptChat answered 24/24 with exact quotes. Plain OMP, after compacting, named 16/24 correct values and quoted 10/24. OptChat cost about $1.10–1.18 per run, against $0.05–0.56 for plain OMP.
  - Subagents with `--optchat-child-view` answered 4/4; blind subagents answered 0/4.
- **Upstream (#14):** API proposals for context-event purpose, cancellation and correlation ([can1357/oh-my-pi#15365](https://github.com/can1357/oh-my-pi/issues/15365)), complete async-output references, maintenance ownership, and audio/video ingress, posted on the matching upstream issues.
- Failed compressor calls record the provider's stop reason and error text in `OPTCHAT_METRICS_FILE`, and the thrown error includes it.
- Evidence corpus padding is natural prose. Word-list padding made Claude 5.x refuse summarization with `Refusal (bio)`.
- **Refusal fallback:** A compressor refusal (`stopReason` error starting `Refusal`) is retried once with the session's main model. The fallback has a 30-second wall deadline; if it lapses, OptChat cancels it. If the main model also refuses or lapses, OptChat commits a marked, source-derived excerpt for the node so the tree settles and later prompts are not refused. The "not ready after 25 s" notice now appears only for real timeouts; a summary that failed without retry says so. `/optchat status` counts main-model retries and stand-ins.

## 0.4.1 — 2026-10-11

- Fix the evidence runner's credential-routing guard: parse all three source model-config formats instead of substring-matching only `models.yml`. Escaped or aliased selected provider keys, shadowed overrides, and unreadable or invalid configurations now block before credential copying or host discovery. Diagnostics omit config contents; unrelated provider settings remain usable.

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
