# Evidence layer: multi-passage recall, atomic rules, Clairic go/no-go

This ExecPlan is a living document. The sections `Progress`, `Surprises & Discoveries`, `Decision Log`, and `Outcomes & Retrospective` must be kept up to date as work proceeds. It is maintained in accordance with `.agent/PLANS.md` at the repository root.

## Purpose / Big Picture

OptChat (this repository, an OMP plugin) keeps one endless chat. Every message is stored in an append-only log, compressed into a binary tree of one-line summaries, and navigable with memory tools (`zoom`, `chat_search`, `chat_recall`, `date`, `work`). Today, when the agent asks "what did we decide about X, and why?", `chat_recall` returns exactly one message: the first 8,000 bytes of whichever message a relevance judge picks. Answers spread over several messages (proposal, objection, final decision), or buried late in a long report, need repeated manual navigation.

After this plan, the agent can call `chat_evidence(question)` and get several exact passages, each with its message id, source kind, byte location and completeness. It also gets an honest account of what was searched and what was not found. Standing rules stop sharing one identity when a user states several instructions at once, so withdrawing one never retires another. Finally, a pre-registered, paid-but-capped experiment decides whether Cloudflare's Clairic extraction model, reached through an OMP host role, adds anything over plain deterministic chunk retrieval. If it does not, it is not adopted.

You can see it working by running the new evidence eval (Milestone 4) and by calling `chat_evidence` in a real OMP session with the plugin installed (Milestone 2 acceptance).

## Progress

- [x] (2026-11-06) Saved the source review to `docs/references/chatgpt-repository-feature-review.md` and fact-checked it in `docs/research/clairic-evidence-layer.md`.
- [x] (2026-11-06) Charted the Wayfinder map: GitHub issue #18, with tickets #19 (host extraction role, research), #20 (`chat_evidence` contract, grilling), #21 (atomic rules, grilling) and #22 (eval pre-registration, task; blocked by #19 and #20).
- [x] (2026-11-06) Milestone 0: housekeeping. README install pin now `#v0.14.0`; CHANGELOG 0.14.0 proof boundary and `plans/optchat-jev.md` (decision line 93 annotated, new revision note) record the six host regressions as repaired source-only (461/0, two-process smoke passed).
- [x] (2026-11-06) #20 resolved by Eric: `chat_evidence` is a new tool beside `chat_recall`, at most 8 passages of at most 2,048 bytes, 16,384 bytes in total, a 10 s limit, and a trailer on every result.
- [x] (2026-11-06) #21 resolved by Eric: split rules per whole sentence now, under a pre-registered rules eval; withdraw and replace targets are the newest 16 rules plus the 16 most relevant.
- [x] (2026-11-06) #19 amended by Eric: the host `extract` role reaches Clairic through OpenRouter first, with Workers AI as an optional second runner.
- [x] (2026-11-07) Milestone 1 code: atomic standing rules. `decideTriage` returns one change per kept sentence; targets are newest 16 plus 16 most relevant (`offeredRules`). Fail-before test `tests/atomic-rules.test.ts` 0/1 on old code, focused rule suites 130/0 after. Zero-cost preflight: candidate oracle 51/51, baseline (c3efa48) 49/51 (misses the two old-rule replacements).
- [x] (2026-11-07) Milestone 1 eval: Eric approved manifest SHA-256 `d36cb3c1fd3d75a01bae478c2ab1cd6d1607fdac6c52b7de93d6cb30112c11c5`; all bound hashes matched (candidate 5ab64f3, baseline c3efa48). B: 153 rows, 0 errors, F1 0.985, score 0.941, $0.0230. C: 153 rows, 0 errors, F1 0.985, score 0.980, $0.0234. Total $0.0464 of $0.50. Both arms served `cloudflare/clef` on every row, no unknown cost. False positives identical (only `atomic-multi-none-06`, 3/3 in both); C newly passes the two supersede-old cases. ADOPTED by the pre-registered rule. Surprise: the manifest named the judge role as `~typesafe/jev-latest`, but the host `judge` role served `cloudflare/clef`; the same-model condition holds, so the result stands, but it is a Clef result.
- [x] (2026-11-07) Milestone 2: deterministic `chat_evidence` (`src/system1/evidence.ts`, `tests/chat-evidence.test.ts` 14/0).
- [x] (2026-11-07) Live acceptance (isolated temp git dir, temp store and sessions, real installed omp 18.17.0, `--no-extensions -e src/index.ts`). First run FAILED: in a 3-message chat, `chat_evidence` searched only the current question. Cause: `rankMessages`' BM25 weight max(0, ln((N−df+0.5)/(df+0.5))) is 0 for every word in 2 of 3 messages, so the report scored 0 and was dropped. Fix: `RankOptions.idf: "smoothed"` (ln(1+…), always positive) for evidence only; `chat_recall` keeps "bm25" because its adopted v4 scan was measured on it. Regression test fails before (0/1), passes after (15/0). Rerun passed: message 0 bytes 15360–17408 held the command, `zoom(0, 1, 15360)` began with the same bytes, trailer `[searched messages: 0, 2]`. Rules: "Use British English spelling from now on. Always ask before deploying anything." wrote ledger r1 and r2 as separate rules.
- [x] (2026-11-06) #19 resolved: no host up to v18.17.0 has extraction. The design is in `docs/research/host-extraction-role.md`.
- [x] (2026-11-07) Milestone 3: plugin-side extraction (Eric: "I want plugin only"; AGENTS.md amended, option 1). `src/system1/extract.ts`: `openRouterExtractor` posts one `text` field to `POST /api/alpha/extractions` (`cloudflare/clairic`, `return_state_text`), key from the host's `openrouter` credential at call time (`ModelRegistry.getApiKeyForProvider`; the plugin reads no environment variable itself, though the host's own resolver order applies), 10 s bound, response ≤256 KiB, errors reduced to a status line. `chat_evidence` under `--optchat-extract` sends its passages (each under a `[message N, kind]` header) and appends one line after the trailer: a span is shown only when `p_null` is below `--optchat-extract-null` (0.5) and it maps, via the echoed state text, inside one passage to exact message bytes; otherwise "do not settle it" or "no verifiable span". No key, HTTP error or timeout leaves the deterministic passages unchanged. Tests: `tests/extract.test.ts` 9/0 (emoji/accents, repeated text, header/cross-passage spans, echo mismatch, threshold, unknown cost, key only in the header, cancel), evidence integration 16/0. The host-role design below is superseded.
- [x] (2026-11-07) Milestone 4: Eric approved manifest `evals/evidence/prereg/evidence-20261107.json`, SHA-256 `3bd58077d128c6cabb65467d752ca96f7c9f0ee087304a954bd81128988df7ef`; all bound hashes matched. Oracle preflight: C 1.0/1.0, 0 errors. Live (40 synthetic cases × 2): 0 errors, spend A $0.0306, C reported $0 on every row (provider Cloudflare). A (judge served `cloudflare/clef`): grounded 0.667, abstain 0.313, misleading 0.275, p90 545 ms. B: grounded 1.0, abstain 1.0, misleading 0. C: grounded 1.0, abstain 1.0, misleading 0, p90 240 ms. Span probe: echo equals state 80/80; span text equals value 48/48 value-bearing answers; all 16 emoji/accent rows mapped to exact bytes, so spans are code points live.
- [x] (2026-11-07) Milestone 5: NOT adopted as default. The span criterion as written ("span text equals value in ≥0.95 of span-bearing answers") counts 48/80 = 0.60, because the 32 correct abstentions also carried spans with a null value; the rule did not say how null values count. Eric delegated the call; the agent applied the rule literally, since flipping a pre-registered result by a post-hoc reading is what pre-registration forbids, and default-on would send chat passages to a third party for every user with an OpenRouter key. `--optchat-extract` ships as an opt-in flag. A new run needs a manifest that defines the null-value case.
- [x] (2026-11-07) Milestone 5, second run. Eric delegated the call ("CTO delegation", up to $50). The agent pre-registered `evals/evidence/prereg/evidence-20261108.json` (SHA-256 `a4b82ffbbd7d3fc91b0549ac2250ce706a7cf0bee7c55da52c16275e83c187ad`) on fresh cases (seed 20261108). It counts span equality over non-null values only and adds abstainSuccess ≥ 0.80; the first run is not re-scored. Oracle 1.0/1.0. Live: 0 errors; C grounded 1.0, abstain 1.0, misleading 0, echo 80/80, span equals value 48/48, cost reported $0 on every row, p90 275 ms; B grounded 1.0; A grounded 0.667, abstain 0.125, misleading 0.35 (served `cloudflare/clef`), $0.0306. ADOPTED: `DEFAULTS.extract` true, `--no-optchat-extract` opt-out, and no key adds nothing. Harnesses opt out explicitly (smoke, host integration, evidence host, ALL_GATES_OFF). Live isolated OMP 18.17.0 with the real key: `"eu-west-3-41" at message 0 bytes 75-87`, and those bytes are exact after "🚀 café".

## Surprises & Discoveries

- Observation: the review is right that rule triage joins several standing sentences into one rule.
  Evidence: `src/system1/rules.ts:150-168` builds one add or replace decision from `kept.join(" ")`. Source-read on 2026-11-06.
- Observation: the host already reaches Cloudflare Workers AI, but only for finite judgments.
  Evidence: `node_modules/@oh-my-pi/pi-ai/src/judgment/native.ts:49` (`workers-ai-systemone`). The question types are predicate, choice and score (`openai-decisions.ts:26-29`). No extraction API exists in host 18.10.3.
- Observation: Clairic returns spans as character offsets, while OptChat measures sizes in UTF-8 bytes.
  Evidence: the Cloudflare model page, summarised in `docs/research/clairic-evidence-layer.md`.
- Observation: OpenRouter serves Clairic as `cloudflare/clairic` on the alpha route `POST /api/alpha/extractions` (not the chat endpoint), and documents spans as half-open `[start, end)` Unicode code-point offsets. `return_state_text` returns the text the offsets index into. The listing showed 96.09% availability over 3 days and 50.56% over the last 24 hours on 2026-11-06.
  Evidence: https://openrouter.ai/docs/guides/community/extractions and https://openrouter.ai/cloudflare/clairic, read 2026-11-06. Not yet confirmed by a live call.

## Decision Log

- Decision: `chat_evidence` is not a System One gate. It never resolves a judge, so with all four gates opted out it stays registered and OptChat still resolves no judge; only `--no-optchat-evidence` removes it.
  Rationale: the "every gate opted out" rule exists to keep Jev out of memory-only runs; a deterministic tool does not touch Jev.
  Date/Author: 2026-11-07, agent.
- Decision: per-sentence rules keep the whole-message `rule` and `withdraw` questions as gates; a withdrawing message adds nothing, and each sentence removes or replaces only its own target, each rule at most once per message.
  Rationale: preserves "withdrawal beats addition" and keeps single-sentence requests byte-identical to v0.14.0.
  Date/Author: 2026-11-07, agent.

- Decision: Clairic is reached only through a host-owned extraction role, never through an HTTP client or API key inside the plugin.
  Rationale: the AGENTS.md OMP rules (Jev only through the host `judge` role; no provider client, SDK or key variable in the plugin) apply equally to a new model.
  Date/Author: 2026-11-06, agent (Eric delegated "wayfinder and exec plans it out").
- Decision: deterministic chunk retrieval ships first and is the comparison arm. Clairic must beat it, not just the current `chat_recall`.
  Rationale: we must give credit where it is earned. If a retrieval gain comes from better chunking, that gain must not be attributed to the extractor.
  Date/Author: 2026-11-06, agent.
- Decision: split standing rules per sentence now, without Clairic, keeping each whole sentence (conditions and exceptions included) as the rule text. Ship only after a pre-registered rules eval on a fresh case set passes.
  Rationale: it fixes a structural defect with no new model. Whole sentences keep "unless..." clauses attached. The eval guards rule-add accuracy, which per-sentence decisions can change.
  Date/Author: 2026-11-06, Eric (#21).
- Decision: withdraw and replace decisions consider the newest 16 active rules plus the 16 most relevant (word overlap with the sentence), deduplicated, at most 32 targets. This replaces the newest-32 cap.
  Rationale: old rules stay reachable for withdrawal without dropping recency, and the judge input stays bounded.
  Date/Author: 2026-11-06, Eric (#21).
- Decision: `chat_evidence` is a new tool, and `chat_recall` stays unchanged. It sits behind `--optchat-evidence` (default on) with `--no-optchat-evidence` winning. Limits: at most 8 passages, at most 2,048 bytes each, at most 16,384 bytes in total, 10 s per call. Every result carries a trailer listing searched message ids, terms not found, and incomplete or partial reports, even when passages were found. It works with no extractor.
  Rationale: keeping `chat_recall` gives the eval an unchanged arm A. Always reporting what was searched means a partial answer cannot hide its gaps.
  Date/Author: 2026-11-06, Eric (#20).
- Decision: the host `extract` role uses OpenRouter's Extractions API first (`openrouter-extractions` runner, model `cloudflare/clairic`, the OpenRouter credential from OMP's store), with a Workers AI runner (`workers-ai-clairic`) as an option. Both runners return the same span unit: half-open code-point offsets validated against the returned state text.
  Rationale: Eric will use Clairic through OpenRouter. OpenRouter documents the offset unit; Workers AI does not. A second runner keeps the role off a single alpha route.
  Date/Author: 2026-11-06, Eric (#19 amendment).
- Decision: the three-arm evidence eval is capped at $5, covering the live offset probe and every arm. Paid calls still wait for Eric's approval of the manifest SHA-256.
  Rationale: Eric set the cap (#22). It leaves room for repeated runs and a fresh confirmation set.
  Date/Author: 2026-11-06, Eric (#22).
- Decision: the decision-history, index, explain, child-pack and cross-worktree ideas stay as map fog, not milestones.
  Rationale: each depends on the evidence record shape chosen in #20.
  Date/Author: 2026-11-06, agent.

- Decision: the host extraction role goes upstream on oh-my-pi v18.17.0, not as a source-only patch. The plugin uses the extractor only after a feature check (dynamic import of `@oh-my-pi/pi-coding-agent/extraction`) and falls back to deterministic retrieval when it is absent.
  Rationale: the installed compiled host serves plugin imports from its own bundled packages, so a source-only patch never runs, and the 18.12.6 checkout is five minors behind (#19 findings).
  Date/Author: 2026-11-06, agent, from ticket #19.

## Outcomes & Retrospective

None yet.

## Context and Orientation

Key files, all paths from the repository root:

`src/memory.ts` holds the store, the summary tree and raw-log search (`rankMessages`, `search`, `zoom`). `src/index.ts` registers tools and runs each turn. Ordinary turns wait up to a settlement deadline for summaries (`beforeAgentStart`, around lines 1343-1654). `src/system1/recall.ts` implements `chat_recall`. It seeds candidates from raw-log word search (each cut to 4,000 bytes), has the judge score view lines and leaves, and returns one winner's first 8,000 bytes (`RECALL_PAGE_BYTES`, lines 11-13; selection at 209-243). `src/system1/rules.ts` implements rule triage: a judge scores each user sentence, and sentences at or above `--optchat-rule-add` (0.8) are kept. `src/system1/judge.ts` wraps the host judge (`resolveJudge`). `evals/recall/` holds the recall cases and grader (`grade.ts`); `evals/rules/` holds the rules-triage eval.

Terms. A *standing rule* is a user instruction that applies to future turns ("always answer in British English"). Rules are kept in an append-only `ledger.jsonl` per store. A *passage* is a byte range inside one stored message. An *extractor* is a model that, given text and named fields, returns values and the exact character spans they came from. *Clairic* is Cloudflare's extraction model (`@cf/cloudflare/clairic`, preview, 65,536-token context, 8,192-token passes, $0.10 per million input tokens, no output charge). Its text answers are `{value, guess, p_null, confidence, span:[start,end]}`, where `value` is null when the input does not settle the answer. A *host role* is a model slot the OMP host resolves (like `judge` or `smol`); the plugin asks the host and never holds credentials.

Rules that bind this work (from AGENTS.md): stores and ledgers are append-only, and tests use temporary directories. Sizes are bytes. The system prompt and tool definitions stay byte-identical across calls. Any model output acts only through a code-owned threshold. Unknown cost is recorded as `unknown`. Eval runs state a budget, and the scorer, heldout data and gate thresholds are never edited without Eric. Each new gate-like behaviour gets an opt-out flag and is on by default (project preference), with the opt-out winning.

## Plan of Work

Milestone 0. In `README.md` line 36, change the install pin `#v0.7.0` to the current tag. In `CHANGELOG.md` line 11 (the 0.14.0 "Proof boundary") and `plans/optchat-jev.md` lines 93 and 702, replace "remain pending" or "still require repair" with the recorded result: the six host regressions were repaired, the focused host suite passed 461/0, and the two-process smoke passed. These match plan lines 22 and 292. This milestone has no code change.

Milestone 1 (atomic rules). In `src/system1/rules.ts`, change `decideTriage` so each kept sentence yields its own decision, in source order, instead of one joined text. The ledger apply path in `src/index.ts` must apply a list of decisions; each add gets its own rule id. Replacement and withdrawal targeting stay per sentence. Replace the newest-32 cap (`SUPERSEDE_RULE_LIMIT`, `rules.ts:9`): rank active rules by `rankMessages`-style word overlap with the sentence, take the 16 most relevant, merge them with the newest 16 (deduplicated, at most 32), and update `README.md:224`. First write a failing test in `tests/` showing that "Use British English. Always ask before deploying." produces two rule ids, and that withdrawing one leaves the other active. Before shipping, pre-register a rules eval on fresh cases that include multi-instruction messages and "unless…" exceptions (`evals/rules/`, stated budget ≤ $0.50, adoption rule: F1 not worse than the 0.8 baseline beyond noise and no new false positives), get Eric's SHA approval, then run it and record F1 and false positives.

Milestone 2 (deterministic `chat_evidence`). Add `src/system1/evidence.ts` with a pure function that takes a question, the memory, a snapshot upper bound and limits. It reuses `rankMessages` seeds and the `chat_recall` scan to pick up to N candidate messages. It splits each into byte-aligned chunks (default 2,048 bytes, never splitting a UTF-8 sequence), ranks the chunks by word overlap, and returns up to `maxPassages` (8) passages within `maxBytes` (16,384) in total, stopping at `timeoutMs` (10,000) with what it has, marked incomplete. Each passage carries `{id, kind, start, end, text, complete}`. Every result, including a full one, ends with a trailer listing searched message ids, not-found terms, and incomplete or partial reports. Register the tool in `src/index.ts` beside `chat_recall`, behind a new gate `--optchat-evidence` (default on) with opt-out `--no-optchat-evidence`, and respect the child-view upper bound (`src/index.ts:849-901`). Update the `system1-off` golden test only for the new tool's deliberate appearance.

Milestone 3 (host extraction role). Follow `docs/research/host-extraction-role.md`. The host side, proposed upstream on oh-my-pi v18.17.0, adds four things. The first is a model kind `extract` with runner API `openrouter-extractions` (`POST /api/alpha/extractions`, model `cloudflare/clairic`, `provider.options.cloudflare.return_state_text: true`) and an optional runner `workers-ai-clairic` (`@cf/cloudflare/clairic`), with catalog seeds for both (input $0.10/M, context 65,536). The second is a built-in `extract` role that accepts only native extractors. The third is `NativeExtractor` in `pi-ai/src/extraction`, which reuses the host's existing OpenRouter credential and retry code for the OpenRouter runner, and the Workers AI credentials and auth for the optional runner. The fourth is `resolveExtractor()`, exported from `@oh-my-pi/pi-coding-agent/extraction`, which reports usage with role `extract` and `costSource` reported, catalog or unknown. The host returns half-open code-point spans, validated against the returned state text, and nulls spans that overlap redactions; the Workers AI runner must normalize to the same unit or report its spans as unavailable. Tests inject a fake through `OptChatOptions.extractor`. In the plugin, `src/system1/extract.ts` maps code-point spans to UTF-8 bytes with the same `utf8Width` walk as `readTextPage` and checks that each span's bytes equal the stored text. Adapt the 18 offset test cases in the research doc to code points. One paid live OpenRouter call with an astral character must confirm the documented code-point unit before any adoption; it goes inside the Milestone 4 budget. The plugin validator rejects any answer with `value === null`, a failed span check, or confidence below a code-owned `--optchat-evidence-min`. `chat_evidence` uses the extractor only when it resolves; otherwise it stays deterministic.

Milestone 4 (eval). Per #22, add `evals/evidence/` with frozen cases. They must include absent, ambiguous and incomplete-source labels, where the correct behaviour is to abstain. Arms: A = current `chat_recall`, B = deterministic `chat_evidence`, C = B plus the Clairic extractor, all on the same frozen snapshots. Pre-register the budget, the metrics (grounded answer success, misleading-extraction rate, omissions, latency, cost per success) and the adoption rule in a manifest with a SHA-256, and get Eric's approval of that SHA before any paid call. The cap is $5 (Eric, #22), covering the live offset probe and all arms.

Milestone 5. Adopt C only if the pre-registered rule passes. Otherwise keep B and record the rejection. Release with the usual gates.

## Concrete Steps

From the repository root:

    bun run typecheck
    bun run test
    bun run test:host
    OPTCHAT_SMOKE_OMP=/home/ericjuta/.bun/bin/omp bun run smoke

Expected: typecheck clean, and all unit and host tests pass (v0.14.0 baseline: unit 2,326/0, host 56/0, smoke `ok`). For Milestone 1, the new rule test fails before the change and passes after.

## Validation and Acceptance

Milestone 1: in a real OMP session, typing "Use British English. Always ask before deploying." then `/optchat status` shows two active rules. Withdrawing the first leaves the second active.

Milestone 2: in a real session with a long earlier report, `chat_evidence("what exact command did the migration job run")` returns a passage from deep inside the report, with byte offsets that `zoom(id, 1, offset)` reopens to the same text.

Milestone 4: the eval run prints per-arm scores and its spend, which stays at or under the approved cap.

## Idempotence and Recovery

Every milestone is additive and gated. `--no-optchat-evidence` restores v0.14.0 behaviour. Never rewrite ledger or store files. Rule-splitting applies only to new triage decisions; existing joined rules stay as they are.

## Artifacts and Notes

Source review: `docs/references/chatgpt-repository-feature-review.md`. Fact check: `docs/research/clairic-evidence-layer.md`. Map: https://github.com/ericjuta/omp-optchat/issues/18.

## Interfaces and Dependencies

In `src/system1/evidence.ts`:

    export interface EvidencePassage { id: number; kind: Kind; start: number; end: number; text: string; complete: boolean }
    export interface EvidenceResult { passages: EvidencePassage[]; searched: number[]; missing: string[]; incomplete: number[] }
    export function gatherEvidence(memory: Memory, question: string, limits: { upperBound: number; maxPassages: number; maxBytes: number; timeoutMs: number }, extractor?: Extractor): Promise<EvidenceResult>

In `src/system1/extract.ts`, the `Extractor` interface mirrors whatever host type #19 defines. No Cloudflare SDK and no API-key variable may appear in this repository.

Revision note (2026-11-06): first version, written from the ChatGPT review and its fact check.
Revision note (2026-11-06): folded #19. The host role goes upstream (not source-only), spans are UTF-16 mapped to bytes, and the offset unit is still to be confirmed live.
Revision note (2026-11-07): Milestone 0 done; Milestone 1 code and pre-registration done (eval awaits SHA approval); Milestone 2 done. `chat_evidence` widens the interface (adapter instead of `Memory`, `totalBytes`, `terms`, `complete`, `unsearched`) and is also offered to child views.
Revision note (2026-11-06): folded Eric's answers to #20, #21, #22 and a #19 amendment. `chat_evidence` is a new tool (8 × 2,048 bytes, 16,384 total, 10 s, always a trailer). Rules split per sentence now under a pre-registered eval, with targets the newest 16 plus the 16 most relevant. OpenRouter is the first extraction runner and its documented spans are code points, which replaces the UTF-16 plan. The eval cap is $5.
