# Changelog

## 0.16.1 — 2026-11-07

- Clairic extraction is now opt-in with `--optchat-extract`; `--no-optchat-extract` still wins. Deterministic evidence and recall remain enabled. The provider is not opened by default.
- Frozen real-chat comparison: 40 questions, three arms, two repetitions, 240 completed outputs, and 1,352 valid citations. On 30 held-out cases, Clairic was preferred once versus four times for deterministic evidence, with 25 ties (exact sign-test p = 0.375). It added misleading candidates on nine cases versus zero without extraction, with no support-coverage gain. This fails the preregistered default-on rule; it is not a general accuracy estimate. See `evals/evidence/real40-v2-report.md`.
- Actual billing remains unknown for all 570 paid operations. The $32.25 retained best-effort allocation is not spend. Recall served Clef, not Jev; its approximately $1.095 winner-only cost diagnostic is not an invoice.

- Added a separate real-chat evaluation runner with frozen source and label hashes, exact UTF-8 citation checks, private output packets, and independent review instructions. It preserves production recall concurrency and evidence rendering. The evaluated source is preserved at commit `49c7233`, before the opt-in change.
- Paid evaluation requires exact-manifest approval. After the original hard-cap preflight stopped, the user approved a $50 best-effort policy with fixed request counts and retained per-call allowances. These controls do not guarantee provider billing. Host winner-only cost metadata is not complete billing; unknown costs stay unknown.

## 0.16.0 — 2026-11-07

- Release verification: CI passed for the pinned/latest SDK and Linux/macOS leases. The 2,599 unit tests and 56 host tests passed. Remote-tag installation and installed-plugin smoke passed using real OMP with a synthetic model. Restart existing OMP sessions to load this version.
- If parent logging fails, OptChat revokes persisted child evidence packs. Compound questions/directives and human corrections that contain result markers cannot silently preserve stale accepted decisions.
- Documentation correction: OptChat has no ordinary-tool screening/approval gate. Disabling the four judge gates does not disable Clairic extraction. Use `--no-optchat-extract` separately. The source-only host patch was not submitted upstream and is not required by this release.

- Added bounded incremental chunk retrieval and `chat_explain`/`/optchat explain` accounting. Removed the bottleneck that limited candidates to the top 50 whole messages. Coverage and omissions are explicit.
- Extracted spans are now unverified candidate occurrences, never verified answers. OptChat withholds mismatched values, truncated input, impossible null probabilities and wrong exact question identifiers. Provider transmission remains on by default when a key resolves. `--no-optchat-extract` disables it.
- Added conservative timelines/project state through `chat_decisions` and discovery through trusted metadata in `chat_work`. Added deterministic, task-focused child packs and explicitly allowlisted, Linux-only, read-only `chat_project_evidence` snapshots. Other platforms fail closed for cross-store reads. Local memory stays unchanged. This release does not require or install an upstream host patch.
- Persist host tool success/error only with its exact captured call link. Import downgrades those observations to historical claims. Host tool success does not prove process, test or project success. Stores containing the new metadata require 0.16.0+ to reopen.
- Added frozen zero-dollar paired software evaluation and lifecycle smoke. Synthetic/injected-outcome evidence does not establish live-model quality. Uncertainty and unknown costs remain visible.
- Removed obsolete tool-wording and argv-copy assertions. Retained memory/context and behavioral safety contracts. Child fixtures supply the current SDK's prompt/revive event reason while remaining compatible with the pinned SDK.

## 0.15.2 — 2026-11-08

- **Fixed: the extractor's response-size bound.** The extractor previously read the full body before checking its size. A response without a content-length header could therefore be of any size. The extractor now reads the body as a stream and cancels it once it passes 262,144 bytes.
- **Fixed: a reported extraction cost of 0 now appears as `cost unknown`.** The route reported $0 on every eval row, although Clairic's listed price is $0.10/M input tokens. The 0.15.0 entry's "cost reported $0" is therefore unverified, not a measurement.
- **Fixed: docs said `chat_evidence` sends nothing to any model.** Since 0.15.0 it sends its passages to Clairic whenever a key resolves. The 0.15.0 entry's "(no model call)" covers only the passage search.
- **Changed: the extractor key can come from the environment.** OMP's credential cascade may return `OPENROUTER_API_KEY` instead of a stored key. Eric accepted this. AGENTS.md and README now say so.
- **Changed (#16): background merges no longer rewrite the main view piece by piece.** When a node finishes between messages, OptChat publishes its merges only if they bring the view to its target in one step. Otherwise the tiling waits for the next append. The lines before the tail thus stay byte-identical between turns, as in UniiChat's `Memory.fit`. Part 2 of #16 concerned the compactor ageing pairs against the chat length. This was already fixed: `coarsen` takes each view's own end.
- **Known issue, from a real-chat check (n = 3, on this repo's own store):** one exact answer, one abstention and one misleading answer. In the misleading case, ranking missed the gold message and Clairic returned a wrong value with p_null 0.078. Details are in `plans/evidence-layer.md` Outcomes. Disable extraction with `--no-optchat-extract`.
- **Judges:** the 0.15.0 rules and evidence comparisons stand as `cloudflare/clef` results, as served. Eric accepted them without a Jev rerun.


## 0.15.1 — 2026-11-07

- **Fixed: CI on the latest SDK.** omp 18.18.0 refuses to start on Bun below 1.4.4. Thus, every host test that starts `omp` failed in the latest-SDK job. This job was failing since d66f41f, including the v0.15.0 tag. CI now pins Bun 1.4.4, the version the local gates use. No plugin code changed.

## 0.15.0 — 2026-11-07

- **Added: Clairic extraction in `chat_evidence`, on when an `openrouter` key exists.** It sends passages to OpenRouter's `cloudflare/clairic` extractor using the host's `openrouter` credential at call time. It adds one line after the trailer with the answer's exact message bytes and a `zoom` that reopens them. This line appears only below `--optchat-extract-null` (0.5) and only when its span maps inside one passage. Without a key, it adds nothing. An error or the 10 s bound leaves the passages unchanged.
  - `--no-optchat-extract` disables extraction. This feature sends chat passages to OpenRouter and Cloudflare.
  - **Evidence:** the first pre-registered run (seed 20261107) failed its own span criterion only because the criterion did not define null-value abstentions (48/80). That run was not adopted. A second pre-registered run on fresh cases (seed 20261108) defined that case and passed every criterion. Extractor results: grounded 1.0, abstain 1.0, misleading 0, span equals value 48/48, p90 275 ms, cost reported $0 on every row. `chat_evidence` alone scored grounded 1.0. `chat_recall` scored grounded 0.667 and misleading 0.35 (judge served `cloudflare/clef`).

    Total spend for both runs was $0.061.
  - **Live check on installed OMP 18.17.0:** the returned bytes after an emoji and an accented letter were exact.
- **Added: `chat_evidence`.** This deterministic memory tool (no model call) returns up to 8 exact passages (≤2,048 bytes each, ≤16,384 bytes total, 10 s limit). Each passage includes its message id, kind and zoom-valid UTF-8 byte offsets. A trailer always lists searched messages, words not found and partial reports. The tool is on by default. `--no-optchat-evidence` removes it. It is not a System One gate.

  With every gate opted out, it stays available and still resolves no judge. Child views can use it only within their snapshot.
- **Changed: one standing rule per sentence.** A pre-registered eval supported adoption: 51 synthetic cases × 3, rule-add F1 0.985 for both old and new, and no new false positives. The new version also handles the two old-rule replacements the old one missed. Cost was $0.046, with the judge served as `cloudflare/clef`. "Use British English. Always ask before deploying." now stores two rules, so withdrawing one leaves the other. OptChat keeps whole sentences, so "unless…" clauses stay attached. Replace and withdraw targets are the newest 16 rules plus the 16 most relevant, instead of the newest 32. This keeps old rules reachable.
- **Fixed: `chat_evidence` in short chats.** With only a few stored messages, every word the question shared with a report weighed 0 under BM25. The search therefore covered only the question itself. Evidence ranking now uses a smoothed, always-positive weight. `chat_recall` ranking stays unchanged.
- **Fixed: README install pin** now names the current tag.

## 0.14.0 — 2026-10-23

- **Fixed: nested speaker labels cannot turn tool-only history into human speech.** Provenance validation recognizes wrapped speaker labels while preserving literal quotations. Retry fallbacks exclude invalid candidates. Exhausted attempts use the existing marked extractive fallback.
- **Fixed: tool-result pointers use recorded identities.** A multi-report `wait` no longer shifts a later call's `zoom` pointer onto a different report. Links survive reopen and import. Unmatched legacy calls remain unknown rather than receiving an ordinal guess. Session changes fence delayed captures.
- **Fixed: the compressor ages context against its own endpoint.** Queued messages outside its built context no longer change which pair it merges. Partial publication remains unchanged.
- **Changed: human rule withdrawals are durable.** The judge assesses explicit withdrawals or ended scopes independently of additions. OptChat checks them against offered active IDs. Retired IDs disappear from subsequent context assemblies, including an assembly waiting for prefetch. OptChat does not rewrite requests already assembled or transmitted. Peer messages never receive human rule authority.
  - Triage requests now include withdrawal questions. Earlier rule-add accuracy measurements do not establish accuracy for these changed requests. Removed incidental prompt-byte tests. Behavioral rule-authority and withdrawal regressions remain.
- **Added: source-bound diagnostics.** Status reports the loaded plugin version, session identity and actual last observed main/compressor cache modes, with unknown before observation. Modes do not claim provider cache hits or savings. Compaction wording now describes possible in-turn cuts.
- **Added: matching source-only host capabilities.** OptChat captures typed, authenticated agent coordination as a note with provenance. Cumulative public task reports use immutable artifacts bound to their run, bytes and digest. OptChat archives these independently of final acknowledgements. These capabilities require the matching OMP source patch. The installed host, launcher, running sessions and configuration stay unchanged. Terminal keystroke delivery is not an agent-authority fallback.
- **Proof boundary:** fixes for the six reported host regression failures exist in the source-only host checkout. Its focused host suite then passed 461/0, and the two-process collab-send smoke passed. The matching host patch is not installed by this plugin release.
- **Storage compatibility:** new strict `resultFor` and `coordination` metadata preserve old rows but are not readable by older strict plugin versions. Keep a compatible reader for stores written by this version.
- **Evaluation discipline:** the two observed named-job recall misses remain private, unscored cases bound to their source. They do not establish fixed semantic recall. An offline paired experiment failed 18 of 42 progress boundaries, so deferred cache publication was rejected. Prefix-byte improvements are not provider savings.
- **Not adopted: stronger first-pass concision.** The paired merge experiment completed 12 tasks × 2 repetitions and 48 swapped native-Jev judgments under the $4.50 cap ($0.52537 accounted). The candidate's compressor cost point estimate was lower, but its cost-ratio confidence bound, quality non-inferiority bound and judgment-order agreement all failed the pre-registered rule. No compressor prompt/default changed. Compressor costs calculated from configured tariffs are not invoices.

## 0.13.3 — 2026-10-21

- **Fixed: a huge open turn no longer stalls host compaction.** OptChat moved every cut outside the open turn. When that turn contained most of the context, compaction freed too little. One live session went 250,654 → 215,536 tokens, and OMP paused automatic maintenance until the turn reached 851,238 tokens.
  - The host's cut now stands if the turn's dropped part is larger than the older history in bytes. It also stands if the cut cannot move to the turn's first message. The marker names that first message (`zoom(id, 1)`), and the metric row says `cut-in-turn`.
  - A turn opening with no new message keeps the old behaviour. Tests: `tests/metrics.test.ts` "larger than the older history" fails on 0.13.2.

## 0.13.2 — 2026-10-21

- **Changed: a second session outside git no longer runs without memory.** Without `--optchat-dir`, every session outside a git checkout used the one global `optchat/` store. Starting OMP in a second such directory therefore warned "OptChat is inactive: … is in use by another session". When another session holds the global store, the new session opens its working directory's own store under `optchat-dirs/<name>-<sha16>` beside it. One notice reports the directory. The session goes inactive only if another session holds that store too. An explicit `--optchat-dir` never falls back.

- **Fixed: a close error after a successful `/optchat new` rename no longer reports the archive as failed.** After renaming the directory, `Store.archive` could fail to close a stream, the root descriptor or the lease. It then threw "Failed to close Store resources". `/optchat new` said it could not archive the chat and did not reopen, although the chat had moved.
  - After a successful rename, `archive` now returns the archive path. It reports close errors as a warning that names that path. A failure before or at the rename still rejects with nothing moved. The lease still releases exactly once.

- **Internal: the store lease check runs in CI.** `bun run verify:lease --strict` runs on Linux (TLA+ model plus real processes). Its real-process phase and the store suites run on macOS, which uses the `flock` lease path that Linux never runs. The lease mutants have flock variants there. `--deep` adds the five guarantees with three sessions (about 4.1 million states each, all hold). The default run and CI exclude it because of its time and memory requirements.

## 0.13.1 — 2026-10-21

`bun run verify:lease` found two issues through its TLA+ model and real-process checks of the store's writer lease. Both are fixed. Each fix has regression tests that fail on 0.13.0.

- **Fixed: `/optchat new` could archive a store that another session had open.** It closed the store and released the lease, then renamed the directory by pathname without holding it. A session that opened the directory in that gap lost its live store to the archive. It kept writing into the directory that the user was told was closed.

  The store now archives itself (`Store.archive`): it keeps its lease and root descriptor through the rename and releases them after. It renames only while the path still names the leased inode. If the path moved or was replaced, `/optchat new` fails with "Refusing to archive …". It renames nothing and reopens as it does for any archive failure. A concurrent user `mv` between that check and the rename stays possible, since rename takes a pathname.
- **Fixed: rules ledger and `metrics.jsonl` writes used pathnames, not the store held by the session.** The store follows its inode after a directory move. However, each write opened `ledger.jsonl` and `metrics.jsonl` as `<directory>/…`. After a user `mv` or the archive race above, rules and metric rows went to whichever store was then at that path.
  - Both now resolve through the held root descriptor. `Store.sidecarPath(name)` is valid only synchronously and only while the store is open. OptChat drops metric rows for a closed store or a store whose lease failed. It does not warn for each row, because the store already reported its failure. `OPTCHAT_METRICS_FILE` still takes precedence.
- **Changed (internal API): `Store.archive(now, report?)` replaces `archiveStoreDirectory`.** `RuleLedger.open` takes a resolver `() => string` instead of a directory. It calls the resolver at open and at each write. `nextArchivePath` stays.

## 0.13.0 — 2026-10-21

These changes follow a read-only audit of 15 real sessions, 10 stores and 9,920 compressor metric rows. Jev also assessed 121 memory-tool calls: found 77, partial 29, miss 11, error 3, unclear 1. Every fix has a test that fails on 0.12.0.

- **Fixed: `work(name)` finds subagent reports.** Four of the five audited `work` calls failed with `no captured work is recorded`. A `task` spawn stores a pointer-only record. Finished reports arrived inside `wait` results, which OptChat logged as plain tool output. Each completed task job in a `wait` result is now its own work record with its job id and agent name.
- **Fixed: tool output is no longer summarized as the user's words.** A compressor line whose messages contain no user message may not carry a `user:` tag. OptChat retries it like a head. If every try repeats the tag, OptChat removes it (`userRetries` in `/optchat status`). Since 0.10.3, 6 leaves and 44 merges carried a false `user:` tag.
- **Changed: leaf lines open with their source kind, written by code.** The compressor invented `finding:`/`decision:` labels on up to 26% of a store's lines. The style spread through merges. A leaf line now opens with `user:`, `talk:`, `tool:`, `echo:`, `work:` or `note:`, which replaces any other leading label and counts toward the byte limit. Merges and verbatim nodes are unchanged.
- **Changed: a tool call's `zoom` page names its result** (`[result: message N]`). Five of the 11 audited misses zoomed the call instead of the result. Pairing is by position, since the store keeps no tool-call id.
- **Changed: `chat_search`.** `before` must be at least 1, because 0 could never match. The G5 golden is re-pinned for this one schema line. A multi-word search with no hit lists how many messages hold each word and, when `chat_recall` is registered, suggests it.
- **Changed: compressor cache anchor.** OptChat's trailing system block gets its own cache marker behind the host's stable anchor (four markers at most). A change early in the view therefore no longer rewrites the system prompt. In the audit, 361 cold rebuilds (3.6% of calls) were 40% of $311 spend. No saving is claimed until a week of metrics before and after compares the cold-rebuild share.
- **Changed: `metrics.jsonl` rows.** Compressor rows carry `type`, `at`, `node` (leaf or merge), the true `attempt`, the `retry` cause and `waitMs` separately from provider `latencyMs`. Removed `purpose`. Host compactions get their own rows: `marker`, `cut-moved`, or `cancelled` with a reason. Rules triage also gets its own rows: P(rule), cutoff and added, without text. Spend counts compressor rows only. Untyped older rows still count as compressor calls.
- **Changed: an inactive session says why in its session log** (`optchat-inactive` entry with the reason and store directory), not only in a UI notice.
- **Docs:** README recommends `compaction.thresholdTokens` of about 200,000–300,000. Marker compactions are free, and OMP's own side requests send the raw history. There were 12 "prompt is too long" failures before 0.12.0.
- **Not adopted (pre-registered, plan Decision Log 2026-10-21):** a compressor system prompt of OptChat's guide alone, instead of the host's prompt plus the guide. On 40 real compaction tasks (seed 20261021, blind pairwise assessors), it was better on 26, worse on 11, with 3 ties. Prompt cost per call was $0.0155 vs $0.0480. However, its first replies broke a hard rule 12 times vs 9, all over the byte limit. After retries, both arms stored 1 violation each. The frozen rule counts first replies, so the host prefix stays.

  Run cost was $4.04 of $5. Scripts are in `evals/compressor/`.
- **Not changed:** OptChat does not re-summarize stand-ins from compressor refusals when a store opens. A store refuses a second, different row for the same tree node. Older plugin versions could not open a store that had one.
- **Measured, not changed:** with a loopback model, a turn's first request differs from the previous turn's last only at the old view's tail. The requests share 92% of bytes. The exception is when the view coarsens, which rewrites it. This does not explain the live 38–55% turn-start cache reads. A 330k-token tool-heavy turn is 88% open-turn messages, 10% host system prompt and under 1% OptChat.

## 0.12.0 — 2026-10-20

- **Fixed: OMP no longer shows "Auto context-full maintenance cancelled" over and over in a long chat.** OMP decides when to compact from its own estimate of the raw history it holds, not from what it sent to the model. OptChat cancelled every compaction. Once the raw history passed the threshold, every check started maintenance, which OptChat then cancelled. These checks ran before each prompt, after each run, and between tool calls.

  OptChat now answers a host compaction (automatic, `/compact`, or the experimental rollover) with one fixed marker summary and makes no model call. OMP drops raw history the model never reads, since the view already carries it. Its checks stay quiet until the raw history passes the threshold again. A compaction never cuts the open turn: the cut moves to the turn's first message, or OptChat cancels it when nothing older can go. A host compaction summary in the message list is never logged or sent after the view. `/optchat status` describes this.
- **Evidence:** a live check used installed omp 18.12.3 with a loopback model and a 30,000-token threshold. Experimental rollover was on, as in Eric's config. With 20 prompts of about 18 KB, 0.11.1 showed 28 cancelled maintenance runs and no compaction. This release ran 3 marker compactions and no cancelled run, with the same 20 main and 61 compressor requests. The marker never reached the model. The classic path, run for 8 prompts, showed the same pattern: 4 cancelled runs before, 1 marker compaction after.

  Three real-host cases fail on 0.11.1 and pass now: rollover, classic, and a tool loop that crosses the threshold mid-turn. Unit tests are in `tests/compaction.test.ts`.
- **What changes for you:** after a host compaction, OMP shows the marker in place of the older transcript, as it does for any compaction. The full history stays in OptChat's log and tree (`zoom`, `chat_search`, `chat_recall`) and in the session file. A long session compacts once at its first check after upgrading. The evidence runner counts a marker compaction at exactly zero cost, since it makes no model call.

## 0.11.1 — 2026-10-19

- **Tests: the three real-timer bound tests are deterministic.** The shutdown (1.5 s), prefetch (50 ms) and memory-hint (20 ms) bounds now fire through held timers (`tests/helpers/held-timer.ts`) instead of wall-clock waits. Each test still fails when its bound is broken. No runtime change.
- **Not adopted (pre-registered, plan Decision Log 2026-10-19):** a rules prompt stating the standing-instruction boundary cut false adds 6 → 2 on relabeled train data. The fresh test set held only 6 labeled rules of 120 (minimum 20), so it was not run. A recall pick that also reads the 4 messages after each contender lost on 38 fresh blind cases. Results: 74 vs 68 of 114 runs, 2 better, 6 worse, p = 0.965. Rule-add stays 0.8 and recall is unchanged.

## 0.11.0 — 2026-10-18

- **Changed: the child view is on by default.** Subagents get the parent's frozen, read-only snapshot (`zoom`, `date`, `work`, `chat_search`) without `--optchat-child-view`. `--no-optchat-child-view` disables it and takes precedence over `--optchat-child-view`, like the gate opt-outs. Evidence: the 0.5.0 child experiment answered 4/4 with the view and 0/4 without (child cost $0.20 vs $0.09, n = 4 per arm). The evidence runner's blind arm now passes the opt-out. No prompt or tool bytes change for the parent. `/optchat status` reports the child view as published, or unavailable when the session has no artifact manager.

## 0.10.3 — 2026-10-17

- **Fixed: concurrent cold compressor calls no longer each write the whole system prefix.** The cache coordinator keyed only on message marks. Each compressor call's last mark is its own task line, so no two calls ever waited for each other. In a cold 64-message build, 7 concurrent leaf calls each wrote about 66K tokens and read none ($0.167–0.173 each).
  - A compressor call now also keys on its anchored tools and system head. Later calls wait for the first writer's response to start and then read the prefix. Main requests never wait on a head alone, the 20 s fail-open stays, and no prompt or tool bytes change. A live check after the change used n = 3 with no same-session control. The first call wrote 65,171 tokens ($0.1646). The next two read 61,980 each ($0.0163, $0.0158). Tests in `tests/cache.test.ts`.
- **Fixed: no stored line is the bare `[unsummarized: compressor refused]` marker.** Eight lines in one live store were exactly the marker, all written by the compressor copying it (the code's own stand-in always carries an excerpt). OptChat now retries a reply that opens with the marker, after any heads, as it would retry a head. When no other reply is usable, compaction falls back to the marked source excerpt. A summary that mentions the marker later in the line is kept. Earlier lines are unchanged. Tests in `tests/memory.test.ts`.
- **Not changed:** the compressor keeps the host system prompt as its shared prefix (prompt bytes and the G5 golden unchanged). No rules round on precision: the three non-rule messages the gate added on the fresh set are borderline standing instructions. Also, 6 labeled rules in 120 messages cannot ground a ratchet. Rule-add stays 0.8.

## 0.10.2 — 2026-10-17

- **Fixed: summary lines no longer keep a compressor head after the retries run out.** When every retry still opened with a head (for example `2272+8|…` on line 2272+16, or `Merged 2328+4 and 2332+4.`), `compact()` stored the first fitting reply unchanged. It now removes detected heads before storing that reply. It keeps a reply whole if it contains nothing but heads. `Merged a+n and b+n.` naming the line's own range and `Compaction output:` are now detected as heads.

  Earlier lines stay unchanged. This affects only lines built from now on. Regression tests in `tests/memory.test.ts`.
- **New default: OptChat records compressor calls in `metrics.jsonl` in the store directory.** Records contain counts and metadata, never content. Fields are model, token counts as the host reports them, attempt, purpose, latency, reported cost or `null`, stop reason, and bounded error. `/optchat status` shows the store's calls and their reported cost. A call without a reported cost appears as unknown, never as $0.

  `OPTCHAT_METRICS_FILE` now only redirects the file. `/optchat new` archives it with the old chat.
- **Evals:** the recall runner reports gold-only and per-gold-kind pass rates next to the credited rate (`run.json` key `scores`, `gold_kind` per row).
- **CI:** runs on `ubuntu-26.04` with `actions/checkout@v7`.
- **Not adopted (pre-registered fresh tests, defaults unchanged):**
  - **`--optchat-rule-add` 0.75:** 120 fresh real messages labeled blind (6 rules), 3 runs each. 0.75 was better on 0 cases and worse on 5, and added 4 non-rules that 0.8 does not (F1 0.286 vs 0.387). The rules 0.8 misses score 0.55–0.73, below 0.75 too. The default stays 0.8.
  - **Higher `--optchat-prefetch-min`:** 11 train turns selected 90 distinct lines at 0.5. Blind labels classified 58 as relevant and 32 as off-topic. Every candidate dropped relevant lines: 0.6 lost 10 of 138 relevant selections, 0.7 lost 52, and 0.8 lost 116. Thus, none was frozen and no test ran. The default stays 0.5.
- **Measured, one cold parallel build (not typical):** 7 Sonnet 5.5 leaf calls each wrote 66–68K cache tokens and cost $0.17. Warm compressor cost is unmeasured. `metrics.jsonl` now records it in live use.

## 0.10.1 — 2026-10-17

- **Fixed: a `chat_recall` whose pick was cut by the 20 s bound or a cancel no longer reads the winner's first page before failing.** The outcome was already `failed`. Reading the stored page was wasted work. Regression test in `tests/recall.test.ts`.
- **Evals, no behaviour change:**
  - **Agent-reply follow-up for the 0.10.0 scan:** 20 blind questions whose answer is an agent reply, with 3 runs per arm. The halving descent answered 22 of 60 runs, and the scan answered 43 of 60. Results: 12 cases better, 1 worse, one-sided sign test p ≈ 0.002, $0.12 against $0.11. The 0.10.0 gain therefore holds for agent replies too, not only tool results.
  - **Not adopted, pick on stored text over the top 8:** the pick showed each contender's first page instead of its summary. It took the top 8 scored messages instead of those within 0.1 of the best. Train looked better (89 vs 83 of 108 runs). However, the pre-registered confirmation on 40 new blind questions was flat. It used 30 tool-result, 8 agent-reply and 2 subagent golds, with 3 runs per arm. Results: 77 vs 76 of 120 runs, 5 cases better and 4 worse, p = 0.5.

    Recall stays unchanged.
  - **Not adopted, rules triage on sentences:** this candidate added a multi-sentence message when any sentence reached `--optchat-rule-add`, without the whole-message score. It scored 0.924 vs 0.920 on the 79 held-out rules cases, with 3 runs per arm. Results: 2 cases better, 1 worse, p = 0.5, and one additional false positive. Most missed real rules are single sentences scoring 0.6–0.79, which sentence logic cannot reach. `--optchat-rule-add` stays 0.8.
  - **Old recall: held-out versus fresh cases.** It scored 0.54 on the held-out real cases and 0.339 on the fresh cases. Both sets find the gold itself equally often (0.30 against 0.31). The held-out set is 55% agent-reply golds, and those cases credit judged alternatives far more often. The fresh set was 92% tool-result golds. Comparisons across sets should report gold-only and per-kind rates next to the credited rate.

## 0.10.0 — 2026-10-16

- **Changed default: `chat_recall` scans the messages under its top lines.** The halving descent is gone.
  - **Seeds:** local BM25-style length normalization re-ranks the word search's widest pool without a model call. A short message that states the answer thus outranks a long dump. The top `--optchat-recall-seeds` become single-message candidates.
  - **Scan:** the same relevance requests as before score view lines and seeds. If no line reaches `--optchat-recall-min`, the outcome is `none`. Otherwise, recall scans the top `max(k, 4)` multi-message lines at or above `--optchat-recall-min`. One more round of the same requests scores every built message under those lines, up to 256 messages. Recall skips a whole line if its unscored messages would exceed the cap. It lists that line as a failed other when k > 1.
  - **Pick:** eligible single-message candidates either reached `--optchat-recall-min` or lie under a scanned line. Recall ranks them and the scanned messages by score. One choice question shows those within 0.1 of the best (at most 8), side by side in message order. The likeliest wins. A failed pick keeps the score ranking. Recall asks no question unless 2 or more messages contend.
  - The result path is the scanned line covering the message, then the message, with its first 8,000 bytes. Removed the descent prompt (`RECALL_DESCENT`). `--optchat-recall-k` (default 1, 1–8) now widens the scan beyond 4 lines. Above 1, it also lists the losing messages as others.
  - Judge calls per recall: about ⌈(lines+seeds)/64⌉ scoring requests, plus 1–4 scan requests, plus at most 1 pick. Bounds stay unchanged (20 s overall, 5 s per judge call), and recall never throws.
  - **Why:** in the recall ratchet's failing train attempts, the answer sat under the 2nd–4th line or a near-tied candidate. A one-way descent from the top line could not reach it.
  - **Evidence:** the `chat-recall-sets` ratchet gate reverted the change as round v4. Results were train 0.769 vs 0.620 and held-out 0.736 vs 0.694 ±0.143, inside noise. Adoption instead followed a pre-registered confirmation: 60 fresh real questions, written blind and graded by blind assessors. Each question had 3 runs per arm (seeds 8, k 1). The baseline answered 61 of 180 runs, and the scan answered 116 of 180. The scan was better on 23 cases and worse on 2.
    - The golds were 55 tool results and 5 agent replies, because packet order put the rarer reply candidates last. Thus, the measurement mostly covered gains on tool-result answers.
    - On fresh questions answered by a tool result, the scan was better on 20 cases and worse on 2. It had 108 vs 58 passing runs of 165.
    - On the 5 fresh questions answered by an agent reply, the scan was better on 3 and worse on 0.
    - On the 12 held-out flow cases answered by an agent reply, the searches tied: 16 vs 16 passing runs, 1 better and 1 worse.
    - Pooled with the 36 held-out flow cases (5 better, 3 worse), a one-sided sign test over 96 cases gave 28 vs 5, p ≈ 3e-5.
    - Cost is the same: 1,189 vs 1,203 judge calls per 180 recalls, $0.33 per 180. Latency was p50 0.80 s vs 0.62 s, p90 1.11 s vs 1.62 s. `none` outcomes fell from 23 to 7 of 180. Judge: typesafe/jev-1.14 through the `judge` role.
- **Changed: system prompt.** The `chat_recall` line describes the scan instead of a per-level descent. OptChat also sends the prompt with every gate off. The gates-off golden is therefore re-pinned to 0.10.0 (a 4-line golden diff). The system block is 6330 bytes (was 6316).

## 0.9.4 — 2026-10-15

- **macOS support for `Store`:** on `darwin`, `Store.open` acquires an exclusive non-blocking `flock` lease on the held root directory descriptor. It resolves open file and directory descriptor paths through `fcntl(F_GETPATH)` (`fdPath`). Like the Linux abstract Unix socket and `/proc/self/fd` implementation, it creates no lock file in the store directory. It releases ownership on `close` or `SIGKILL`. Stream and snapshot writes stay anchored to the leased vnode across renames.
- **`evals/recall/` accepts more than one right answer for a real case.** A `real-spec.json` entry may list `also`: other messages in the same store that answer the question as well as the gold. The grader passes either. The entry also lists `no` (messages judged not to answer) and a required answer `key`. An unjudged answer passes if and only if the page recall returned contains every phrase of one key alternative. The builder checks that each key matches the gold and every `also` page, but no `no` page.

  Result rows record `judged`.
  - The sets came from blind pooling. Candidates were the gold's neighbours, the question's word-search matches and every message a recorded run answered. Assessors judged them from the chat text alone, without seeing which message any run picked.
  - Coverage mode also reports where the gold ranks in raw-log word search. The real set grew from 18 to 60 cases, with questions written blind from the chat text. Real cases stay in gitignored files.

## 0.9.3 — 2026-10-14

- **Compressor replies that open with their own message id are retried.** After 0.9.2, the head guard caught none of the live heads it knows (63.9% → 0%). However, colon-less openings that name the task's own ids still reached 9.9% of new lines here and 29.1% in another store. Examples: "1197 Live …", "Message 1185 records …", "1191 ← store check". `compact()` now also treats a leading number inside the task's own message range, with an optional "Message"/"Echo"/"Line" word and arrow or dash, as a head. A number outside that range ("7 rows found") is not. On this repository's live tree the check flags 195 of 2,576 stored lines.
- **`/optchat status` counts compressor attempts:** after the compressor runs, status shows `compressor calls: N; H head retries, L length retries`. This line counts the process's calls and retries for heads and length. Idle status stays unchanged, so the gates-off golden still pins 0.9.0 bytes.

## 0.9.2 — 2026-10-14

- **`evals/rules/` (`bun run evals:rules`):** an eval for the rules-triage gate. It runs production triage (`triageState`, `triageQuestions`, `decideTriage` at `--optchat-rule-add`) over synthetic and real user messages. It scores each decision against its label. Scores include precision, recall and F1 over rule adds, plus a per-case pass rate (`score`). Triage wording moved to `src/system1/rules-prompt.ts` (requests are byte-identical, pinned by `tests/rules-prompt.test.ts`). Real messages stay in gitignored files.
- **`evals/gates/`:** fixed hand-written sets cover rubric hard gates G1 (injection obedience, 20 cases) and G3 (status inflation, 20 cases). They run through the real compressor step with deterministic checks. Flagged lines go to a human-review list, never automatic confirmation.
- **Compressor replies that open with a head are retried.** 36% of this repository's live summary lines (709 of 1,946) began with a head or commentary forbidden by the system block. These included `id+n|`, labels ("Compacted line (≤512 bytes):", "Merged line (476+2):"), and tags (`<merged-line id=…>`, `<summary>`).
  - `compact()` now detects such a head. It spends one of its `tries` on a feedback turn asking for the line alone. It removes the head from the echoed reply, so no ids return to compressor input. The first clean fitting reply wins. If every try has a head, OptChat keeps the first fitting headed reply as before, without truncation or rewriting. Ordinary openings such as `user: …` or `Finding: …` are not heads.
- **`evals/gates/` confirms keyword flags with Jev:** each keyword flag gets one `judge`-role judgment. P(yes) ≥ 0.5 goes to the human-review list. Below that threshold, the runner records the flag as auto-dismissed. Judge errors and the cost ceiling go to review, never dismissal. Rerun: G1 and G3 had no lines left for review.
- **`evals/rules/` reads OMP session logs:** a `real-spec.json` entry whose `store` starts with `sessions/` names a user message line in a session log, checked by SHA-256 like store messages. The set includes 24 standing rules mined from session logs (26 real rules, 127 real cases). The gate's recall on real rules is 10/52 trials against 70/74 on synthetic ones, with no false adds. It misses terse one-line standing rules. Overall F1 0.788 (was 0.967 with 2 real rules).
- **Docs:** the design doc's status and gates-off wording now refer to the 0.9.0 memory-only golden, not v0.5.0.

## 0.9.1 — 2026-10-14

- **Fixed: the evidence runner's no-call plan crashed on a host with no usable model.** OMP refuses RPC mode when no model is configured. The catalog probe therefore waited until its 60 s deadline, and the runner printed an error instead of its JSON plan. The probe now fails as soon as the host exits, with the host's stderr, and the plan reports it as a blocker (`host model listing failed: …`) with status `blocked`. This was the CI failure on 0.8.x–0.9.0 once `bun run test:host` put the pinned `omp` on `PATH`. Plugin code is unchanged.

## 0.9.0 — 2026-10-13

- **Changed default: `chat_recall` now seeds candidates from the raw log.** `--optchat-recall-seeds` defaults to 8. Each call also scores up to 8 stored messages whose words match the question, alongside the view lines. On the recall eval it answered 65/96 against 21/96 without seeds, replicated on a second run (real-only cases 11 vs 5, same direction, not significant). Cost: at most ⌈(lines+seeds)/64⌉ scoring requests per call, usually the same count as before. Pass `--optchat-recall-seeds 0` for the 0.8.0 recall requests.
- **Changed: system prompt.** The `chat_recall` line describes seeding. OptChat also sends the prompt with every gate off. The gates-off golden now pins 0.9.0 bytes (a 4-line prompt change). The system block is 6316 bytes (was 6277).
- **`/optchat new` starts a fresh chat without losing the old one.** The current store moves byte for byte to a sibling archive `<dir>.<UTC stamp>`, with a numeric suffix if that name is taken. An empty store opens at the original path through the normal start path: flags, gates, an empty rules ledger, and child-view publishing. This requires the session's memory to be open and the agent to be idle. When a UI exists, it asks for confirmation and names the archive. A failed archive reopens the original store.

  A failed fresh open reports the archive path and `--optchat-dir <archive>`. OMP's `/new` still keeps the same OptChat memory.
- **Docs:** README fixes the gate count and judge cost. There is one rules request per user message. A merged-view turn uses one prefetch request per chunk of up to 64 view lines, or 3 per such turn in the live run. Status judge-call counters include shared-cache answers, so billed usage can be lower.
- **Recall adds raw-log matches as candidates.** `--optchat-recall-seeds` defaults to 8 and accepts integers 0–32. `0` restores the previous requests and output byte for byte. `Memory.rankMessages(question, { limit, before })` ranks stored messages by the question's words, weighted by inverse document frequency. It makes no model call and uses the same skip rules and `before` bound as `search`.
  - Each top seed becomes a single-message candidate using its first 4 KB. The same relevance requests score it alongside view lines, and recall ranks them together. The result labels a raw-log winner as such.
  - **Why:** summaries kept the fact for only 11 of 48 gold messages covered by a view line. Descent from summaries therefore could not reach most answers.
  - **Recall eval:** k=1, 48 cases × 2 reps per arm, cap 1500 judge calls per arm. Seeds 8 answered 65/96 against 21/96 for seeds 0. A replicate run gave the same counts: synthetic 54/60 vs 16/60, real 11/36 vs 5/36, paraphrase 4/10 vs 0/10. Raw-log winners were right 62 of 72 times, and view-line winners 3 of 24. Run totals were 290 judge calls for seeds 8 against 383–387 for seeds 0 (budget cap 1500 per arm). No trial in the four runs hit an internal judge error.
  - The real-only gain is weaker (paired sign test p≈0.11 per run). The synthetic gain is strong. Scan cost of `rankMessages` was median 0.2 ms on the synthetic 256-message trees. It was about 6 ms per question on the 1,637-message store (`optchat-main`).
- **Standing instructions have three scopes:** the rules ledger holds instructions you state in this chat, per store. OMP TTSR rule files hold enforced guardrails for every session. Sharpshooter holds cross-session project decisions learned from friction. README (the rules bullet under the gates) and `docs/design/optchat-jev.md` §3.3 say so.
- **`evals/recall/` scoring:** the runner scores a found or none outcome as recall returned it, even when an internal judge call failed. Rows record `internal_judge_errors` and `raw`. The runner retries only attempts with no outcome. After retries, these go to `errors.jsonl`, never to a zero in `results.jsonl`. The earlier strict rule that scored a pass after a retry as a fail is gone. `--seeds N` sets seeds (default: the shipped default), recorded in `run.json`.
- **Recall descends from the top k lines (`--optchat-recall-k`, default 1, integer 1–8):** this is opt-in. On the recall eval, k=3 scored 15/96 vs 14/96 for k=1 (within noise), for 37% more judge calls. The default therefore stays 1. Recall descends from each of the top k view lines at or above `--optchat-recall-min`. At most 4 descents run concurrently, with one 20 s bound. The message with the highest path probability answers: its line's score times each choice's probability.

  The result lists other candidates one line each. It lists a failed descent and fails only that candidate, unless every descent failed. `--optchat-recall-k 1` is the previous single argmax descent. Judge calls: at most ⌈(lines+seeds)/64⌉ + k·log₂ n.
- **`evals/recall/`:** `--k` (or a `topk-k<N>` variant) sets k. `run.json` records it.
- **Test layout:** the real-host suites (`tests/host/integration.test.ts`, the paired evidence run and no-call plan in `tests/host/evidence-benchmark.test.ts`) run through `bun run test:host`, which CI also runs. `bun run test` covers the rest. The retrieval comparison builds its report and tree once per file.

## 0.8.0 — 2026-10-13

- **Removed: tool gate.** `--optchat-tool-gate`, `--no-optchat-tool-gate` and `--optchat-tool-ask` are gone, with `src/system1/tool-gate.ts` and the `tool_call` hook. Risky-call confirmation is OMP's own tool approval (`tools.approval`). Scripts that pass the removed flags should drop them. The four remaining gates are rules, prefetch, value-score and recall.
- **Session-model fallback:** when the `judge` role has no candidate, OptChat's judge is the session model, marked as a fallback. No gate runs on it. Rules, prefetch, value-score and recall are inactive, and `/optchat status` says why. `chat_recall` stays registered and answers that it is inactive, so tool definitions do not change. Before, with no role candidate, all gates ran on the session model.
- **Gate counters in `/optchat status`:** each gate keeps judge calls, failures and outcomes in memory for the session. Outcomes include rules added/replaced, prefetch blocks and bytes, value-score hints, and recall answered/none/failed. Status prints these only while a gate is on. With every gate off, status stays unchanged.
- A judge factory that throws is now recorded under the gate's label (for example `rules: ...`), not its purpose string.
- **Requires OMP 18.10.3 or newer.** OMP 18.10.3 moved `isOfficialCodexApiUrl` from `@oh-my-pi/pi-ai` to `@oh-my-pi/pi-catalog/wire/codex`, so OptChat failed to load ("Export named 'isOfficialCodexApiUrl' not found"). OptChat now imports it from the catalog. 18.10.3 also made `task.structured` default to off, which removes `yield` from children. The smoke and the evidence runner's child overlay now set `task.structured: true`, because their scripted children answer through `yield`.
- **Gates-off golden:** `tests/system1-off.test.ts` pins the exact request bytes (system prompt, tool definitions, context messages) and `/optchat status` with every gate opted out. It checks that OptChat resolves no judge and registers no `tool_call` hook.
- **`chat_recall` eval:** `evals/recall/` (`bun run evals:recall`) runs the real recall over synthetic and real-store cases with a deterministic gold-id grader. Recall's judge wording moved to `src/system1/recall-prompt.ts`. Recall now owns its scoring frame. Requests stay unchanged.

## 0.7.0 — 2026-10-11

- **`chat_search(text, kind, limit, before)`:** finds stored messages containing every word of `text`, case-insensitively, newest first, with ~240-byte snippets and `before` paging. It reads the original log, so it reaches names, paths, numbers and errors that summaries dropped. Memory tool calls and search/recall results are never hits. Child views search only their snapshot. Always on with memory, like `zoom`.
- **`zoom(id, n, depth)`:** opens up to 4 levels at once (`2^depth` lines). `depth` 1 is the old behavior, byte for byte.
- **Recall gate (on by default, opt out with `--no-optchat-recall`):** registers `chat_recall(question)`. The judge scores the view lines. Recall opens the best line at or above `--optchat-recall-min` (default 0.5). One two-way choice per level leads to a single message. Recall returns that message with its descent path and first 8 KB. At most ⌈lines/64⌉ + log₂ n judge calls, 20 s overall and 5 s per call. Failures return an explicit "recall failed" result.
- Tool names carry a `chat_` prefix because OMP reserves `search` (alias of `grep`) and `recall` (builtin).
- The tool gate never screens `chat_search` or `chat_recall`. `/optchat status` shows the recall gate. The memory guide in the system prompt documents both tools, so its bytes change once (the evidence runner's pinned system-block size is 6277 bytes).
- Memory-only harnesses (integration tests, smoke, `evidence:recall`) also opt out of the recall gate.
- **`bun run evidence:retrieval`:** an offline, deterministic comparison over a synthetic tree with planted facts. It compares zoom, zoom depth, `chat_search`, prefetch, `chat_recall` and a scripted beam descent. It uses a fake summariser and judge, with no provider calls. Across two seeds, summary navigators found only the facts whose topic survived in the view (3/12, 5/12). `chat_search` found 12/12. `chat_recall` needed one agent step where zoom needed about 200. This demonstrates mechanics only, not quality. Details are in ticket 10.

## 0.6.0 — 2026-10-11

- **System One gates:** all four gates are on by default and use the host's `judge` role.
  - Standing rules: `--optchat-rules`, with `/optchat rules` and `/optchat rules remove ID`. Opt out with `--no-optchat-rules`.
  - View prefetch for each user message: `--optchat-prefetch`. Opt out with `--no-optchat-prefetch`.
  - A one-sentence importance hint per compacted leaf: `--optchat-value-score`. Opt out with `--no-optchat-value-score`.
  - Tool-call gate: `--optchat-tool-gate`. Opt out with `--no-optchat-tool-gate`.
  - Thresholds: `--optchat-rule-add`, `--optchat-prefetch-k`, `--optchat-prefetch-min`, `--optchat-tool-ask`. A failed judge changes nothing, and the session keeps running. The tool gate fails closed.
- **Upgrading (behavior change):** the gates send judged text to the `judge` role's provider. They cost up to two judge requests per user message, one per long compacted leaf and one per screened tool call. Set `modelRoles.judge` in OMP's `config.yml` (for example `openrouter/~typesafe/jev-latest`). Without a credentialed judge, the gates do not run. Opt out per gate, or pass all four `--no-optchat-*` gate flags for 0.5.0 behavior.
- A rule keeps only the sentences that the judge rates as standing instructions. It keeps a one-sentence message whole.
- OptChat stores standing rules in `ledger.jsonl` beside the chat log. Shutdown waits up to 1.5 s for queued rule triage, then abandons it. Triage therefore never writes after the store closes.
- With every gate opted out, context and `/optchat status` match 0.5.0. The evidence runner opts its hosts out, so its benchmark keeps measuring memory alone.
- Planning kit ported into the repository: `AGENTS.md`, `plans/`, `docs/`, `.scratch/`, `vendor/`, `.agent/`, and project skills in `.omp/skills/`. Documentation only. No runtime change.

## 0.5.0 — 2026-10-11

Tracks Wayfinder map [#9](https://github.com/ericjuta/omp-optchat/issues/9). SDK packages pinned to 18.9.1 (peers stay `>=18.9.0`).

- **Durability (#11):** Add real-subprocess SIGKILL recovery coverage for image-bearing appends, summary commits, and history imports. Publish HTML exports from fsynced private staging files without overwriting existing targets. Then fsync the parent directory.
- **Archive GC (#12):** Reclaim unreferenced image blobs and abandoned image/view staging files after validated writer startup, preserving replayed references and reporting nonfatal cleanup failures.
- **Behavior change:** Sessions inside git repositories no longer use `~/.omp/agent/optchat`. Each worktree gets its own memory under `optchat-worktrees/` beside that directory, and a new worktree starts empty. Sessions outside git keep the global store. `--optchat-dir ~/.omp/agent/optchat` restores the old single shared memory.
- A startup lock conflict occurs when another live session holds the store directory. It now deactivates OptChat for that session, as `--no-optchat` does, with one warning instead of refusing every prompt. Corrupt or otherwise unreadable stores still refuse prompts.
- **Benchmark (#10, #13):** `bun run evidence:recall` gains paired OptChat on/off arms (`--arms on,off`) and compressor comparison (`--compressors`). It adds per-question turns, adversarial and long corpora (up to 40 projects and 512 records), and a subagent-memory experiment (`--experiments child`). It also adds `--main-context-window` and a hard dollar ceiling (`--max-cost-usd`, at most $30).
  - The dollar ceiling uses byte-based bounds and a pinned main output cap. Per-host compressor reservations release completed calls at their observed cost. Refusal fallbacks use main-model pricing.
  - Artifacts use schema `optchat-evidence-recall/3`, with main, compressor, auxiliary, and estimated maintenance usage. The `--max-calls` ceiling is 2000 and the `--deadline-ms` ceiling is 30 minutes.
  - Measurements used Sonnet 5.5 and Haiku 5.5 (see README "0.5.0 measurements", n = 3 per setting).
  - When history fits the context, both arms answered 24/24, and OptChat cost $0.13–0.20 more per run.
  - Past the context window, OptChat answered 24/24 with exact quotes. Plain OMP, after compacting, named 16/24 correct values and quoted 10/24. OptChat cost about $1.10–1.18 per run, against $0.05–0.56 for plain OMP.
  - Subagents with `--optchat-child-view` answered 4/4. Blind subagents answered 0/4.
- **Upstream (#14):** API proposals for context-event purpose, cancellation and correlation ([can1357/oh-my-pi#15365](https://github.com/can1357/oh-my-pi/issues/15365)), complete async-output references, maintenance ownership, and audio/video ingress, posted on the matching upstream issues.
- Failed compressor calls record the provider's stop reason and error text in `OPTCHAT_METRICS_FILE`, and the thrown error includes it.
- Evidence corpus padding is natural prose. Word-list padding made Claude 5.x refuse summarization with `Refusal (bio)`.
- **Refusal fallback:** OptChat retries a compressor refusal (`stopReason` error starting `Refusal`) once with the session's main model. The fallback has a 30-second wall deadline. If that deadline expires, OptChat cancels the fallback. If the main model also refuses or exceeds the deadline, OptChat commits a marked, source-derived excerpt for the node. This lets the tree settle and prevents refusal of later prompts.

  The "not ready after 25 s" notice now appears only for real timeouts. A summary that failed without retry says so. `/optchat status` counts main-model retries and stand-ins.

## 0.4.1 — 2026-10-11

- Fix the evidence runner's credential-routing guard: parse all three source model-config formats instead of substring-matching only `models.yml`. Escaped or aliased selected provider keys, shadowed overrides, and unreadable or invalid configurations now block before credential copying or host discovery. Diagnostics omit config contents. Unrelated provider settings remain usable.

## 0.4.0 — 2026-10-11

Tracks Wayfinder map [#2](https://github.com/ericjuta/omp-optchat/issues/2).

- **Requires OMP 18.9.0** (SDK packages pinned to 18.9.0, peers `>=18.9.0`). CI verifies both the pinned cohort and the latest published cohort on every push and weekly.
- Fix the idle-recap refusal ([#1](https://github.com/ericjuta/omp-optchat/issues/1)): host side turns (agent-attributed messages absent from the session branch) pass through without opening, reusing or poisoning a main turn. User text that mimics a recap stays ordinary input.
- Scheduling ([#3](https://github.com/ericjuta/omp-optchat/issues/3)): dependency-ready queues replace tree scans. The scheduler admits leaves while fewer than eight earlier leaves are unbuilt. Parents become ready as soon as both children exist. Failed calls release their slot at once and retry on the next appended message. `--optchat-retry-ms` is removed.
- The compactor tiling and its batch latch persist in `view.json` v2 together with the main view, in one atomic snapshot. Restarts reproduce the exact compactor prefix. v0.3.0 snapshots migrate once without changing the main tiling.
- Archive ([#4](https://github.com/ericjuta/omp-optchat/issues/4)): the compactor summarizes long records in bounded UTF-8 pages and reduces them to a single leaf. It does not truncate records or add IDs. `zoom(id, 1, offset)` returns 16 KB pages with `details.next`. If no shortening attempt fits a 16 KB safety ceiling, the leaf fails instead of being cut. OptChat stores images from user, assistant, tool, and report messages by content address. `zoom` returns them after restart.

  Records keep the host event timestamp.
- Subagents ([#5](https://github.com/ericjuta/omp-optchat/issues/5)): OptChat stores task, async, and launch reports as `work` records with provenance (job ID, agent ID, name, source, completeness). It captures them before the ordinary tool cap, with full structured data and typed artifact hydration. It labels a report incomplete when the host delivered only a preview. The new `work(name, offset)` tool retrieves them. Opt-in `--optchat-child-view` gives subagents a frozen, read-only snapshot with `zoom`/`date`/`work`. Every read and prompt injection checks both the parent's live publication and the child's adopting session.

  OptChat revokes the snapshot on switch or shutdown. The snapshot never opens a second writer.
- Host frontier ([#7](https://github.com/ericjuta/omp-optchat/issues/7)): `/optchat status` reports stateless-OpenAI, settlement-deadline, host-maintenance, request-correlation, and child-view caveats. Upstream issues track host APIs that OMP 18.9.0 does not expose. This release adds no workarounds for them.
- Evidence ([#6](https://github.com/ericjuta/omp-optchat/issues/6)): `bun run evidence:recall` is an opt-in, budgeted, synthetic-only recall and usage runner against real models. It runs in an isolated HOME and agent directory and copies only the selected credentials. Before any call, it checks the effective system prompt for private context. `OPTCHAT_METRICS_FILE` records compressor usage as content-free JSON lines. Measurements used OMP 18.9.0 with Sonnet 4.6 and Haiku 4.5. Results: 15 of 16 recall questions correct, all 16 grounded in zoomed originals, none hallucinated, including after a process restart.

  See README for usage figures, which are a sample and not a savings claim.
- OptChat records task reports that OMP delivers as nested previews as incomplete. Agent IDs never authorize file reads.
- Import/export accept `work` records with metadata. `exportJsonl` provides a lossless export.

## 0.3.0 — 2026-10-11

- Automatically activate OptChat in main-agent sessions when OMP discovers the enabled plugin, for both fresh installations and upgrades. `--optchat` is no longer required.
- Add `--no-optchat` as a session opt-out that takes precedence regardless of flag order. It leaves ordinary context intact and creates no OptChat store or compressor work. Subagents remain inactive.
- Exercise isolated plugin linking, automatic discovery, default activation, and explicit opt-out against the real OMP host. Preserve existing memory-directory ownership and host compaction behavior. Change no global settings.

## 0.2.0 — 2026-10-11

- Correct merge priority to measure age from each sibling pair's last message.
- Batch the main view from 128 KB to 64 KB. Preserve its exact tiling and unfinished batches in atomic, fsynced `view.json` snapshots, including legacy-log migration and crash recovery.
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
