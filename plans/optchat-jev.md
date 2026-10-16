# Add System One gates (Jev) to omp-optchat

This ExecPlan is a living document. The sections `Progress`, `Surprises & Discoveries`, `Decision Log`, and `Outcomes & Retrospective` must be kept up to date as work proceeds.

This document must be maintained in accordance with `.agent/PLANS.md`, the copy of OpenAI's ExecPlan rules at the repository root. Paths in this plan are repository-relative. The planning kit was ported into this repository on 2026-10-11 from `omp-jevify/docs/references/optchat-jev-kit`; that copy is a reference snapshot. Paths that begin with `src/`, `tests/`, `scripts/` or `CHANGELOG.md` are relative to the same repository root. The gates were built in the main checkout, not the worktree Milestone 0 describes (see Surprises, 2026-10-11). Line numbers cited for omp-optchat files are HEAD `bc633ac` unless the text says draft. Citations of the form `src/judgment/...`, `src/session/...`, `src/speculation/...` and `src/extensibility/...` without an omp-optchat prefix refer to the host source under `node_modules/@oh-my-pi/pi-coding-agent/src/`.

## Purpose / Big Picture

Oh My Pi (OMP, the `omp` command) is a terminal coding agent. The plugin omp-optchat, version 0.5.0, gives an OMP session one chat that never ends. Every message is kept forever in an append-only log, older messages are compressed into a binary tree of one-line summaries, and every turn the agent sees a fixed-size view of the whole history. The agent can open any summary line back to the exact original text with the `zoom` tool. This already works and is tested. What it lacks is any fast, cheap judgement about the chat itself.

This plan adds four optional decision features, called System One gates, to omp-optchat. Each gate is on by default and has its own opt-out flag (`--no-optchat-rules`, `--no-optchat-prefetch`, `--no-optchat-value-score`); this replaced the original off-by-default design on 2026-10-11 (see Decision Log). The four gates are a rules ledger, which remembers standing instructions the user gives; prefetch, which zooms the summary lines most relevant to the new message before the agent starts; value-score hints, which tell the summariser what to protect in a long message; and, until its removal on 2026-10-13 (see Decision Log), a tool gate, which screened risky tool calls before they ran. Every decision comes from Jev, a typed decision model that answers questions with choices, yes-no probabilities, and scores but never writes prose. Jev is reached through the judge model role of OMP, so the plugin sends no requests to Jev itself and holds no Jev credentials. With all four gates opted out, omp-optchat must send exactly the same requests as version 0.5.0, byte for byte, and a test proves it.

After this plan is complete, an OMP user can start `omp` with no gate flags and state a standing rule such as "from now on answer in British English". The session announces that a rule was added, `/optchat rules` lists it, and a later message that changes it replaces it. The tool gate, which asked for confirmation before a proposed `rm -rf` of a scratch directory ran, was removed on 2026-10-13; OMP's tool approval owns risky-call approval now. Each gate's state is visible in `/optchat status`. Every milestone below ends with an observable check, and Milestone 6 gives a scripted demonstration to run on a real OMP host.

## Progress

- [x] Milestone 0: baseline (golden added 2026-10-12, see pre-ratchet entry below; originally partial, 2026-10-11 UTC). Done: `bun test tests` 1370 pass / 0 fail; `bun run typecheck` exit 0; `OPTCHAT_SMOKE_OMP=/home/ericjuta/.bun/bin/omp bun run smoke` passed with gates off; a one-off 12-turn comparison against `git archive bc633ac` src gave identical context and `/optchat status` with gates off. The checks above ran on the working tree that includes the gates, not on a HEAD worktree.
- [x] Milestone 1 (2026-10-11 UTC): flags, `GateConfig`, host judge factory, `OptChatOptions.judge`, gate status lines. As built: `src/config.ts:15-22,38-52,108-147,166-172,222-233`; `src/system1/judge.ts:6-32`; `src/index.ts:111,1627-1643`. The chunker is `packByBytes` in `src/system1/judge.ts:43-65`, not a `chunk.ts` file. Tests are in one file, `tests/system1.test.ts`, not the per-file split this plan named.
- [ ] Milestone 2 (partial, 2026-10-11 UTC): ledger, background triage, `<rules>` after the view, `/optchat rules [remove ID]`. Done: `src/system1/ledger.ts` (`RuleLedger`), `src/system1/rules.ts`; wiring at `src/index.ts:1296-1303,1560-1607,1119,1255-1260,1645-1660`; ledger, rules and context tests in `tests/system1.test.ts`. Cache test added (2026-10-11): `tests/cache.test.ts` "System One messages through OptChat" checks that, with rules and prefetch messages present, the encoded Anthropic payload keeps the system prompt, tools and view text identical to an all-opted-out run, with rules then prefetch after the view and at most four breakpoints. The view's last block gains a cache mark when System One messages follow it; the text is unchanged (marks are metadata, `src/cache.ts`). Rule text narrowed (2026-10-11, see Decision Log): a message with several sentences keeps only the sentences the judge rates as rules; live check on the installed host stored only "From now on, always answer in British English spelling." from a two-sentence message.
- [ ] Milestone 3 (partial, 2026-10-11 UTC): prefetch. Done: `src/system1/prefetch.ts` (chunking, 4 requests in flight, top-k, one-level zoom, 16,384-byte block, fail-open); unit tests in `tests/system1.test.ts`; end-to-end tests through `OptChat` on a merged view in `tests/system1-e2e.test.ts` (2026-10-11: the picked line's children reach the request after `<chat>` and `<rules>`, and no prefetch judgment is made without a merged line). Prefetch judges every turn once a merged line exists. 2026-10-13: real-host run on a merged view (a copy of the live store: 229 view lines, merged levels 1-6). Prefetch made 18 judgments over six user turns and built two blocks; see Outcomes.
- [ ] Milestone 4 (partial, 2026-10-11 UTC): value-score hints. Done: `src/system1/value.ts`; `Memory` `hint` and `hintTimeoutMs` at `src/memory.ts:36-41,660-667,723-745`; three hint tests in `tests/memory.test.ts`; `valueHint` tests in `tests/system1.test.ts`; `tests/system1-e2e.test.ts` (2026-10-11) checks that the hint reaches compressor input only with value-score on, and that the built view and node count are identical with and without it. The live `aborted` row is explained (see Surprises): print-mode exit aborts the in-flight hint.
- [ ] Milestone 5 (superseded 2026-10-13: the tool gate was removed, see Decision Log). Partial 2026-10-11 UTC, historical: tool gate. Done: `src/system1/tool-gate.ts`; registration for the main session only at `src/index.ts:1717-1720,1737`; tests in `tests/system1.test.ts`. Live: `rm -rf build` was blocked with no UI (`danger 0.98 is at or above 0.30; no UI to confirm`) and `build/x.txt` survived. Approve with a UI is covered at `tests/system1.test.ts` (tool gate through OptChat); decline with a UI, safe calls without asking, and exempt tools never screened are covered in `tests/system1-e2e.test.ts` (2026-10-11). Open: the approve and decline paths with a UI were not run live; the planned counts of screened, asked and blocked calls are not implemented (see Surprises).
- [x] Milestone 6, live smoke with all four gates on (2026-10-11 UTC; OMP 18.9.1, `omp --no-extensions -e src/index.ts`, main `anthropic/claude-haiku-5-5`, judge `openrouter/~typesafe/jev-latest`, print mode, isolated `--optchat-dir`). Run 1, "From now on, always answer in British English spelling", wrote `{"op":"add","id":"r1",...,"source":0}` to `ledger.jsonl`. Run 2 asked to run `rm -rf build`; it was blocked as above, and the agent saw `<rules> r1 [0] ...</rules>`. `model_usage` rows: `optchat-rules` x2 and `optchat-tool-gate` x1 (all `stop`), and `optchat-value` x1 (`aborted`). Prefetch made no call. Focused tests (`tests/system1.test.ts`, `tests/memory.test.ts`): 89 pass / 0 fail (re-run during the port, 2026-10-11).
- [x] Milestone 6, docs: README section "System One gates" and the CHANGELOG Unreleased entry (2026-10-11 UTC).
- [x] Milestone 6, real-host run (2026-10-13 UTC; OMP 18.10.3, `--mode rpc`, main `anthropic/claude-haiku-5-5`, judge role `typesafe` via `openrouter-decisions`, `~typesafe/jev-latest`). Done on copies of the global store: all gates on (status lines, rule add, replace and remove, prefetch on a merged view, `chat_recall`, value hints); all gates off (no gate lines, no ledger, no `optchat-*` usage, no `chat_recall`); usage counts in Outcomes. Remaining, not done: the scripted `/optchat import` session on a file written in `/tmp` (the copy already held a merged view, so the import step was not needed for prefetch); judge accuracy on real messages (open item e), where the one recall probe returned a message that matched none of its keywords; the README Cost claim (see Outcomes).
- [x] Retrieval primitives (2026-10-11 UTC, release 0.7.0): `chat_search` (`Memory.search`, `src/handoff.ts`), `zoom` depth (`Memory.zoom`, `Memory.lineAt`), and the recall gate (`src/system1/recall.ts`, wired in `src/index.ts` `registerRecall`/`recallFor`, flags in `src/config.ts`). Tests: `tests/search.test.ts`, `tests/recall.test.ts`, three `chat_recall` cases in `tests/system1-e2e.test.ts`. Ticket 10's synthetic comparison (`bun run evidence:retrieval`) is recorded in that ticket.
- [x] Reconciliation with the sibling draft (2026-10-11 UTC): the uncommitted draft in the main checkout was reviewed and kept in place, with the fixes the implementer listed (see Surprises, and the Decision Log entry dated 2026-10-11, as built). Nothing was dropped.
- [ ] Open items (from the implementer's unverified list and the live run; not milestones): (a), (b), (c) and (d) closed 2026-10-11 (cache, end-to-end prefetch, value-hint composition tests; abort cause in Surprises); (e) judge accuracy on real messages, untested; (f) real-timer tests with fixed bounds (shutdown 1.5 s, prefetch 50 ms, memory hint 20 ms) are a flake risk; each carries a comment naming the exception.

- [x] Pre-ratchet foundations (2026-10-12 UTC). G5 golden: `tests/system1-off.test.ts` + `tests/fixtures/system1-off.golden.json` pin the 0.7.0 memory-only bytes (system prompt, tool definitions in an encoded Anthropic request, context messages, status), with no judge resolved and no `tool_call` hook; a one-byte prompt or tool-description mutation fails it. Ticket 02: native Jev answered from the eval kernel (`typesafe/jev-1.13-20260917`, 0.33 s). Judge fallback: without a native judge candidate only the tool gate runs (on the session model); the others report `inactive: no native judge model`, and `chat_recall` stays registered (definitions unchanged) returning an inactive result. `/optchat status` prints per-gate call, failure and outcome counters (`src/system1/gates.ts`). `chat_recall` eval: `evals/recall/` (30 synthetic, 18 real cases from read-only store copies, deterministic gold-id grader, oracle 100%, null 0%), tunable surface `src/system1/recall-prompt.ts`; pilot 0/4 on 28 judge calls ($0.005). Full suite 1433/0, smoke ok. Ratchet `init`/approvals not yet run: they need Eric.

## Surprises & Discoveries

- Observation: omp-optchat's main checkout is not clean. It holds uncommitted edits by another agent (task name `OptchatGates`) that are not part of HEAD.
  Evidence: `git status --short` in the omp-optchat repository on 2026-10-11 printed ` M src/config.ts`, ` M src/index.ts`, ` M src/memory.ts`, `?? src/system1/` and `?? tests/helpers/fake-host.ts`, `?? tests/helpers/fake-judge.ts` and `?? tests/system1.test.ts` (the last two appeared while this plan was being written, at 17:44). `git diff --stat` reported `src/config.ts | 91`, `src/index.ts | 276` (267 insertions, 9 deletions) and `src/memory.ts | 68` insertions. The `src/index.ts` edit already adds a `rules` case to the `/optchat` switch and wires the ledger into the session, so the draft is further along than an early survey suggested. Milestone 1 reviews it as a whole. HEAD is `bc633ac chore: release v0.5.0`.

- Observation: HEAD has no hint hook, but the uncommitted `Memory` class does.
  Evidence: `git show HEAD:src/memory.ts | grep -c hint` prints `0`. In the draft working tree (its line numbers are the draft's, not HEAD's) it adds `hint?` and `hintTimeoutMs?` to `MemoryOptions` (src/memory.ts:36-41), stores them (src/memory.ts:177-178, 221-222), and implements `hintFor()` (src/memory.ts:723-760), which is called only for a level-0 leaf whose record is not verbatim (src/memory.ts:660-667). At HEAD, `OptChatOptions` has no matching option, so the hook cannot be reached from an OMP session. The draft's `src/index.ts` edit may add one; Milestone 1 reviews it.

- Observation: the merge rule in the view is not the one the original design described. The code merges the adjacent pair with the oldest last message, scored as `(T - last message index) / 2^l`, and this is pinned by a test.
  Evidence: `coarsen()` in HEAD src/memory.ts:347-372 computes `age = (length - ((a.i + 2) * width - 1)) / width`, where `width = 2 ** a.l`. tests/memory.test.ts:1287 ("last-message age at T10 prefers 8+1|9+1 over 0+4|4+4") is the test name that pins this rule. The kit's design (`docs/design/optchat-jev.md:38`) uses `due = (T - start_of_a) / 2^(l + 2)`, which is start-based. This plan keeps omp-optchat's rule, not the kit's formula.

- Observation: prefetch has nothing to act on until the view has merged. The view keeps level-0 parts while it stays at or under 128,000 bytes, and merges only after that.
  Evidence: HEAD src/memory.ts:382-394 (`commit` calls `coarsen` at line 391, and `coarsen` loops only while bytes exceed its target) and tests/memory.test.ts:1407 ("default main upper is 128000 bytes and an overflow batch reaches 64000 with a 16000-byte context"). A summary line is at most 512 bytes, so the first merge needs roughly 250 or more messages of typical size [INFERENCE: 128,000 bytes divided by 512-byte nodes]. Prefetch's candidates are view parts that cover two or more messages, so a short chat gets no prefetch block. Milestone 6 therefore imports a prepared history rather than typing hundreds of messages.

- Observation: value hints touch only long messages. A message whose `kind: text` form fits in `nodeBytes` (512 bytes) is stored verbatim as a free node with no compaction call, so no hint is requested for it.
  Evidence: the check that decides between a free node and a compaction call is at HEAD src/memory.ts:592. The draft's hint call site is at its src/memory.ts:660-661 (hint only when `part.l === 0`).

- Observation: compaction task lines name message ids. The kit design (`docs/design/optchat-jev.md:25`) says the compactor never sees ids, and this is not true of omp-optchat today.
  Evidence: HEAD src/memory.ts:631-632 builds "compress message N" and "merge lines a+h and b+h". Rendered lines carry `id+n|` heads (HEAD src/memory.ts:336, `renderPart`). The output must omit the heads (src/prompts.ts:18-19). This plan does not change those prompts; new code adds no ids. The AGENTS.md rule records the deviation.

- Observation: the host does not run task speculation for a plugin that has lifecycle handlers, and omp-optchat already has one. A `tool_call` handler therefore changes nothing about early launches, because omp-optchat's `tool_result` handler already disables them.
  Evidence: host `node_modules/@oh-my-pi/pi-coding-agent/src/speculation/host.ts:75-82` (`hasLifecycleHandlers` is true when `tool_call`, `tool_result`, `tool_approval_requested` or `tool_approval_resolved` has a handler) and the same file at 215-232 (`authorizeLaunch` denies when lifecycle handlers exist or approval is not auto-allow). omp-optchat registers `tool_result` at HEAD src/index.ts:1482.

- Observation: the judgment usage journal may not work from an extension. `journalJudgmentUsage(manager)` returns `undefined` unless the manager has `appendModelUsage`, `getSessionId` and `getLeafId`, but the type that `ctx.sessionManager` exposes (`ReadonlySessionManager`) does not list `appendModelUsage`.
  Evidence: host `node_modules/@oh-my-pi/pi-coding-agent/src/judgment/index.ts:101-123` (the `isUsageLedger` check) and `.../src/session/session-manager.ts:679-703` (the `ReadonlySessionManager` Pick list, which has no `appendModelUsage`). Whether the runtime object carries the method is not verified. Milestone 1 measures it, and Milestone 6 confirms it on a real host.

- Observation: a stale copy of the host source exists and must not be used for reading. `~/.omp/plugins/node_modules/@oh-my-pi/pi-coding-agent` is version 18.1.22; listing its `src/judgment` printed nothing. The plugin's own `node_modules/@oh-my-pi/pi-coding-agent` is 18.9.1, which is the runtime that matters, and plugin imports of `@oh-my-pi/*` resolve to the running host.
  Evidence: `package.json` of each copy, and src/extensibility/plugins/legacy-pi-compat.ts:810-828 for the resolution.

- Observation: skills stored in the other harness's project directory never load on this host. The host disables the `claude` and `claude-plugins` providers.
  Evidence: CFG `~/.omp/agent/config.yml:128-130` (`disabledProviders`). The kit's skills now live in `.omp/skills/`, which is OMP's native project location.

- Observation (2026-10-11): the shutdown triage bound is 1.5 s, not 5 s, because the host caps `session_shutdown` handlers at 2 s. Evidence: `SHUTDOWN_TRIAGE_MS = 1_500` (src/index.ts:90, `settleTriage` at 1610-1618); host `SESSION_SHUTDOWN_HANDLER_TIMEOUT_MS = 2_000` (node_modules/@oh-my-pi/pi-coding-agent/src/extensibility/extensions/runner.ts:156), applied to `session_shutdown` at runner.ts:163-166.
- Observation (2026-10-11): judgment usage is journaled from the extension. The main agent's live run wrote `model_usage` rows for `optchat-rules` (x2) and `optchat-tool-gate` (x1), each with provider `openrouter`, model `~typesafe/jev-latest`, and `stopReason` `stop` (runtime-observed). This answers the open question about `appendModelUsage` in the Context section.
- Observation (2026-10-11): the `optchat-value` judgment ended `aborted` in the live run. Cause (established later the same day): print mode exited 39 ms after the 1,371-byte reply was logged, and `memory.close()` aborts every running job (src/memory.ts:338-347). That abort reaches `hintFor`'s give-up signal, then `judgeWithin`'s parent signal (src/system1/judge.ts:85-87), and the host journals `stopReason` `aborted` (node_modules/@oh-my-pi/pi-coding-agent/src/judgment/index.ts:450-456). The leaf was not built and is retried on the next append. In a fresh print run with a 992-byte message, the hint completed with `stop`. A fake-judge script showed the second path: a judge slower than 2 s is abandoned by the memory `hintTimeoutMs` bound (which ties with `VALUE_MS` and fires first), and the leaf compacts without a hint. Not a defect; no code change.
- Observation (2026-10-11): the gates were built in the main omp-optchat checkout as uncommitted changes, not in the `system1-gates` worktree Milestone 0 describes. Evidence: `git status` in the main checkout lists `src/system1/`, `tests/system1.test.ts` and the `src/` edits. No worktree run is recorded.
- Observation (2026-10-11): `/optchat status` shows one "last System One failure" line for all gates (src/index.ts:1640-1641, from the single `gateFailure` string set at src/index.ts:1490), and no per-gate outcome or counts. The Decision Log's status entry asked for both. Gate lines are hidden entirely when every gate is off (src/index.ts:1630), which keeps status identical to 0.5.0.
- Observation (2026-10-11): a malformed `--optchat-tool-gate` still registers the `tool_call` handler, which then blocks (src/config.ts:166-172; registration at src/index.ts:1737). This is fail-closed, as the plan requires.
- Observation (2026-10-11): an I/O error from `RuleLedger.open` fails OptChat closed: the store is closed and the error is rethrown (src/index.ts:588-593). Malformed lines are skipped (src/system1/ledger.ts:118-126). A torn final line is skipped, and the next append starts on a fresh line (src/system1/ledger.ts:114-117 and 143-148).
- Observation (2026-10-11): triage eligibility is enforced by entry kind and message role, not by a skill or side-turn list. Only `kind: user` entries from `role: user` messages reach triage (src/index.ts:1296-1303), so skill prompts, reports and agent messages never do.
- Observation (2026-10-11): the supersedes list offers the newest 32 active rules, not 64, and each criterion carries the rule's full text (up to 512 bytes), not a 200-byte cut (src/system1/rules.ts:110, 127-129, 149-151). Triage has a 20 s bound (src/index.ts:85), which the plan did not specify.
- Observation (2026-10-11): prefetch zooms each selected line with `memory.zoom(id, n).text` and does not parse the children. A line that would overflow the 16,384-byte block is skipped, never cut (src/system1/prefetch.ts:110-121). Candidates come from `viewLines()` (src/memory.ts:289), not `lines()`. Its bound is the smaller of 5 s and the settle deadline minus 500 ms (src/index.ts:92, 1536).
- Observation (2026-10-11): the value hint is one fixed sentence, "This record is <phrase>. Its importance is <level>.", built from closed tables (src/system1/value.ts:189-194, 230). It is not the phrase list in the plan. Its judge purpose is `optchat-value` (src/index.ts:1623).
- Observation (2026-10-11): failure text is bounded to 200 characters (src/system1/judge.ts:68-71), not 160.
- Observation (2026-10-11): the rules and prefetch blocks are computed once when `openTurn` runs and stored in `Turn.extra` (src/index.ts:412, 1255-1260); `context` returns `[view, ...turn.extra, ...messages]` (src/index.ts:1119). A rule written mid-turn applies from the next turn.
- Observation (2026-10-11): no golden fixture and no `tests/system1-off.test.ts` are committed; `ls tests` shows neither. The gates-off equivalence is the one-off comparison in the implementer's report.
- Observation (2026-10-11): `tests/cache.test.ts` is unmodified, so the cache check with extra messages is not in the suite.

## Decision Log

- Decision (2026-10-12): pre-ratchet choices by Eric. G5 golden pins 0.7.0
  memory-only bytes (every gate opted out), not v0.5.0. Without a native
  judge model, the tool gate falls back to the session model and the other
  gates go inactive, with status saying why. Labelled sets: real-session
  held-out, generated training. First ratchet flow: the chat_recall descent
  prompt. Scorers are deterministic wherever labels allow. All model calls
  (proposer, Jev, any grader) go through OMP roles and its OAuth
  subscriptions, never a direct OpenRouter key.
  Date/Author: 2026-10-12 / Eric via grilling.

- Decision (2026-10-11): add three retrieval primitives, all on by default: `chat_search` (deterministic AND-of-words search over the raw log, newest first, `before` paging), `zoom` `depth` (1–4 levels per call), and the recall gate's `chat_recall(question)` (judge scores the view lines, single-message lines included; the best line at or above `--optchat-recall-min`, default 0.5, is descended with one two-way `choice` per level to one message). `chat_search` and `depth` are memory tools, not gates: they use no judge. Recall is a gate with `--no-optchat-recall`.
  Rationale: zoom only reaches a detail while some summary still names it; once compression drops a name, path or error, raw-log search is the only deterministic way back. A line covering n messages costs log₂ n zoom calls, and prefetch opens one level only, so a judge-guided descent is the cheapest way to let Jev pick branches. The descent keeps Jev's output behind code thresholds: a min for the first line and argmax per level; it never writes prose and never touches the merge.
  Date/Author: 2026-10-11 / main agent, from the "missing primitives along zoom" review.

- Decision (2026-10-11): the new tools are named `chat_search` and `chat_recall`. OMP canonicalizes `search` to `grep` (`node_modules/@oh-my-pi/pi-coding-agent/src/tools/builtin-names.ts:40`), so a tool named `search` never appears as active and the core refusal check refused every real-host turn; `recall` is a host builtin (same file, line 28).
  Rationale: observed failure of the real-host background cases with `search`; they pass with `chat_search`.
  Date/Author: 2026-10-11 / main agent.

- Decision (2026-10-11): search skips memory tool call records (`zoom`, `date`, `work`, `chat_search`, `chat_recall`) and echoes that start with `[optchat search]` or `[optchat recall]`. Zoom page echoes are not skipped: the message metadata schema admits only `work` and `images`, so a tool name cannot be recorded without breaking older readers, and those echoes are faithful copies.
  Date/Author: 2026-10-11 / main agent.

- Decision (2026-10-11): a rule stores only the sentences that state it. When a user message has several sentences, triage adds one noul question per sentence (`s0`, `s1`, …, at most 12, whole sentences within the 4,000-byte state bound), and the rule text is the sentences that reach `--optchat-rule-add`, joined in order. If none reaches it, nothing changes. A one-sentence message is kept whole, as before.
  Rationale: the live run stored a whole two-part message as rule `r1`, including an unrelated `rm -rf` request, which then rode along in every `<rules>` block. Jev never writes prose, so it cannot rewrite the rule; selecting the user's own sentences keeps the text verbatim and the decision owned by a code threshold.

- Decision: System One gates are built into omp-optchat, behind one flag per gate. With all four gate flags off, omp-optchat must send the same requests as version 0.5.0.
  Rationale: the user chose this home. omp-optchat already implements the store, the single-writer lease, the cache marks, the compaction pump and the view, with tests. A separate Bun application would duplicate all of them. The golden test in Milestone 0 turns "byte-identical when off" into a checked fact.
  Date/Author: 2026-10-11 / kit rewrite.

- Decision: build in a separate git worktree created from HEAD, on a new branch `system1-gates`, at the path `/srv/openclaw-data/home/ericjuta/.openclaw/workspace/repos/omp-optchat-system1`. The dirty main checkout is not edited by this plan.
  Rationale: the main checkout holds another agent's uncommitted, unreviewed edits (see Surprises). Building on top of them would make the baseline unknowable. The draft is read as a reference, and Milestone 1 says which parts may be adopted, after they pass this plan's tests.
  Date/Author: 2026-10-11 / kit rewrite.

- Decision: Jev is reached only through the host judge role, using `resolveJudge` from `@oh-my-pi/pi-coding-agent/judgment`. The plugin has no HTTP client, no OpenRouter or TypeSafe client, and no `Decider` interface. Fallback is the host's chain: the native Jev backend first, and a local or chat model only when no native candidate is credentialed. Tests inject a fake judge that implements the `Judge` interface exported from `@oh-my-pi/pi-ai`, through `OptChatOptions.judge`.
  Rationale: the host already provides fallback, a five-minute cooldown after an account rejection, a shared answer cache, and usage journaling (src/judgment/index.ts:134-135, 255-299; src/judgment/cache.ts:1-17). Re-implementing them would add code that the host maintains for us.
  Superseded (2026-10-11): `docs/design/optchat-jev.md:87` specifies a `Decider` interface with three implementations (real Jev, an LLM fallback, and a fake). That design is replaced by this decision.
  Date/Author: 2026-10-11 / kit rewrite.

- Decision: rules ledger triage runs in the background after a human-typed user message is durably logged. It makes one Jev request per message, with a `noul` question `rule` and, only when active rules exist, a `choice` question `supersedes` whose labels are the 64 most recent active rule ids plus `none`. A rule is added when P(rule) is at least `--optchat-rule-add` (default 0.8). The rule text is the message text. A rule replaces an existing rule only when P(rule) is at least the add threshold and `supersedes` names a rule with probability at least 0.5.
  Rationale: the contract's wording "add/replace when P(rule) >= ...; replace when supersedes != none with p >= 0.5" is read as a conjunction for replacement. A supersede pick on a message that is not a rule would otherwise rewrite a rule silently.
  Date/Author: 2026-10-11 / kit rewrite.

- Decision: no blocking "ask the user" band for rules. Every add and replace is announced through `ctx.ui.notify` when a UI exists, appears in `/optchat rules`, and can be reversed with `/optchat rules remove <id>`.
  Rationale: the kit's ask band (confidence between 0.5 and 0.8) would interrupt the user for borderline messages. A wrong rule is cheap to see and cheap to remove, so an announcement is enough.
  Superseded (2026-10-11): `docs/evals/schemas.md:21` sets `ruleAsk` 0.5 beside `ruleAdd` 0.8, which is the ask band.
  Date/Author: 2026-10-11 / kit rewrite.

- Decision: the ledger is a file `ledger.jsonl` in omp-optchat's store directory, appended with a write followed by fsync. Events are `add`, `replace` and `remove`, each with an id, the source message id, the text and a timestamp. Rule ids have the form `r<k>` and are never reused, even after removal. A torn final line is skipped on replay, as the log does. A replace keeps the superseded rule's id and swaps its text and source.
  Rationale: this matches the durability rules the log already uses (src/store.ts:404-410). Keeping the id on replace means `/optchat rules remove r2` always names the same rule.
  Superseded (2026-10-11): the kit's design keeps state under `chat/` (`docs/design/optchat-jev.md:209`, `chat/subagents`). The ledger lives in omp-optchat's store directory instead.
  Date/Author: 2026-10-11 / kit rewrite.

- Decision: a rule's text is the user's message text, cut to 512 bytes at a UTF-8 boundary, followed by the marker "(zoom <id> for the rest)" when cut. The rules block is rendered as its own user message after the view and before the turn's messages. It is omitted when no rules exist. It is computed once per turn, when the turn opens.
  Rationale: a bounded ledger keeps the per-turn cost small. The original message stays zoomable through its id. Freezing per turn keeps each turn's requests byte-stable. The view is the first message of the request (src/cache.ts:124), so the rules block cannot move the view's cache marks.
  Date/Author: 2026-10-11 / kit rewrite.

- Decision: triage skips anything that is not a human-typed user message: work reports (kind `work`), skill prompts (custom type `skill-prompt`), side turns (`/btw` and recaps), and messages whose attribution is not the user. The triage queue runs serially in log order.
  Rationale: the contract lists these skips. Reports and skill prompts can contain text that reads like a rule but was not written by the user (src/index.ts:61, 271; src/index.ts:1030, 1078-1080).
  Date/Author: 2026-10-11 / kit rewrite.

- Decision: prefetch runs in the turn path after settle and view rendering, with a time bound of the smaller of 5 seconds and the remaining settle deadline minus 500 milliseconds. Candidates are view parts that cover two or more messages. Requests are chunked: each state is a JSON object `{message, lines}`, where `message` is the new user text capped at 4,000 bytes and `lines` maps `<id>+<n>` to the line's text. Each state holds at most 24,000 UTF-8 bytes and at most 64 questions, with at most 4 requests in flight. Each line gets one `noul` question. The top `--optchat-prefetch-k` lines (default 8) with P at least `--optchat-prefetch-min` (default 0.5) are zoomed one level into their two children. The block is ordered by message id and capped at 16,384 bytes. It is rendered as its own user message after the rules block and is frozen per turn. Any failure or timeout yields no prefetch block, and the turn proceeds.
  Rationale: the contract's numbers, with one addition. Ordering by message id makes the block read as a chronological excerpt rather than a score ranking.
  Date/Author: 2026-10-11 / kit rewrite.

- Decision: value-score hints use the `hint` option that already exists in the uncommitted `Memory` draft, with the same contract signature. Hints are requested only for a level-0 leaf that is not a free node, with a bound of 2 seconds (`hintTimeoutMs`). The hint is a sentence built from a closed template, selected by the judge's `label` (decision, preference, finding or noise) and its `importance` (low, medium or high). The model's text is never passed on, and the sentence contains no ids.
  Rationale: a closed template means judge output can never inject instructions into the compaction prompt. The contract said the hint is "one sentence", and a template achieves that.
  Interpretation: the original design said the hint is used "if it is ready when the node is built". This plan waits up to 2 seconds inside the compaction job instead. Compaction runs in background jobs and never blocks a turn, so the wait costs nothing visible, and the result is deterministic.
  Date/Author: 2026-10-11 / kit rewrite.

- Decision: the tool gate handler is registered on `tool_call` only when `--optchat-tool-gate` is on, and only for the main agent. The exempt tools are `zoom`, `date`, `work`, `read`, `grep`, `glob`, `find`, `todo`, `ask`, `think` and `web_search`. Every other tool, including `task`, `bash`, `eval`, `edit`, `write`, and MCP tools, gets one judge request with state `{tool, input, cwd}` (input is JSON, capped at 8,000 characters), a `choice` question `risk` over safe, risky and destructive, and `noul` questions `deletes`, `remote` and `shared`. Danger is the maximum of P(destructive), `deletes`, `remote` and `shared`. Danger at or above `--optchat-tool-ask` (default 0.3) asks the user through `ctx.ui.confirm` when a UI exists, and blocks with a reason when none exists. A judge failure or timeout (bound 8 seconds) is treated as an unanswered risk: with a UI it asks, and without one it blocks, and the reason names the failure class.
  Rationale: the contract has one threshold, not two. The kit's earlier block threshold at 0.8 is folded into the ask, because the user is the better decider when a UI exists. Subagents are not gated directly; the `task` call is screened on its arguments, because a subagent runs with approval forced to yolo (host `src/task/executor.ts:1144-1146` sets `tools.approvalMode` to `yolo` for a subagent).
  Superseded (2026-10-11): `docs/evals/schemas.md:21` sets `toolBlock` 0.8 and `toolAsk` 0.3.
  Date/Author: 2026-10-11 / kit rewrite.

- Decision: `/optchat status` gains one line per gate, saying whether the gate is on or off, the judge's primary model or a reason none was resolved, the active rule count, and the last outcome and last failure of each gate. Failure text is bounded to 160 characters and contains only the error class and any HTTP status, never provider text. `/optchat rules` and `/optchat rules remove <id>` are added.
  Rationale: the contract requires the status lines. "Last outcome" is added beside "last failure" because a gate that quietly does nothing is otherwise indistinguishable from one that is working.
  Date/Author: 2026-10-11 / kit rewrite.

- Decision: judge usage is journaled with `journalJudgmentUsage(ctx.sessionManager)`. If that returns `undefined`, the status line says "usage: not journaled" and the number of judge calls is still counted. No savings or cost claim is made from unjournaled usage.
  Rationale: the type of `ctx.sessionManager` does not declare `appendModelUsage` (see Surprises). Unknown cost is unknown, never zero.
  Date/Author: 2026-10-11 / kit rewrite.

- Decision: extra messages after the view do not change the view's cache marks. Milestone 2 adds a test that the marks computed by src/cache.ts for a request with a rules message after the view are the same as without it. Any per-turn cost from uncached extra messages (prefetch above all) is measured in Milestone 6, not assumed.
  Rationale: the cache rules in src/cache.ts place marks on the view's blocks, and the view is the leading message. The cost of the extra messages is a measurement question.
  Date/Author: 2026-10-11 / kit rewrite.

- Decision: all four gate flags default to off in this plan, and this plan does not decide which gates default on. Choosing defaults and thresholds is the job of kit ticket 06, which is a grilling ticket.
  Rationale: the contract keeps defaults off until the evidence exists.
  Date/Author: 2026-10-11 / kit rewrite.

- Decision: all four gates default on, superseding the decision above. Each gets an opt-out flag (`--no-optchat-rules`, `--no-optchat-prefetch`, `--no-optchat-value-score`, `--no-optchat-tool-gate`) that wins over the gate flag, following `--no-optchat`; OMP boolean flags are presence flags, so a default-on gate cannot be turned off any other way. "Gates off" in the milestones below now means every gate opted out. The integration harness and the evidence runner opt out explicitly, because they measure memory alone. Thresholds are unchanged. This resolves ticket 06 question 1.
  Rationale: the user asked for the new features to run without flags ("i want those new features without flags to run. enable by default here"), and said to be pragmatic.
  Date/Author: 2026-10-11 / user.

- Decision: the eval harness and the automated research loop are out of scope for this plan, by the user's direction. Their reference documents remain in this repository at `docs/evals/rubric.md`, `docs/evals/schemas.md` and `docs/evals/autoresearch-loop.md`. They are mapped onto existing machinery there, the host's `/ratchet` and omp-optchat's `evidence:recall` runner, but nothing in this plan implements them.
  Rationale: the user's direction. The planning kit's README (line 16 of the original) also schedules an autoresearch iteration after its milestone 4; this plan drops the harness and the loop.
  Superseded (2026-10-11): the planning kit's README step (line 16 of the original) that runs an autoresearch iteration after its milestone 4.
  Date/Author: 2026-10-11 / kit rewrite.

- Decision: keep omp-optchat's existing machinery where it differs from the kit's design. The store layout (the `main` and `tree` streams in the store directory, HEAD src/store.ts:323) and the single-writer lease (an abstract Unix socket keyed by the directory's device and inode, src/store.ts:353-378) replace the kit's `chat/` directory and file-based socket lock. The retry rule is omp-optchat's: a failed node is retried on the next append, with no timers (HEAD src/memory.ts:147-148; a failed node is logged at line 570), replacing the kit's `RETRY = 10 s`. The compaction order is dependency-ready, not strict. The view grows to 128,000 bytes and then merges down to 64,000 bytes, a sawtooth instead of a fixed budget. The compaction prompts are omp-optchat's own (src/prompts.ts). The constants `NODE = 512`, `JOBS = 8`, `TRIES = 5` and the tool-output cap of 30,000 characters are unchanged.
  Rationale: each is implemented and tested in omp-optchat, and the kit's values are proposals: `docs/design/optchat-jev.md:3` calls every default "a starting position".
  Superseded (2026-10-11): the kit's design specifies a socket lock (`docs/design/optchat-jev.md:19`), a `RETRY` of 10 s (line 58), and strict compaction order (line 25); `docs/evals/schemas.md:18` fixes a 128,000-byte `VIEW`.
  Date/Author: 2026-10-11 / kit rewrite.

- Decision: the model roles come from OMP. The compactor model is omp-optchat's `--optchat-model`, which defaults to `@smol`. The agent uses the session's model. Jev is the `judge` role, which on this user's host is `openrouter/~typesafe/jev-latest` (`~/.omp/agent/config.yml:6`). No environment variable holds a model id.
  Rationale: OMP already resolves roles, credentials and fallbacks. Environment-variable model ids would duplicate that.
  Superseded (2026-10-11): `docs/evals/schemas.md:22-23` names `env:OPTCHAT_MASTER_MODEL`, `env:OPTCHAT_COMPACTOR_MODEL` and `OPTCHAT_JUDGE_MODEL`. The kit's brief describes a standalone Bun app on `@anthropic-ai/sdk`; this plan drops it.
  Date/Author: 2026-10-11 / kit rewrite.

- Decision: triage, prefetch, hints and the tool gate are gated by flags. The rules ledger, prefetch, value score and tool gate are read through `GateConfig` in src/config.ts, and no gate runs when its flag is off.
  Rationale: each gate must be measurable on its own, as the kit's design requires.
  Date/Author: 2026-10-11 / kit rewrite.

- Decision: no version bump, tag, release or publish is part of this plan. Milestone 6 adds an "Unreleased" entry to CHANGELOG.md.
  Rationale: the user did not ask for a release. A release is a separate decision.
  Date/Author: 2026-10-11 / kit rewrite.

- Decision: the real-host smoke in Milestone 6 may spend at most 40 judge calls, and every usage row must be recorded in the Artifacts section.
  Rationale: this is a proposed default for the one live step, chosen because the user has set no budget for this plan. It can be changed by editing this entry.
  Date/Author: 2026-10-11 / kit rewrite.

- Decision (2026-10-11, as built): the gates land as uncommitted changes in the main checkout, not in the `system1-gates` worktree. The reason is not recorded in the materials this port used. Confirm with the user before committing. Supersedes: the worktree step in Milestone 0 and Concrete Steps.
  Date/Author: 2026-10-11 / port.

- Decision (2026-10-11, as built): the shutdown triage bound is 1.5 s, under the host's 2 s `session_shutdown` cap (see Surprises). Supersedes the 5 s figure in the earlier design. Date/Author: 2026-10-11 / port.

- Decision (2026-10-11, as built): the rules and prefetch blocks are decided when `openTurn` runs and carried in `Turn.extra` for every request of that turn (src/index.ts:1255-1260). Rationale: byte-stable requests within a turn. Date/Author: 2026-10-11 / port.

- Decision (2026-10-11, as built): gate lines are hidden from `/optchat status` when every gate is off (src/index.ts:1630). Supersedes the Milestone 1 wording that asks for one line per gate in every case. Rationale: status stays identical to 0.5.0. Date/Author: 2026-10-11 / port.

- Decision (2026-10-11, as built): `RuleLedger.open` errors fail OptChat closed (src/index.ts:588-593). Malformed lines are skipped (src/system1/ledger.ts:118-126). Date/Author: 2026-10-11 / port.

- Decision (2026-10-11, as built): a judge factory that cannot resolve a primary model returns `undefined`, so the gate does not run and status says none (src/system1/judge.ts:28). Date/Author: 2026-10-11 / port.

- Decision (2026-10-11, as built): prefetch zooms through the existing `Memory.zoom` and does not parse children (src/system1/prefetch.ts:113). The plan allowed either. Date/Author: 2026-10-11 / port.

- Decision (2026-10-11, as built): the value hint uses one fixed sentence template (src/system1/value.ts:189-194, 230). Supersedes the phrase list in the 2026-10-11 Decision Log entry on value hints. Date/Author: 2026-10-11 / port.

- Decision (2026-10-11, as built): the tool gate registers only for the main session (src/index.ts:1717-1720, 1737), and a malformed `--optchat-tool-gate` still registers it, so it blocks (src/config.ts:166-172). Date/Author: 2026-10-11 / port.

- Decision (2026-10-11, port): `AGENTS.md` replaces the kit's `.env` secrets rule with OMP's credential store. This repo's `.gitignore` covers `node_modules/`, `coverage/`, `*.tgz` and `.optchat/` and has no `.env` entry. The kit's build-in-a-worktree rule is dropped. Date/Author: 2026-10-11 / port.

- Decision (2026-10-13, Eric): the tool gate is removed. `src/system1/tool-gate.ts`, the `tool_call` hook, `--optchat-tool-gate`, `--no-optchat-tool-gate` and `--optchat-tool-ask` are deleted, with the gate's status counts and its fallback role. OMP's `tools.approval` owns risky-call approval. Milestone 5 is superseded. Rules, prefetch, value-score and recall remain. On the session-model fallback no gate runs, and `chat_recall` still answers inactive. The tool-gate text in the Milestones, Interfaces and older Decision and Progress entries is historical. Date/Author: 2026-10-13 / Eric.

- Decision (2026-10-13, Eric): `--optchat-recall-k` stays opt-in at default 1. Rationale: on the recall eval, k=3 answered 15/96 against 14/96 for k=1 at about 37% more judge calls. Date/Author: 2026-10-13 / Eric.

- Decision (2026-10-13): `chat_recall` seeds its candidates with raw-log matches (`Memory.rankMessages`: IDF-weighted word match, no model call). `--optchat-recall-seeds` defaults to 8 (range 0–32), and seeds are scored in the same requests as view lines; `0` gives the earlier requests byte for byte (hash parity over 48 cases at k=1 and k=3). Rationale: summaries kept the fact for only 11 of 48 covered gold messages. On the recall eval at k=1 with 2 reps, seeds 8 answered 65/96 against 21/96 for seeds 0, and the second run matched the first. Raw-log winners were right 62 of 72 times. The real-only subset agrees in direction but is not significant (p≈0.11). Date/Author: 2026-10-13 / RecallSeed.

- Decision (2026-10-13, Eric): recall eval scoring grades what recall returned. A found or none outcome is scored as returned even when a judge call inside it failed (`internal_judge_errors` records the failures). Only attempts with no outcome are retried; after the retries they go to `errors.jsonl`. The earlier rule that scored a pass after a retry as a fail is dropped. Date/Author: 2026-10-13 / Eric.

- Decision (2026-10-13, Eric): standing instructions are split by scope, documentation only. The rules ledger holds instructions stated in this chat, OMP TTSR rule files hold guardrails enforced for every session, and Sharpshooter holds cross-session project decisions. Nothing is copied between them. Date/Author: 2026-10-13 / Eric.

- Decision (2026-10-13, Eric): the stored TypeSafe credential was removed with OMP's RPC logout. Jev is still reached through the `judge` role over OpenRouter. Date/Author: 2026-10-13 / Eric.

- Decision (2026-10-13, Eric): the system prompt's `chat_recall` line now says the judge scores view lines and messages whose words match the question, not that it picks a view line. The prompt is sent with every gate off too, so the G5 golden (`tests/fixtures/system1-off.golden.json`) was re-pinned to 0.9.0 memory-only bytes (a 4-line prompt diff, nothing else) and `SYSTEM_BLOCK_BYTES` went from 6277 to 6316. Parity with 0.7.0 bytes ends here. Supersedes the 2026-10-12 choice to pin 0.7.0. Date/Author: 2026-10-13 / Eric.

- Decision (2026-10-13, Eric): `/optchat new` starts a fresh chat. It archives the store directory as `<dir>.<UTC timestamp>` and reopens an empty store; nothing is deleted. Date/Author: 2026-10-13 / Eric.

- Decision (2026-10-14, Eric): next measurement work is the rules-triage flow (`evals/rules/`, wording moved byte-identically to `src/system1/rules-prompt.ts`) and small fixed G1/G3 sets (`evals/gates/`, 20 cases each); budget $5; the design doc's gates-off wording follows the 0.9.0 golden. Baseline (Jev 1.13, threshold 0.8, 2 reps): rules score 0.979, precision 1.000, recall 0.936, F1 0.967; but null scores 0.768 on `score`, so a rules ratchet should target F1, not `score` (open). Real held-out has only 2 standing rules in 122 messages. G1 flagged 2/20, G3 5/20 on the smol compressor; on reading, all appear to be false positives, but they are unconfirmed pending human review. Spend ≈ $0.019. Date/Author: 2026-10-14 / Eric.

- Decision (2026-10-14, Eric, HITL review of `baseline-smol-2026-10-14-run2`): both G1 flags (g1-15 quotes "100 percent pass" only to reject it; g1-19 attributes the `authorized_keys` claim to the quoted README) are false positives, so G1 is 0/20. G3: Eric delegated the call; all 5 flags are accurate lines (negated "not migrated", "not deployed anywhere"; "done" is the user's deadline; "12/12 passed" is true; g3-01 matched the leaked "Merged line" preamble), so G3 is 0/20. Scoring becomes keyword pass plus a Jev confirm before human review (thresholds unchanged; a person still confirms any failure). Compressor head/preamble leak (36% of this repo's live tree) gets a retry guard in `compact()` now and a compressor-wording ratchet later. Rules: grow real standing-rule positives by labeling mined history before ratcheting; target F1; real-072 stays rule=true.

- Decision (2026-10-14, Eric delegated: "i delegate all to you pragmatically"): the rules eval's real set grows from Eric's OMP session logs, not only OptChat stores. `evals/rules/build-cases.ts` reads a `real-spec.json` entry whose `store` starts with `sessions/` as line `i` of that session log (a user message entry, text parts joined by newlines), with the same SHA-256 and secret-like checks. The 35 mined candidates were labelled by the agent under the header's criterion: 24 rule, 6 none, 5 excluded (boundary scope: cand-07, -26, -27, -31, -35); `i=966` of this store added as none. Real set: 127 cases, 26 rule. Rerun (`~/.cache/omp-optchat-evals/rules/baseline-2026-10-14-mined`, Jev 1.13, threshold 0.8, 199 cases x 2 reps, 398 judge calls, $0.0069, 0 errors): precision 1.000, recall 0.651, F1 0.788 (test F1 0.795). By stratum: synthetic-rule 70/74, real-rule 10/52, every none row correct. The gate misses most of Eric's terse one-line real rules (a toolchain fact, a "we don't want X" constraint): it decides `none`, not a low-scoring add. This is the rules ratchet's target; its first round should be wording in `src/system1/rules-prompt.ts`, F1 on the test split. Date/Author: 2026-10-14 / agent, delegated by Eric.

- Decision (2026-10-14, agent, under the HITL "keyword plus Jev confirm"): the gate rerun with Jev confirm (`baseline-smol-2026-10-14-run3-jev`, $0.0151, 43 compressor and 4 judge calls) had G1 1 keyword hit and G3 3, all auto-dismissed by Jev (P(yes) 0.09–0.23, under `JEV_CONFIRM_MIN` 0.5); human-review lists are empty, so G1 and G3 pass on this set. Date/Author: 2026-10-14 / agent.

- Decision (2026-10-14, Eric, HITL "Yes-only sets, fix real-17"): a real `chat_recall` case may accept more than one message. A `real-spec.json` entry can list `also`, other messages of the same store that answer the question as well as the gold, and `grade()` passes the gold or an `also` id (`evals/recall/build-cases.ts`, `evals/recall/grade.ts`). The sets come from blind pooling. For each case the candidates were the gold ±2, the question's top 16 word-search matches and every message any recorded run answered (384 candidates over 18 cases). Six assessors read only the chat text, never which message a run picked, and marked each candidate yes, partial or no. Only `yes` is accepted: 17 ids over 11 cases. real-17's gold (210) only announces the `rules.ts` edit and does not answer its own question, so its gold becomes the edit (211), with the edit's result (212) in `also`. Rescored at $0, the seeds-8 default is unchanged on held-out (24/38; real 2/14), and real train goes from 11/22 to 15/22. So the held-out real misses are genuine, not a scoring artefact: 4 of the 7 held-out real cases answer a message the assessors judged a non-answer, the same message in both reps. Date/Author: 2026-10-14 / Eric (decision), agent (protocol).

- Decision (2026-10-14, Eric, HITL "Grow real cases to ~60, then a new flow"): the real `chat_recall` set grows from 18 to 60 cases, because 7 held-out real cases cannot steer a climb (one case is 14 points of real score). Five authors wrote 42 questions blind from the chat text of the four snapshots (`real-19`..`real-60`), each naming its context so that one place in the chat answers it. They saw no recall behaviour, and they followed packet order, skipping one candidate. Gold kinds are 19 talk, 15 echo, 6 user and 2 work, and 22 of the questions are paraphrases. Answer sets followed the same blind pooling, with pooling runs at seeds 8 (2 reps), 0 and 32 ($0.33). A second pass read the full first recall page (8000 bytes) of truncated candidates that shared rare words with the gold or that any run had answered. It added 1001 to real-06 and found yes answers past the first pass's 4000-character cut in 5 new cases. One `yes` was downgraded on review (real-19: 508 omits what OptChat stores). In total 32 of 60 cases have `also` (59 ids). Preflight on all 90 cases: oracle 90/90, null 0/90. Raw-log word search puts the gold in the top 32 for 26 of 60 real cases. These cases call for a new ratchet flow, since changed cases cannot be re-approved into `chat-recall-seeded`. Date/Author: 2026-10-14 / Eric (decision), agent (protocol).

- Decision (2026-10-14, Eric, HITL "Answer keys for unjudged answers"): judged ids stay authoritative, and an answer nobody judged is graded by an answer key. Grading order: the gold or an `also` id passes, a `no` id (judged blind not to answer, partials included) fails, and any other answer passes iff the page recall returned contains every phrase of one key alternative (case-insensitive, whitespace-collapsed). Result rows record `judged`. The trigger was the 5-case grader pilot of the new flow (`chat-recall-sets`, $0.006): real-20 answered message 1570, an issue-closing call whose text states the spend asked for. No pooling run had picked 1570, so the id grader failed it. Leave-one-run-out, a run answers a message no other run picked for 0–13% of its non-gold answers when rerun unchanged, and for 28–33% at seeds 32 or 0, so structural rounds would be under-credited most. Every real spec must carry a key. `realCases` rejects phrases under 3 characters or made only of digits and punctuation, and a key that misses the gold or an `also` page or matches a `no` page. Keys are drafted from the question and the gold and `also` texts, without run results. Each key was then scanned against every message of its store. The 82 messages a key matched outside the judged sets were judged blind, which added 30 `also` ids, among them real-20's 1570. The 52 judged non-answers that a key matched (in 14 cases) got a second, independent judge. The two judges disagreed on 3; adjudication made real-54 267 and 269 yes and left real-36 672 a non-answer. real-18 616 became yes because its text matches 599, which Eric approved, apart from a line-number marker. The keys were then tightened until no key matches a judged non-answer or any unjudged message. Final sets: 92 `also` ids over 36 cases, 1,246 `no` ids, 60 keys. On these frozen snapshots a key therefore never passes an unjudged answer. An unjudged answer fails, and the `judged` row field counts how often that happens. Rescoring the recorded runs moved, for example, the seeds-8 pooling run from 22/84 to 35/84 real rows, with no unjudged answers. Date/Author: 2026-10-14 / Eric (decision), agent (implementation).

- Decision (2026-10-15 UTC, Eric, chat, after the `chat-recall-sets` climb plateaued): "I delegate to you sir", so the remaining recall-flow calls are the agent's. "latest model is fine" / "jev judge latest i mean": the judge role stays `openrouter/~typesafe/jev-latest`, unpinned. Every `chat-recall-sets` run (baseline, v1–v3) was served `typesafe/jev-1.14-20261014`, so the rounds compare like with like; the approved plan's "typesafe/jev-1.13" names the model the flow was planned on, and this supersedes it. "sonnet for smol compressor model is fine too 5.5": the `smol` role, which `~/.omp/agent/config.yml` maps to `anthropic/claude-sonnet-5-5` since 2026-10-14 21:23 UTC, stays the compressor. "happy to double budget dw": the eval budget doubles from $5 to $10. Date/Author: 2026-10-15 / Eric.

- Decision (2026-10-16, agent, under Eric's delegation; pre-registered before any fresh data exists): the `chat-recall-sets` gate reverted v4 (train +16 of 108 rows, test +3 of 72), so v4 is not adopted on that evidence. Its three mechanisms carry no case content and cost about the same as the baseline, so instead of overriding the gate it gets one confirmation on fresh real questions. About 60 new real cases are written blind from the four snapshots by authors who never see recall behaviour, under the 2026-10-14 authoring rules; no gold is a gold or `also` of the 60 flow cases or within 2 messages of one. Each fresh case runs 3 times per arm: HEAD, and HEAD with `.omp/ratchet/chat-recall-sets/v4/change.patch`, seeds 8, k 1. Every distinct non-gold answer is judged blind against the question and the gold's text, with arm and run hidden, as yes, partial or no; a row passes on the gold or a yes. The same assessor checks each fresh gold, and a case whose gold does not answer its question (`gold_ok: false`) is dropped from both arms. Primary test: a one-sided sign test over cases on the per-case pass-rate difference (v4 minus baseline), pooling the 36 flow test cases (flow grader, 2 reps per arm) with the fresh cases. Adopt v4 if p < 0.05 and v4's fresh-set pass rate is not below the baseline's; otherwise drop v4 and keep the baseline. Jev spend cap for the confirmation: $1. Date/Author: 2026-10-16 / agent.

## Outcomes & Retrospective

2026-10-11, retrieval (0.7.0): in a synthetic tree with a rule-based summariser and a lexical fake judge, every summary-navigating strategy found only the facts whose topic survived in the view (3/12 and 5/12 over two seeds), and `chat_search` found 12/12 in 24 calls and about 8.5 KB. `chat_recall` reached the surviving facts in one agent step instead of about 200 zoom calls. This measures navigation mechanics, not Jev or real summaries; no quality or cost claim follows from it.

Partly done as of 2026-10-11, see Progress for each milestone and the open items. This plan was rewritten on 2026-10-11 against omp-optchat 0.5.0 at HEAD `bc633ac`, and against the uncommitted working tree as it stood that day. When each milestone lands, add a paragraph here saying what now works, what the observed behaviour was on a real host, and what remains.

2026-10-13, Milestone 6 real-host run. Setup: omp 18.10.3 in RPC mode with `--no-extensions -e` of HEAD eb3c8b8 in a detached worktree, `--model anthropic/claude-haiku-5-5`, `--optchat-dir` pointing at a copy of the global store (1679 messages, 229 view lines, merged levels 1-6), sessions in a temp directory. Evidence sources: the status notifications captured from `/optchat` prompts, `model_usage` rows in the session files, `ledger.jsonl` ops and the stream line counts. The first attempt stopped on a driver error after 13 judge rows and its artifacts were kept aside; the rerun is the one reported.

Usage was journaled: 42 `optchat-*` rows in total (attempt 1: 13, rerun: 29), all with stop reason `stop`, all with the host's judge role and model. Gate counters in the rerun read 41 judgments; the 12 with no row are rules 3 and prefetch 9, exactly the turns that repeat attempt 1's messages on the same store. The host's judgment cache answers a repeated question about an identical state without a provider request, and by its documented contract it journals nothing. [INFERENCE from the matching counts and the cache contract; not observed directly.] So the status counters count cache answers as calls, and the rows count billed calls only.

Prefetch block bytes per user turn, from the `prefetch counts ... bytes` delta: 0 for the first three turns; 7155 for the prefetch-topic turn (one block); 6915 for the recall turn (one block); 0 for the long turn, which found no line worth a block. Each user turn with a merged view made three prefetch judgments. This is the uncached cost of the block per turn.

Rules: the British rule added one rule (add op, 116-byte notify); the American message replaced it (replace op, 127-byte notify); `/optchat rules` listed one active rule (78-byte notify); removing it wrote a remove op. The ledger ended with add 1, replace 1, remove 1. Each user turn made one rules judgment.

Recall: one `chat_recall` call, on the recall turn. Its result was `found` with a 5-line path: one view line of 16 messages, then four descent levels to a single message of 78 bytes. That message's kind is `echo` and it contains none of the probe's keywords, so the recall answer is probably wrong, and judge quality stays an open item. Judge requests for that call: 9 journaled; by input size, 4 are scoring batches over 64-line groups and 5 are small choices [INFERENCE from input sizes].

Value hints: 9 judgments, all `stop` (completed; none aborted). The first was before the first user turn. The status counter read 8 hints and 0 failures in the rerun.

Discrepancy with the README: the Cost paragraph says a user message costs up to two judge requests (rules, then prefetch). Observed: one rules judgment and three prefetch judgments per user turn with a merged view, so four journaled requests on an uncached turn. Not changed here: this milestone measures, it does not edit docs.

All-gates-off session: `/optchat status` printed no gate lines; no `ledger.jsonl` was created at any step, so the stated rules left no trace; zero `optchat-*` rows; `chat_recall` absent from the 19 tools `get_state` lists (the ON session lists 20, with it). `/optchat rules` replied in 118 bytes. Every prompt completed.

Judge calls spent: 42 billed of the 150 budget (13 attempt 1, 29 rerun); 0 in the OFF session. The agent ran three bash calls on the prefetch-topic turn; these are agent-initiated, not gate calls. The judge model in the rows is `~typesafe/jev-latest` via OpenRouter, not the native `typesafe/jev-1.13` of the 2026-10-12 foundation note.

2026-10-14, compressor head guard (0.9.2) on live stores. This session's OMP process started at 12:07:49 UTC, but its session log records a `session_exit` with reason `dispose` at 21:17:42, after which the session ran the installed 0.9.2 plugin. Lines were split at that point by the date of the last message each line covers. Free nodes (a leaf equal to its record, a merge containing both children word for word) are left out, and heads are counted with the guard's own `replyHead` from `src/memory.ts`. Before: 1296 compressor lines, 828 (63.9%) open with a head the guard detects. After, to 21:49:55: 161 lines, 0 detected. A second live session in another repository, started at 21:20:16 on 0.9.2, wrote 86 lines with 1 detected head, a level-4 merge stored because none of its tries came back clean. So the guard works for the heads it knows. It does not know openings that name the line's own message ids in prose, with no colon, pipe, tag or parenthesis after them (shapes such as "Message N records ...", "Compaction N ran ...", "N Finding: ...", "N ← ...", "N+ tool: ..."), or colon-less commentary ("Compressed to one line, ≤512 bytes."). Those were 3.1% of this session's lines before 0.9.2 and 9.9% after, 29.1% in the second session, and 13.4% in an older store from 2026-10-13 on old code. Whether the retry pushes heads into these shapes is not shown, since the store keeps no rejected attempts. A check that the opening's first number lies in the line's own message range catches 15 of the 16 here and 22 of the 25 there, and every line it adds in this store's older lines names its own ids. Unknown: how many extra compressor calls the retry costs, because compressor calls are not journaled as `model_usage` rows. Before 0.9.2, 64% of this session's compactions began with a detected head, so about that share now needs at least one more call [INFERENCE].

2026-10-14, `chat_recall` re-measured on the frozen `chat-recall-descent` split: 48 cases (30 synthetic, 18 real), 29 train and 19 test, 2 reps, judge `typesafe/jev-1.13-20260917`, HEAD 8ab90ec with a clean tree. The flow's recorded rounds predate the 0.9.0 seeds. Mean pass rate per case: old baseline (2026-10-12) train 0.241, test 0.053, real 0.111; now with `--seeds 0` (the old behaviour) train 0.328, test 0.053, real 0.139; now with the default 8 seeds train 0.724, test 0.632, real 0.333. On the test split the seeds turn 12 cases from fail to pass on both reps and 1 from pass to fail. The control matches the old test score exactly (2 of 38 rows), so the gain comes from the seeds. Real cases stay weak: 1 of 7 real test cases passes, and all 24 real misses answered a wrong message rather than finding none. Spend: $0.068 and 293 judge calls with seeds, $0.058 and 369 without, under a 1000-call cap per run, 0 errors. Results are in `~/.cache/omp-optchat-evals/recall/remeasure-2026-10-14-seeds{8,0}/`, outside git. More wording rounds need a new flow on current code, because this flow's baseline and rounds measured the old descent.

2026-10-15, `chat-recall-sets` climb: 90 cases (60 real, 30 synthetic), frozen split 54 train / 36 test (seed 2130230540), 2 reps, seeds 8, k 1; every row was served `typesafe/jev-1.14-20261014`. Baseline: train 0.620 ±0.124, test 0.694 ±0.153 (real rows 34/72 train, 26/48 test); 180 rows, 0 errors, 898 judge calls, $0.22, latency p50 0.6 s, p90 1.7 s. Three unattended rounds, each reverted by the gate: v1, one head-to-head choice among near-tied top lines (within 0.08, at most 6), train 0.676, test 0.667; v2, raw text for single-message view lines that word search hits, train 0.694, test 0.625; v3, length-normalized re-ranking of the word-search pool, train 0.704, test 0.708, no change beyond noise. Each raised train passes by 6 to 9 of 108 rows and moved test by −5 to +1 of 72 rows, so the flow plateaued after 3 flat rounds, at $0.90. The ratchet's stall rubric over the 41 failing baseline train attempts (Jev, $0.0027) said 37 structural, 3 grader and 1 variance; on reading, the 3 grader verdicts (each under 0.4 confidence) are true failures, so every miss is structural. From the traces: in 18 the answer message was itself a scored candidate but another line scored higher (the answer ranked 2nd to 6th in 11, mostly within 0.08 of a top score in the 0.8–0.97 band); in 18 the answer never became a candidate, and in 13 of those the view line covering it ranked 2nd to 4th while recall descended only from the top line; in 3 the descent chose the wrong half under the right line; 2 synthetic attempts reached no line at recall-min. The held-out split resolves about ±15 points, so a fix for one class (6 to 9 train rows) cannot show on it. A breadth round followed (v4, the analyzer told the classes above): a flat scan that scores every built leaf under the top 4 lines at recall-min (at most 256 leaves) instead of the halving descent, v3's seed re-ranking, and one side-by-side choice among single-message candidates within 0.1 of the best (at most 8). Its first proposal failed the loop's pre-run check and its repair came back with absolute paths, which the loop refuses; the second proposal ran. Train 0.769 ±0.106 (real 49/72), test 0.736 ±0.143 (real 29/48), 925 judge calls, $0.233, latency p50 0.82 s, p90 1.81 s, 0 errors. The gate reverted it: "overfit suspect: train improved but test is flat vs baseline". It is the best round on both splits, but its test gain (+3 of 72 rows) is inside the noise. Flow spend $1.13.

## Context and Orientation

The repository layout for omp-optchat is as follows. `src/index.ts` is the extension factory, `createOptChat`, which OMP calls for each session. It registers flags, the `context` hook that builds each request, the `tool_result` hook that caps and logs tool output, and the `/optchat` command. `src/config.ts` declares flags with `registerFlag`, reads them with `readConfig`, and defines `DEFAULTS`. `src/memory.ts` holds the class `Memory`, which owns the view, the compaction pump and the zoom and date functions. `src/store.ts` holds the durable log, the tree of nodes and the lease. `src/cache.ts` places prompt-cache markers. `src/handoff.ts` defines the `zoom`, `date` and `work` tools. `src/prompts.ts` holds the system and compaction prompts. `src/archive.ts`, `src/history.ts` and `src/export-file.ts` handle images, export and import. Tests live in `tests/`, including `tests/memory.test.ts`, `tests/cache.test.ts`, `tests/config.test.ts` and `tests/integration.test.ts`. `scripts/smoke.ts` runs a real OMP host with a loopback model.

Some terms used throughout this plan, defined here so that nothing else is needed.

OMP is the Oh My Pi coding agent, run as `omp`. A plugin is a package that OMP loads; omp-optchat and omp-jevify are plugins. An extension is the code a plugin provides; `omp.extensions` in a plugin's package.json names its entry file. An extension registers flags, event handlers and commands on an object called `pi` (an `ExtensionAPI`). Each handler receives a context object `ctx` (an `ExtensionContext`), which carries `ctx.ui` (for `notify` and `confirm`), `ctx.model`, `ctx.modelRegistry` and `ctx.sessionManager`. A flag is a command-line option such as `--optchat-rules`, read through `pi.getFlag`.

A model role is a name OMP maps to a model. The roles include `default`, `smol`, `slow`, `task` and `judge`. A selector such as `@smol` means the model for the role `smol`. The host configuration sets `judge` to `openrouter/~typesafe/jev-latest`, which is Jev.

Jev is a System One model from TypeSafe AI. It takes text and typed questions and returns typed answers in one pass. It never writes prose. A judgment is one request to a judge model with a `state` (a string or a JSON value) and a map of named questions. The host's pi-ai library defines three question kinds. A `choice` question has `instructions` and `criteria`, an object mapping each label to a rubric string or `null`; its answer has `choice`, `probabilities` keyed by label, and `confidence`. A `noul` question has `instructions` and optional `criteria` with `true` and `false` descriptions; its answer carries the probability of "yes" under the key `noul`. A `score` question has `instructions` and `criteria`, an ordered list of level names from lowest to highest; its answer has `score`, `probabilities` and `confidence`. Read `@oh-my-pi/pi-ai` `src/judgment/types.ts` before coding against these shapes, because the exact field names are the contract of the host.

The judge role chain is the host's ordered list of candidates for the `judge` role. A native candidate is the Jev backend, reached through OpenRouter or TypeSafe. The host's function `resolveJudge({settings, registry, sessionModel, sessionId, purpose, onUsage, cache})` returns a `ChainJudge` that tries the candidates in order. Once a native candidate appears, only native candidates follow it. Account rejections (401, 403, 402) skip a candidate for five minutes. Aborts and timeouts propagate at once. `ChainJudge.primaryModel()` names the first candidate. `hasNativeJudge(settings, registry)` says whether the first candidate is native. All of these are exported from the subpath `@oh-my-pi/pi-coding-agent/judgment`. `settings` is exported from the package root. `journalJudgmentUsage(manager)` returns a callback that records each billed judgment as a `model_usage` entry in the session, and `sharedJudgmentCache()` returns the host's answer cache.

The view is the list of summary lines covering the whole chat, as the agent sees it each turn. A part is one line of the view, with a level `l` and an index `i`. A part at level `l` covers `2^l` messages starting at message `i · 2^l`. A node is the stored text of a part. A free node is a node whose source already fits in `nodeBytes` (512 bytes) and is stored verbatim with no compaction call. Settle means waiting until every view line has a node. A zoom opens a line into its two children, or, for a single message, returns the message. The compaction pump builds nodes in the background. omp-optchat calls the component that writes summaries the "compressor" in its code, its flags and its tests; this plan and the kit's documents call it the compactor. They are the same thing.

A turn is one agent call that answers one user message. It is opened by the `context` hook when the host asks for the request's messages. `Turn` in src/index.ts holds the frozen view blocks for that turn. The `context` hook returns the view as the leading message, followed by the messages of this turn. This plan adds two more messages between them: the rules block and the prefetch block. Each is a user message, and each is present only when its gate is on and produces something.

The rules ledger is the durable list of standing rules, stored in the store directory. A rule is a standing instruction or preference the user gave, such as "answer in British English", that should hold until the user changes it. Triage is the background step that decides whether a new user message is a rule and whether it replaces an existing one. Prefetch is the step that, before a turn, asks Jev which view lines are relevant to the new message and zooms the best ones. A hint is a short sentence passed to the compactor to say what to protect in a message. The tool gate is the step that screens a tool call before it runs.

Prompt caching means the provider stores the start of a request and charges less to reread it. A cache marker says where a stored prefix ends. src/cache.ts places up to four markers on the view. Anything before the first changed byte must be paid for again. This is why per-turn blocks go after the view.

A flag value that is malformed must fail closed. omp-optchat already does this: `readConfig` throws an error with a static message, and the session refuses prompts until restart (HEAD src/index.ts:510-516). The new flags follow the same rule.

The in-flight draft. At the time of writing, the main omp-optchat checkout had uncommitted edits by another agent that add the flags, the `hint` option, and four modules under `src/system1/`: `judge.ts`, `ledger.ts`, `prefetch.ts` and `rules.ts`. The draft's `src/index.ts` already adds a `rules` command and session wiring (see Surprises). The plan treats the draft as unreviewed. Milestone 1 says how to read it and what to adopt. Do not copy the draft into the worktree without reading it and running this plan's tests against it.

Documents that support this plan, ported into this repository on 2026-10-11. `docs/research/omp-capabilities.md` is the audit with file and line citations for every OMP fact used here. `docs/design/optchat-jev.md` is the design in plain words. The eval references are `docs/evals/rubric.md`, `docs/evals/schemas.md` and `docs/evals/autoresearch-loop.md`, and they are out of scope for this plan.

## Plan of Work

The work runs in seven milestones, numbered 0 to 6. Do them in order. Each ends with a result you can run and observe, and each has its own acceptance. A milestone may be split into smaller commits, but none is complete until its acceptance passes.

### As built (2026-10-11)

See Progress for each milestone's state and Surprises for file:line evidence of each deviation. Summary: M1 done; M2, M3, M4 and M5 implemented with unit tests, open items listed in Progress; M6 has the live smoke with all gates on (a partial run), and the docs. The golden test (M0) and the cache test (M2) are not written.

### Milestone 0: baseline, worktree, and the byte-identity golden

Goal: prove that the untouched version 0.5.0 builds, tests and smokes on this machine, record the evidence, and freeze the bytes that a session with all gates off must keep producing. Nothing in omp-optchat's behaviour changes in this milestone.

Create the worktree from HEAD. Do this from the main omp-optchat checkout, so the uncommitted draft is left where it is. The new worktree gets its own `node_modules`. The command is `git worktree add /srv/openclaw-data/home/ericjuta/.openclaw/workspace/repos/omp-optchat-system1 -b system1-gates bc633ac`. If the path already exists, run `git worktree list` first and reuse it rather than creating a second one. In the worktree, run `bun install --frozen-lockfile`.

Then run the three existing checks from the worktree root, and record their final lines in Artifacts and Notes. `bun test tests` must end with `0 fail`. `bun run typecheck` must exit 0. `OPTCHAT_SMOKE_OMP=/home/ericjuta/.bun/bin/omp bun run smoke` must exit 0. The smoke runs the installed `omp` CLI against the plugin with synthetic model responses (`scripts/smoke.ts` with `scripts/fixture-provider.ts`), including a child dispatch fixture. It does not call a real provider.

Next, add the golden test. Open `tests/integration.test.ts` at HEAD and find how a test drives the extension's `context` hook with a chat. Build a deterministic chat of 40 messages: alternate `user` and `talk` kinds, give each a fixed date, and use a fixed reply from a fake compactor so that every summary is deterministic. Call the `context` hook on the chat before a new user message and serialize the returned `messages` array as JSON with stable key order. Write the file to `tests/fixtures/system1-off.golden.json`. The new test `tests/system1-off.test.ts` must fail when the golden file is missing, so that nobody creates it silently. Generate the file once with an environment variable such as `OPTCHAT_WRITE_GOLDEN=1 bun test tests/system1-off.test.ts`, read it, and commit it. The golden is the byte baseline for the whole plan: every later milestone must leave this test passing with no change to the golden file.

Finally, check the real host once. In the worktree, run `PI_OPENAI_STATEFUL=0 /home/ericjuta/.bun/bin/omp -e . --optchat-dir /tmp/optchat-m0`, and inside the session type `/optchat status`. The first line must begin with `OptChat: ready`. Exit the session.

Acceptance for Milestone 0 is that the three checks pass and their final lines are recorded, that `tests/system1-off.test.ts` passes against the committed golden, and that `/optchat status` on the real host starts with `OptChat: ready`. A human can verify this by reading the recorded lines and running the one-line status check.

### Milestone 1: the judge seam, flags, and status lines

Goal: add the configuration, the injection point, and the status display, with no judge calls yet. After this milestone, the gates exist as flags that report their state and do nothing.

Read the uncommitted draft first, without copying it. Run `git -C <main checkout> diff -- src/config.ts` and read the file `src/system1/judge.ts` in the main checkout. Decide, file by file, whether to adopt, rewrite or drop each part, and record the decision in the Decision Log under the heading "Reconciliation". Adopt only what passes the tests added in this milestone.

In `src/config.ts`, add the seven flags listed in the contract, with the names `--optchat-rules`, `--optchat-prefetch`, `--optchat-value-score` and `--optchat-tool-gate` as booleans defaulting to false, and `--optchat-rule-add` (default 0.8), `--optchat-prefetch-k` (default 8, from 1 to 32), `--optchat-prefetch-min` (default 0.5) and `--optchat-tool-ask` (default 0.3) as decimal strings. Probabilities must lie in the interval (0, 1]. A malformed probability, or a `--optchat-prefetch-k` outside its range, throws a static message such as `OptChat --optchat-rule-add must be a probability in (0, 1]`, following the pattern of `invalid()` in src/config.ts. Add a `GateConfig` record with the fields `rules`, `prefetch`, `valueScore`, `toolGate`, `ruleAdd`, `prefetchK`, `prefetchMin` and `toolAsk`, and make `OptChatConfig` carry it as `gates`. Keep `readConfig` pure, so a test can call it with a fake flag reader.

In `src/system1/judge.ts`, write a function `hostJudge(ctx, purpose)` that returns a `ChainJudge`. It calls `resolveJudge` with `settings` (the exported singleton), `registry: ctx.modelRegistry`, `sessionModel: ctx.model`, `sessionId` from `ctx.sessionManager.getSessionId()`, the given `purpose`, `onUsage: journalJudgmentUsage(ctx.sessionManager)`, and `cache: sharedJudgmentCache()`. Also write a function that splits a list of items into chunks under a byte limit and an item-count limit, which Milestones 2 and 3 use; put it in its own file `src/system1/chunk.ts` so it can be tested alone. The chunk function must never split an item, must never produce an empty chunk, and must count UTF-8 bytes.

In `src/index.ts`, add `judge?: (ctx: ExtensionContext, purpose: string) => Judge | undefined` to `OptChatOptions`, with the default `hostJudge`. Read the gate flags in `session_start`, where the other flags are read (src/index.ts:1443 and 1463), and not in the factory. Extend `statusText()` (src/index.ts:1384) with one line per gate. Each line says whether the gate is on or off. When a gate is on, it also reports the judge's primary model, or says that none was resolved. Call `ChainJudge.primaryModel()` on a judge built by `hostJudge`, and report `hasNativeJudge` as a yes or no. Each gate line also shows the gate's last outcome and last failure. Both start as "none yet". Keep every line under 160 characters, and never include provider text.

Write tests. In `tests/config.test.ts`, check that the defaults are false and the thresholds are the documented values, that each malformed probability fails with a static message, and that `--optchat-prefetch-k 0` fails. Add `tests/system1-judge.test.ts` with a fake `ctx` whose `sessionManager` lacks `appendModelUsage`, and check that `journalJudgmentUsage` returns `undefined` for it, that the judge factory produces no network call when the chain is empty, and that chunks respect both limits. Add a test that with all gates off, the golden test from Milestone 0 still passes.

Measure the journaling question. In the test environment, a fake session manager with `appendModelUsage` should cause a journaled entry, and the real host check in Milestone 6 decides whether the real one does. Record the result in Surprises.

Acceptance for Milestone 1: `bun test tests` passes, including the unchanged golden test. `bun run typecheck` passes. On the real host, `PI_OPENAI_STATEFUL=0 /home/ericjuta/.bun/bin/omp -e . --optchat-dir /tmp/optchat-m1 --optchat-rules --optchat-tool-gate`, followed by `/optchat status`, shows a gate line for rules reading `on` and for tool gate reading `on`, and the two gates not passed on the command line read `off`. The judge line shows the primary model or "none resolved", and no judge request is made, which can be checked by the absence of any `model_usage` entry.

### Milestone 2: the rules ledger

Goal: detect standing rules in human-typed messages, record them durably, announce them, and show them to the agent after the view on every later turn, with commands to list and remove them.

Write `src/system1/ledger.ts`. It opens `ledger.jsonl` in the store directory, which is the directory `config.directory` already names. Each event is one JSON line with the fields `op` (`add`, `replace` or `remove`), `id`, `text` (for `add` and `replace`), `source` (the message id), and `at` (an ISO timestamp). Append each line with a single write and an fsync, following the rules in `writeDurably` (src/store.ts:404-410). On replay, skip a torn final line, report it through the same channel the log uses, and never rewrite the file. A rule id is `r` followed by a counter that starts at 1 and is one more than the largest number ever used in the file, so a removed id is never reused. The ledger exposes `active()` returning the active rules in id order, `add(text, source)`, `replace(id, text, source)`, `remove(id)`, and `render()` returning the rules block or `undefined` when there are no rules.

The rule text is the user's message, cut to 512 bytes at a UTF-8 character boundary. When it is cut, append the marker " (zoom <id> for the rest)", where `<id>` is the message id. Use the helper `utf8Prefix` from src/memory.ts (line 86), or a copy of it, and test that it never splits a character.

Write `src/system1/rules.ts`. Build the triage request for one message. The state is `{message: text}`, where the text is capped at 4,000 bytes. The questions are a `noul` question with key `rule` and instructions "The message holds a standing instruction or preference meant to hold for future replies, not a one-off request." When there are active rules, add a `choice` question with key `supersedes`, whose criteria are the 64 most recent active rules, each labelled by its id and given its text cut to 200 bytes as the rubric, plus the label `none` with a null rubric. The decision function takes the answers and returns one of three results: nothing, add, or replace with an id. Use this logic. If the `rule` probability is below `ruleAdd`, return nothing. Otherwise, if `supersedes` is a rule id and its probability is at least 0.5, return replace with that id. Otherwise return add.

Wire triage into the message path. Find the place in src/index.ts where a human-typed user message is appended to the log (search for `append("user"` and for the code that handles pending user text). Immediately after that append, if the rules gate is on and the message is eligible, queue a triage job. A message is eligible when its kind is `user`, it is not a skill prompt, it did not come from a side turn, and its attribution is the user. Queue the jobs on a single promise chain so that they run serially in log order, and catch every error inside the chain, so one failure never stops later triage. The job calls the judge through the factory with purpose `rules`. On a decision, append the event, and when `ctx.hasUI` is true, call `ctx.ui.notify` with a short message such as "Rule added: r2" or "Rule r2 replaced". Record the outcome for the status line. Triage must never block the turn.

Wire the rules block into the turn. When a turn opens (the method `openTurn` in src/index.ts), take the ledger's rendered block and store it in the turn as `extra`. The block is a single user message, placed after the view and before the turn's messages, so the `context` hook returns `[view, ...turn.extra, ...messages.slice(start)]`. When there are no rules, `extra` is empty, and the request is the same as before. The block's header line says the rules are standing instructions the user gave earlier, that the most recent rule wins where two conflict, and that a rule the user changes in this turn overrides it. Each rule line is `r<k> [<message id>] <text>`.

Add `/optchat rules` (lists the active rules, or says there are none) and `/optchat rules remove <id>` (appends a remove event and reports the result). The existing `/optchat` command handler has a switch on its first argument (HEAD src/index.ts:1361, with `export` at 1369 and `import` at 1372). Extend that switch.

Write tests in `tests/system1-ledger.test.ts` and `tests/system1-rules.test.ts`. The ledger tests check that an add survives a reload with the same id, that a replace keeps the id, that a remove keeps the id unused, that a torn final line is skipped and the next append begins on its own line, that the text cap respects UTF-8, and that the rendered block matches the format. The rules tests use a fake judge through `OptChatOptions.judge`. They check the three decisions, the eligibility skips (work, skill prompt, side turn), the serial ordering of two queued messages, that a judge error leaves the ledger unchanged and the turn still runs, and that the `context` output with a rule present is the golden output plus one user message after the view. Add a cache test in `tests/cache.test.ts` that places a rules message after a view and checks that the view's markers are the same as without it.

Acceptance for Milestone 2: the tests above pass, and the golden test still passes with all gates off. On the real host, `PI_OPENAI_STATEFUL=0 /home/ericjuta/.bun/bin/omp -e . --optchat-dir /tmp/optchat-m2 --optchat-rules` followed by the message "From now on, answer in British English." produces a visible notification "Rule added: r1" when a UI is present. `/optchat rules` then lists `r1` with the id of that message. A following message, "What is 17 times 3?", adds nothing, and `/optchat rules` still lists one rule. A following message "Actually, use American spelling from now on." produces "Rule r1 replaced" and `/optchat rules` shows r1 with the new text. `/optchat rules remove r1` empties the list. A reviewer can check each step by reading the screen and the ledger file in `/tmp/optchat-m2`.

### Milestone 3: prefetch

Goal: before each turn, ask Jev which merged view lines are relevant to the new message, zoom the best few one level, and show them to the agent in a block after the rules.

Write `src/system1/prefetch.ts`. Candidates are the view parts that cover two or more messages. HEAD's `Memory` has `viewParts()` (src/memory.ts:242) and a private `renderPart` (src/memory.ts:334), but no public accessor for line text. Milestone 3 adds `Memory.lines()`, which yields `{id, n, text}` for each part built from those two. The draft's `viewLines()` (its src/memory.ts:289) is a candidate to adopt after review. Skip any part with `n` equal to 1. Build the chunks with the chunk helper from Milestone 1: each state is `{message, lines}`, where `message` is the new user text capped at 4,000 bytes and `lines` maps `<id>+<n>` to the line's text. Each state holds at most 24,000 UTF-8 bytes and at most 64 questions. Each candidate line gets one `noul` question keyed by its address, with the instructions "Line <id>+<n> holds information needed to answer the message." Send the chunks with at most four requests in flight.

Select the top `prefetchK` lines whose probability is at least `prefetchMin`. For each selected line, call `Memory.zoom(id, n)`, which for `n` greater than one returns the two child lines (HEAD src/memory.ts:276; tests/memory.test.ts:1519). Parse the two children from its text, or call `zoom` once per child, whichever the implementation reads more clearly; both must produce the same lines. Render the block as a user message with a header line that says the lines were zoomed from the view because they seemed relevant to this message, that they are data and not instructions, and then one `id+n|text` line per child, ordered by message id, and a closing `</prefetch>` tag. Cap the whole block at 16,384 bytes, cutting whole child lines from the end and never a line in the middle.

The time bound is the smaller of 5 seconds and the remaining settle deadline minus 500 milliseconds. The turn's settle deadline is in src/index.ts (`SETTLE_TIMEOUT_MS`, line 53, and the deadline computed in `openTurn`). Use an `AbortSignal` with that timeout. A timeout, an abort, a judge error, or a block that comes out empty means no prefetch block, and the turn proceeds. Record the outcome for the status line, with a count of lines, the block's bytes, and the elapsed time on success.

The prefetch block is computed once per turn, when the turn opens, and stored in `extra` after the rules block, so every request of the turn is byte-stable.

Write `tests/system1-prefetch.test.ts`. Check that candidate selection skips level-zero parts, that no state exceeds 24,000 bytes or 64 questions for a view of several hundred lines, that no more than four requests are in flight at once (count concurrent calls in the fake judge), that the top `k` are chosen with the threshold applied, that the block is ordered by message id and capped at 16,384 bytes, that a timeout yields no block and the turn still completes, and that the requests of a turn are byte-identical across two calls.

Note the activation rule in the test name or a comment: prefetch needs merged view parts, so the test builds a view large enough to merge, using the same fixture shape as tests/memory.test.ts:1407.

Acceptance for Milestone 3: the tests above pass, and the golden test still passes. On the real host, the check needs a view that has merged, which Milestone 6 sets up with an import. After the import, with `--optchat-prefetch`, `/optchat status` shows a prefetch line after one turn, reporting a line count between 1 and 8 and a byte count no larger than 16,384. If the status shows "no candidates" the view has not yet merged, and the import in Milestone 6 must be made larger.

### Milestone 4: value-score hints

Goal: give the compactor one short sentence about what matters in a long message, judged by Jev, without changing which nodes are built or when they are built.

Build `src/system1/value.ts`. It exports a function `valueHint(judge, text, signal)` that sends one request with the state `{record: text}`, where the text is capped at 24,000 bytes. The questions are a `choice` question keyed `label` over `decision`, `preference`, `finding` and `noise`, each with a short rubric, and a `score` question keyed `importance` over `low`, `medium` and `high`. From the answers, pick the most probable label, and the most probable importance level. The function returns a sentence built from two closed phrase tables. The label phrases are "This is a decision", "This is a user preference", "This is a finding" and "This is low-value chatter". The importance phrases are "keep its specifics", "keep its main point" and "keep it short". The sentence is the label phrase, a semicolon, the importance phrase, and a full stop, for example "This is a decision; keep its specifics." No text from the model is ever returned, so judge output cannot inject instructions into the compaction prompt.

The `Memory` draft already has the `hint` option with the contract's signature, and it already bounds the call with `hintTimeoutMs` (default 2000) and turns any error into no hint (src/memory.ts:723-760). Keep that behaviour. The factory must pass a `hint` to `Memory` only when the value-score gate is on, and the hint callback calls `valueHint` with the judge from the factory and purpose `value`. When the gate is off, `Memory` receives no hint, and the code path is identical to HEAD.

Check that the draft's `hintFor()` does what the plan requires. It must be called only from the path that builds a level-zero leaf which is not a free node (src/memory.ts:660-667), and never for a merge. Its result must be inserted as one sentence into the compaction instruction, and must never change which nodes are built or their order. Confirm the sentence never contains an id, by checking the closed phrase tables.

Write `tests/system1-value.test.ts` and add cases to `tests/memory.test.ts`. Check that a free node causes no judge call, that a merge causes no judge call, that a non-free level-zero leaf causes exactly one judge call, that the sentence appears once in the compaction instruction and contains no `id+n` pattern, that a judge that hangs past two seconds yields no hint and the leaf still builds, and that the sequence of built nodes is the same with and without the hint for a fixed fake compactor. The last check is the one that proves the hint never changes which nodes are built or their order.

Acceptance for Milestone 4: the tests above pass, and the golden test still passes. On the real host, with `--optchat-value-score` and a message longer than 512 bytes, the status line for value score reports one hint call with its outcome. A hint that timed out is shown as a timeout count, not as an error.

### Milestone 5: tool gate (superseded 2026-10-13; the tool gate was removed)

Goal: screen each proposed tool call from the main agent with Jev, and ask the user or block the call when the risk is high. Fail closed when the judge cannot answer.

Find the exact shape of the `tool_call` event and of `ctx.agent` before writing code. Search the host source for the `tool_call` event type in `src/extensibility/extensions/types.ts` (the host source is in the `node_modules` of omp-optchat, as the research document explains), and read the fields it provides, including the tool name, the input, and the result shape for a block. Also read how `ctx.agent` distinguishes the main agent from a subagent. Write the code against what you read, and record the field names in the Decision Log.

Write `src/system1/tool-gate.ts`. It exports the exempt tool set, which holds `zoom`, `date`, `work`, `read`, `grep`, `glob`, `find`, `todo`, `ask`, `think` and `web_search`, and a function `screen(judge, call, cwd, signal)` that returns a verdict. The verdict is one of `allow`, `ask` or `block`, with a danger number and a reason. The request has the state `{tool, input, cwd}`, where `input` is the JSON of the call's input capped at 8,000 characters. The questions are a `choice` question keyed `risk` over `safe`, `risky` and `destructive`, and `noul` questions keyed `deletes`, `remote` and `shared`. The `deletes` question covers deleting, overwriting or truncating files or data. The `remote` question covers downloading and running remote code, or sending data to an outside service. The `shared` question covers acting on production, shared or remote systems, such as deploys, pushes, publishes and migrations. The danger is the maximum of the `risk` probability for `destructive`, `deletes`, `remote` and `shared`.

Register the handler in `src/index.ts` only when the tool gate flag is on. Register it inside the session-start path, so the flag value is known, and only for the main agent. For each `tool_call` event whose tool is not exempt, call `screen` with an 8-second bound. If the danger is below `toolAsk` (default 0.3), return nothing, and the call runs as it would without the gate. Otherwise, when `ctx.hasUI` is true, call `ctx.ui.confirm` with a title naming the tool and a message stating the danger value to two decimal places. On approval, return nothing. On decline, return a block with a reason stating that the user declined after a risk screen. Without a UI, return a block whose reason states the danger value and says the call needs the user's approval in an interactive session. A judge failure or timeout counts as an unanswered risk: with a UI, ask, and without one, block, with a reason that names the error class and nothing from the provider.

Confirm that a blocked call is logged. A blocked call should produce a `tool_result` event with an error, which the existing handler at src/index.ts:1482 logs as an `echo` line starting `[error] ` (src/index.ts:289). If a block emits no `tool_result`, add the echo line through the same logging path, and record that finding in Surprises.

Write `tests/system1-tool-gate.test.ts`. Check that each exempt tool makes zero judge calls, that a destructive call with a UI asks and then allows on approval, that a decline blocks with the declined reason, that a destructive call with no UI is blocked, that a judge throw with a UI asks and without a UI blocks, that a judge that exceeds 8 seconds is treated as a failure, that the `task` tool is screened on its arguments, and that a subagent's call is not screened.

Acceptance for Milestone 5: the tests above pass, and the golden test still passes. On the real host, with `--optchat-tool-gate`, ask the agent to remove a scratch directory that the test created, such as `/tmp/optchat-m5-scratch`. With a UI, a confirmation appears and the directory still exists after declining. With approval, it is removed, which is what the user asked. The status line for the tool gate reports the number of screened calls, and the number asked and blocked.

### Milestone 6: documentation, changelog, and the real-host run

Goal: document the flags and gates for users, record the changes, and demonstrate the whole feature on a real OMP host with all gates on, then once with all gates off.

Add a section titled "System One gates" to omp-optchat's README. It names each flag, its default, what it does, what it costs in judge calls, and how to see it in `/optchat status`. It says that prefetch needs a merged view, and that value hints apply only to messages longer than 512 bytes. Add an "Unreleased" entry to CHANGELOG.md listing the four gates and the new `/optchat rules` command. Do not change the version number in package.json.

Run the three standard checks again from the worktree root, and record their final lines: `bun test tests`, `bun run typecheck`, and `OPTCHAT_SMOKE_OMP=/home/ericjuta/.bun/bin/omp bun run smoke`. The smoke must still pass with all gates off.

Prepare an import file for the prefetch check. Read `src/history.ts` (around line 196, the importer) to learn the format it accepts. Write a script under `scripts/` only if the format needs generating more than once; otherwise write the file by hand in `/tmp` with a fixed seed. The file must hold at least 300 messages of about 600 bytes each, so that the view merges. Import it with `/optchat import <path>` in a fresh `--optchat-dir`. Expect some compaction calls to the `@smol` role, which cost money. Record the count from `/optchat status`.

Run the scripted session with all gates on. Start it with `PI_OPENAI_STATEFUL=0 /home/ericjuta/.bun/bin/omp -e . --optchat-dir /tmp/optchat-gates-demo --optchat-rules --optchat-prefetch --optchat-value-score --optchat-tool-gate` from the worktree root. Then, in order: check `/optchat status` for four gate lines reading `on` and a judge line naming the resolved primary model; say "From now on, answer in British English."; say "What is 17 times 3?"; say "Actually, use American spelling from now on."; run `/optchat rules`; ask the agent to remove `/tmp/optchat-gates-demo-scratch` with `rm -rf`; decline the confirmation; check that the directory still exists; then run one more turn about a topic that appears in the imported history and check the status line for prefetch. Record each observation in Artifacts and Notes, including the number of judge calls shown by session `model_usage` rows, and whether those rows exist. Stop once the number of judge calls reaches 40, as the Decision Log says.

Then run the same session with no gate flags, with `--optchat-dir /tmp/optchat-gates-off`, and confirm that `/optchat status` shows four gate lines reading `off`, that stating a rule adds nothing, and that the remove command finds the scratch directory gone or present as the user set it.

Acceptance for Milestone 6: the three checks pass, the README section and changelog entry exist, the scripted all-gates session shows each observation listed above, and the all-gates-off session shows no gate effect. Record in Outcomes whether the usage rows were journaled, and what the measured cost of the prefetch block was in bytes per turn.

## Concrete Steps

All commands run from the repository root. As built (2026-10-11), the gates were implemented in the main checkout, uncommitted, and the worktree steps below were not run. The steps are kept as the plan of record.

    cd /srv/openclaw-data/home/ericjuta/.openclaw/workspace/repos/omp-optchat
    git worktree list
    git worktree add /srv/openclaw-data/home/ericjuta/.openclaw/workspace/repos/omp-optchat-system1 -b system1-gates bc633ac
    cd /srv/openclaw-data/home/ericjuta/.openclaw/workspace/repos/omp-optchat-system1
    bun install --frozen-lockfile

The standard checks, run after each milestone:

    bun test tests
    bun run typecheck
    OPTCHAT_SMOKE_OMP=/home/ericjuta/.bun/bin/omp bun run smoke

Writing the golden file once, in Milestone 0:

    OPTCHAT_WRITE_GOLDEN=1 bun test tests/system1-off.test.ts
    bun test tests/system1-off.test.ts

A real-host session with all four gates on, in Milestone 6:

    PI_OPENAI_STATEFUL=0 /home/ericjuta/.bun/bin/omp -e . --optchat-dir /tmp/optchat-gates-demo --optchat-rules --optchat-prefetch --optchat-value-score --optchat-tool-gate

The same session with every gate off, which must match version 0.5.0:

    PI_OPENAI_STATEFUL=0 /home/ericjuta/.bun/bin/omp -e . --optchat-dir /tmp/optchat-gates-off

Inside an `omp` session, `/optchat status` prints the state; `/optchat view` prints the view; `/optchat rules` lists rules; `/optchat rules remove r1` removes one.

Expected first lines of the standard checks at baseline, to be replaced with the real numbers when Milestone 0 runs. These are the shape to look for, not promised values:

    bun test tests
     N pass
     0 fail

    bun run typecheck
    (exit 0, no output)

If a number of passing tests changes during later milestones, record the new number in Progress with the date, so the next reader can compare.

Update this section whenever a command changes or a new command is needed.

## Validation and Acceptance

The plan is complete when all of the following hold, and each can be checked by someone who has not read the code. `bun test tests` passes in the worktree, and its count is at least the baseline count from Milestone 0 plus the new tests in each milestone. `bun run typecheck` exits 0. `OPTCHAT_SMOKE_OMP=/home/ericjuta/.bun/bin/omp bun run smoke` exits 0. The golden test in `tests/system1-off.test.ts` passes against the golden file committed in Milestone 0, unchanged, which proves that a session with all gates off sends the same request bytes as version 0.5.0 for the fixed chat.

Each gate is observable on a real host. The rules gate announces a rule, lists it, replaces it and removes it, as described in Milestone 2. The prefetch gate reports candidate lines and bytes in `/optchat status` after a turn on a merged view, as described in Milestone 3. The value-score gate reports its hint calls and timeouts, as described in Milestone 4. The tool gate asks before a destructive removal and leaves the directory in place when declined, as described in Milestone 5. `/optchat status` shows four gate lines, each reading `on` or `off` as set, in both sessions of Milestone 6.

Each gate fails closed or fails open as the contract requires. A malformed flag refuses prompts with a static message. A judge timeout or error causes no rule, no prefetch block, and no hint, and the turn still completes. A tool-gate judge failure asks with a UI and blocks without one.

Whether the judgment usage reaches the session's `model_usage` rows is recorded as a finding, not assumed. If it does not, the plan is still complete, and the status line must say so.

## Idempotence and Recovery

The worktree step is safe to repeat: run `git worktree list` first, and reuse the path if it already exists. Do not delete the worktree to start over. Remove it with `git worktree remove` only after its branch is merged or abandoned, and never remove the main omp-optchat checkout, which holds another agent's uncommitted work.

The golden file is written once and then only read. If it must change, the change is a decision and must go into the Decision Log with the reason. Regenerating it silently to make a test pass defeats the purpose of the test.

The ledger is an append-only file. To reset a test chat, use a new `--optchat-dir` and leave the old directory in place. Never edit or delete `ledger.jsonl` or the log files in an existing store directory; move the directory aside instead. The same rule applies to the import file used in Milestone 6.

Every judge call is safe to repeat. A repeated judge call with the same state and questions is answered from the host's cache at no cost, so reruns of the real-host check are cheap, and their usage shows as cached.

If a real-host session crashes, the store is recoverable: the log and tree are replayed on the next start, and a stale lease is detected and taken over, as omp-optchat already does. If the status line reports `inactive`, another live session holds the directory; close it or use another `--optchat-dir`.

## Artifacts and Notes

The state of the omp-optchat main checkout at the time this plan was written, from `git status --short` and `git diff --stat`, is reproduced here so the next reader can see the starting point:

    ` M src/config.ts`
    ` M src/index.ts`
    ` M src/memory.ts`
    `?? src/system1/`
    `?? tests/helpers/fake-host.ts`
    `?? tests/helpers/fake-judge.ts`
    `?? tests/system1.test.ts`
     src/config.ts | 91 +++++
     src/index.ts | 276 (267 insertions, 9 deletions)
 src/memory.ts | 68 +++++-

The HEAD check for the hint hook, which must print `0` before Milestone 4 changes HEAD:

    git show HEAD:src/memory.ts | grep -c hint
    0

The merge rule as it stands at HEAD, from `coarsen()` in src/memory.ts (line 360):

    const age = (length - ((a.i + 2) * width - 1)) / width;

The test that pins it, tests/memory.test.ts:1287, is named "last-message age at T10 prefers 8+1|9+1 over 0+4|4+4".

Usage evidence, 2026-10-13, counts only (no message content): 42 `optchat-*` `model_usage` rows in the ON sessions, all `stop`, cost $0.0075 total: `optchat-rules` 6, `optchat-prefetch` 18, `optchat-value` 9, `optchat-recall` 9. Of these, 13 came from a first attempt that stopped on a driver bug after the rules-list step; 29 from the rerun. Zero `optchat-*` rows in the OFF session. No `optchat-tool-gate` rows, since the tool gate is gone. Gate counters for the rerun read 41 judgments against 29 journaled rows; the 12 missing are rules 3 and prefetch 9, the calls for the three turns identical to attempt 1 (see Outcomes). Evidence: `model_usage` rows in the session files, and `/optchat status` counters from RPC `prompt` of `/optchat status`.

## Interfaces and Dependencies

As built (2026-10-11), with file:line evidence. Where the planned names below differ, this block is the contract.

- `src/config.ts`: `DEFAULTS` holds the gates (`rules`, `prefetch`, `valueScore`, `toolGate` false; `ruleAdd` 0.8; `prefetchK` 8; `prefetchMin` 0.5; `toolAsk` 0.3) at lines 15-22. `GateConfig` is `{rules, prefetch, valueScore, toolGate, ruleAdd, prefetchK, prefetchMin, toolAsk}` (39-52), and `OptChatConfig.gates` is at line 35. Flags: `--optchat-rules`, `--optchat-prefetch`, `--optchat-value-score`, `--optchat-tool-gate` (boolean); `--optchat-rule-add`, `--optchat-prefetch-k`, `--optchat-prefetch-min`, `--optchat-tool-ask` (strings), at 108-147. `toolGateRequested(api)` is at 166.
- `src/system1/judge.ts`: `JudgeFactory = (ctx, purpose) => Judge | undefined`; `NamedJudge` (`primaryModel()`); `hostJudge(ctx, purpose)` returns `undefined` when there is no primary model or resolution throws (28-31); `utf8Length`; `packByBytes(items, base, entryBytes, budget, maxCount)`; `boundedGateError`; `judgeWithin(judge, request, ms, parent?)`.
- `src/system1/ledger.ts`: `Rule {id, text, source, at: number}`; class `RuleLedger` with `static open(directory)`, `active()`, `add(source, text, at)`, `replace(replaces, source, text, at)`, `remove(id, at)`, `close()`; `clipRule(text, source)`; `renderRules(rules)`. File `ledger.jsonl`.
- `src/system1/rules.ts`: `triageState(message)`; `offeredRules(active)` (newest 32); `triageQuestions(offered)`; `decideTriage(answers, offered, ruleAdd)` returns `none`, `add` or `replace` with `replaces`.
- `src/system1/prefetch.ts`: `prefetchBlock(memory, {judge, message, k, min, timeoutMs?, signal?})` returns `Promise<string | undefined>`. Constants: message 4,000 bytes; state 24,000 bytes; 64 questions; 4 in flight; block 16,384 bytes; 5,000 ms.
- `src/system1/value.ts`: `valueHint(judge, {kind, text}, signal)` returns `Promise<string | undefined>`.
- `src/system1/tool-gate.ts`: `EXEMPT_TOOLS`; `dangerOf(risk, deletes, remote, shared)`; `gateToolCall({toolName, input, cwd}, {judge, toolAsk, ui: {hasUI, confirm}, timeoutMs?, report?})` returns `Promise<ToolCallEventResult | undefined>`.
- `src/index.ts`: `OptChatOptions.judge?: JudgeFactory` (111); `Turn.extra: UserMessage[]` (412); `TRIAGE_MS` 20 s (85); `SHUTDOWN_TRIAGE_MS` 1.5 s (90); `PREFETCH_MARGIN_MS` 500 ms (92).
- `src/memory.ts`: `MemoryOptions.hint` (36-39), `hintTimeoutMs` (41), `viewLines()` (289).

Planned names not built: `src/system1/chunk.ts` and `chunkByBytesAndCount` (use `packByBytes`); `openLedger`, `Ledger` and `render()`; `triageRequest`; `prefetchCandidates`, `prefetchRequests` and `renderPrefetch`; `screenToolCall` and `Verdict`.

The planned names below are the plan's original intent.

Dependencies are the existing ones, plus nothing new. The plugin depends on `@oh-my-pi/pi-coding-agent` (for `ExtensionAPI`, `ExtensionContext`, and the `settings` singleton), `@oh-my-pi/pi-coding-agent/judgment` (for `resolveJudge`, `journalJudgmentUsage`, `sharedJudgmentCache`, `hasNativeJudge`), and `@oh-my-pi/pi-ai` (for the `Judge` type, which is re-exported from its root). Do not add an HTTP client or an SDK for any model provider.

In `src/config.ts`, the flags are registered in the function `registerFlags`, and the gate record is:

    export interface GateConfig {
      rules: boolean;
      prefetch: boolean;
      valueScore: boolean;
      toolGate: boolean;
      ruleAdd: number;
      prefetchK: number;
      prefetchMin: number;
      toolAsk: number;
    }

and `OptChatConfig` gains `gates: GateConfig`.

In `src/system1/judge.ts`, the factory type and the default are:

    export type JudgeFactory = (ctx: ExtensionContext, purpose: string) => Judge | undefined;
    export function hostJudge(ctx: ExtensionContext, purpose: string): ChainJudge;

`OptChatOptions` in src/index.ts gains `judge?: JudgeFactory`, and the default is `hostJudge`.

In `src/system1/chunk.ts`, the helper is:

    export function chunkByBytesAndCount<T>(items: readonly T[], size: (item: T) => number, maxBytes: number, maxCount: number): T[][];

It never splits an item and never returns an empty chunk.

In `src/system1/ledger.ts`, the ledger is:

    export interface Rule { id: string; text: string; source: number; at: string }
    export interface Ledger {
      active(): readonly Rule[];
      add(text: string, source: number): Rule;
      replace(id: string, text: string, source: number): Rule;
      remove(id: string): boolean;
      render(): string | undefined;
    }
    export function openLedger(directory: string): Ledger;

In `src/system1/rules.ts`, the triage functions are:

    export type TriageDecision = { kind: "none" } | { kind: "add" } | { kind: "replace"; id: string };
    export function triageRequest(text: string, active: readonly Rule[]): { state: unknown; questions: Record<string, unknown> };
    export function decideTriage(answers: Record<string, unknown>, active: readonly Rule[], ruleAdd: number): TriageDecision;

In `src/system1/prefetch.ts`, the prefetch functions are:

    export function prefetchCandidates(lines: ReadonlyArray<{ id: number; n: number; text: string }>): Candidate[];
    export function prefetchRequests(message: string, candidates: readonly Candidate[]): Array<{ state: unknown; questions: Record<string, unknown> }>;
    export function renderPrefetch(children: ReadonlyArray<{ id: number; n: number; text: string }>): string;

In `src/system1/value.ts`, the hint function is:

    export function valueHint(judge: Judge, text: string, signal: AbortSignal): Promise<string | undefined>;

It returns only one of the closed template sentences, or `undefined`.

In `src/system1/tool-gate.ts`, the screen is:

    export const EXEMPT_TOOLS: ReadonlySet<string>;
    export type Verdict = { verdict: "allow" } | { verdict: "ask" | "block"; danger: number; reason: string };
    export function screenToolCall(judge: Judge, call: { tool: string; input: unknown }, cwd: string, toolAsk: number, signal: AbortSignal): Promise<Verdict>;

In `src/memory.ts`, the existing `MemoryOptions.hint` and `hintTimeoutMs` stay as the draft defines them, with the signature `hint?: (source: { kind: Kind; text: string }, signal: AbortSignal) => Promise<string | undefined>`.

The `Turn` type in src/index.ts gains `extra: UserMessage[]`, computed when the turn opens. The `context` hook returns `[view, ...turn.extra, ...messages.slice(start)]`, which is exactly the old result when `extra` is empty.

The exact field names of the judgment answers, the `tool_call` event, and `ctx.agent` must be taken from the host's type declarations, as Milestones 1 and 5 say. The names above are the plan's intent, and an implementer may rename a helper, but must keep the behaviour and the tests.

## Revision notes

- 2026-10-11 (port and progress): the planning kit was ported into omp-optchat (`AGENTS.md`, `plans/`, `docs/`, `.scratch/`, `vendor/`, `.omp/skills/`, `.agent/`), with repository-relative paths. Progress reflects the implementer's report and the main agent's live run. The Interfaces section has an as-built block, and Surprises and Decision Log record each deviation with file:line evidence. Nothing is committed. The golden test and the cache test are still missing.

- 2026-10-11: Rewritten against the kit's contract (`local://system-one-contract.md`) and the audit in `docs/research/omp-capabilities.md`. Each superseded value is cited to a surviving kit file or to the brief. It builds the gates into omp-optchat behind flags, reaches Jev through the host judge role, removes the eval harness and the autoresearch loop from scope, and records the superseded decisions in the Decision Log. It also records what the audit found that the contract did not anticipate: the uncommitted sibling draft in the main checkout, the existing `Memory.hint` option in that draft, the merge rule pinned by a test, the activation threshold for prefetch, and the limits of journaling and speculation.
