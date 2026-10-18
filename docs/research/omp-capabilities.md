# OMP capabilities audit for OptChat + Jev

Audit date: 2026-10-11. Purpose: record what Oh My Pi (OMP) and the installed plugins already provide, so the planning kit (ported into this repo on 2026-10-11) builds on them instead of rebuilding them. Every row names its source as `path:line`, or is tagged `[INFERENCE]` when it is a conclusion not read directly from source or observed at runtime. Claims read from source are "source-read"; the few observed by running something say "runtime-observed".

Path abbreviations used below:

    HOST     /srv/openclaw-data/home/ericjuta/.openclaw/workspace/repos/omp-optchat/node_modules/@oh-my-pi/pi-coding-agent/src
             OMP 18.9.1 source (../package.json:3). The copy under ~/.omp/plugins/node_modules is a stale 18.1.22
             and has no src/judgment; it does not matter at runtime because plugin imports of @oh-my-pi/* resolve
             to the host bundle (HOST/extensibility/plugins/legacy-pi-compat.ts:810-828).
    PIAI     .../omp-optchat/node_modules/@oh-my-pi/pi-ai/src
    OPTCHAT  /srv/openclaw-data/home/ericjuta/.openclaw/workspace/repos/omp-optchat   (HEAD bc633ac, v0.5.0)
    JEVIFY   /srv/openclaw-data/home/ericjuta/.openclaw/workspace/repos/omp-jevify    (v0.2.0)
    CFG      /home/ericjuta/.omp/agent/config.yml
    PLUGINS  /home/ericjuta/.omp/plugins
    omp://   OMP 18.9.1 harness docs (read through the host)

The host binary is `/home/ericjuta/.bun/bin/omp` (OMP 18.9.1).

## 1. OMP host 18.9.1

### 1.1 Skills and context files

| Fact | Source | Replaces in the kit |
|---|---|---|
| Native project skills live at `.omp/skills/<name>/SKILL.md`, found by walking up from the working directory, provider priority 100. User skills live at `~/.omp/agent/skills`. | HOST/discovery/builtin.ts:296-316; omp://skills.md:89-102 | The kit's old skills directory for another agent tool. Skills now live in `.omp/skills/`. |
| Layout is one level deep: `<root>/skills/<name>/SKILL.md`, not recursive. | omp://skills.md:27-31 | Nothing; the kit already used one folder per skill. |
| `.agents/skills` (and `.agent/skills`) also load, walking up, at priority 70. | HOST/discovery/agents.ts:2-30,177; omp://skills.md:89-102 | An alternative home; sibling repos vendor shared skills there. The kit uses `.omp/skills` (higher priority, OMP-native). |
| This host disables the `claude` and `claude-plugins` providers, so skills, commands and context files in that tool's directories never load. | CFG:128-130; omp://context-files.md:243-250 | Why the kit's skills had to move. |
| Users run a skill with `/skill:<name> [args]` (`skills.enableSkillCommands`, default true); the body is injected as a message. Models read skills on demand as `skill://<name>`. Skills are listed, not auto-loaded. | HOST/extensibility/settings.ts:31-34; omp://skills.md:141-183 | "`/wayfinder <map>`" becomes "`/skill:wayfinder <map>`"; "call the Skill tool" becomes "read `skill://<name>`". |
| Frontmatter honoured: `name`, `description`, `disable-model-invocation`, `hide`, `enabled`; unknown keys are kept as metadata. | HOST/capability/skill.ts:12-32; omp://skills.md:52-63 | Per-tool metadata files beside skills are not needed. |
| There is no built-in `/wayfinder` command; Wayfinder is only a skill. | HOST/slash-commands (searched the `name:` entries; not found) | Nothing; the kit ships the skill. |
| A standalone `AGENTS.md` loads by walking up to the repo root and through enclosing workspace directories. At the same depth the AGENTS.md provider wins over other single-file context providers, so a second context file beside it is shadowed and redundant. | omp://context-files.md:69-80,113-145,313 | The kit's one-line import file beside `AGENTS.md`, now deleted. |
| Walk-up means this repo's `AGENTS.md` and `.omp/skills/` load only when OMP is started at the repo root or below it. | [INFERENCE] from HOST/discovery/builtin.ts:296-304 and agents.ts:131-140 | The planning kit's README said "open OMP at the kit root"; in this repo, start OMP at the root. |
| `.omp/RULES.md` holds always-apply rules. | omp://context-files.md:26-27 | Not used by the kit. |

### 1.2 Judge role and judgment service (how Jev is reached)

| Fact | Source | Replaces in the kit |
|---|---|---|
| Jev is the host `judge` model role. This user's config sets `judge: openrouter/~typesafe/jev-latest`. `judge` is a model-kind role alongside `image`, `web`, `speech`, `dictation`; chat roles are `default`, `smol`, `slow`, `vision`, `plan`, `commit`, `tiny`, `memory`, `task`, `advisor`. | CFG:6; omp://models.md:630-651 | Per-role environment variables for model ids (`OPTCHAT_*_MODEL`, `JEV_API_KEY`, `JEV_BASE_URL`). Models are OMP roles; credentials are OMP's. |
| The judgment service is exported as the package subpath `@oh-my-pi/pi-coding-agent/judgment`, not from the package root. | HOST/../package.json:345-348 | A hand-written Jev HTTP client. |
| `resolveJudge(deps: JudgeDeps): ChainJudge`. `JudgeDeps = {settings, registry, sessionModel?, sessionId?, purpose, onUsage?, telemetry?, cache?}` (also `metadataResolver?`). | HOST/judgment/index.ts:69-87,219-221 | The kit's `Decider` interface. |
| `journalJudgmentUsage(manager)` returns an `onUsage` that writes each billed attempt as a session `model_usage` entry; it accepts a partial manager and returns `undefined` when `appendModelUsage`, `getSessionId` or `getLeafId` is missing. | HOST/judgment/index.ts:101-123 | The kit's own `usage.jsonl` for decider calls. |
| `sharedJudgmentCache()` returns the shared local SQLite answer cache (undefined under `bun test`). Identical state + model + question is answered free from it. | HOST/judgment/cache.ts:1-17,108-111 | Any decider-side cache. |
| The host builds deps per call. Example: `AgentSession.ruleJudge()` passes `{settings, registry, sessionModel, sessionId, purpose: "ttsr", onUsage: journalJudgmentUsage(sessionManager), cache: sharedJudgmentCache()}`. | HOST/session/agent-session.ts:3071-3080 | Pattern the gates copy. |
| The `settings` singleton is exported from `@oh-my-pi/pi-coding-agent` (`export { Settings, settings }`). | HOST/index.ts:18 | — |
| `ChainJudge` tries the judge role chain in order. Native backends (TypeSafe Jev directly or through OpenRouter) come first when credentialed. From the first native candidate on, only native candidates remain: a prompted chat model never stands in for a failed native judgment. When no candidate is native (for example native credentials are missing), a local tiny model or a prompted chat model answers through `TextJudge`, and the session model is appended as a last resort. | HOST/judgment/index.ts:171-205,334-350 | The kit's `LlmDecider` fallback class. |
| A candidate whose account rejects the request (401/403/402) is skipped for 5 minutes. Aborts and timeouts propagate immediately instead of falling through. With no candidate the error is `judgment: no judge model available`; with all failing, `judgment: every judge candidate failed: …`. | HOST/judgment/index.ts:136,255-299 | Gate failure handling. Gates treat any throw as "no answer". |
| `ChainJudge.primaryModel()` names the first candidate. | HOST/judgment/index.ts:251-253 | The judge line in `/optchat status`. |
| Interface: `Judge.judge({state, questions}, {signal}) -> {api, provider, model, answers, usage}`. `state` is a string, JSON object or JSON array. Questions are keyed by caller id. `choice` {instructions, criteria: {label: rubric or null}} -> {choice, probabilities, confidence}; `noul` {instructions, criteria?: {true?, false?}} -> {noul: P(yes)}; `score` {instructions, criteria: [lowest..highest]} -> {score, probabilities, confidence}. Missing answers throw `JudgmentParseError`. | PIAI/judgment/types.ts:48-103 | The kit's `Question`/`Answer` types (its "probability" type is `noul`). |
| Native transport: OpenRouter `/decisions` or TypeSafe `/v1/systemone`, 10 s per attempt, 3 attempts. | PIAI/judgment/typesafe.ts:36-39,81-84 | Ticket 01's transport question. |
| Extension `ctx` and the `pi` API expose no judge; an extension imports `resolveJudge` itself. | HOST/extensibility (grep for judge/judgment: no matches) | — |
| `ReadonlySessionManager` (the type of `ctx.sessionManager`) does not declare `appendModelUsage`. Whether the runtime object has it is unverified, so journaling from an extension must be checked on a real host. | HOST/session/session-manager.ts:679-703; [INFERENCE] about the runtime object | ExecPlan M1/M6 checks. |

### 1.3 Eval kernel

| Fact | Source | Replaces in the kit |
|---|---|---|
| `judge(state, questions)` returns `{id: answer}` through the session `judge` role chain. In the eval kernel the yes/no type is spelled `bool` (`{bool: P(yes)}`); the library type is `noul`. No maximum option count is documented. | HOST/prompts/tools/eval-judge.md:3-8,40-47,73-80,89-167; HOST/eval/judgment-bridge.ts:174-217 | The kit's "decider" inside retrieval scripts. |
| `judge_batch(states, questions, concurrency=32, retries=1, min_ok=1, intent=None)` returns an async batch with `status()`, `results()`, `failed()`, `drain()`, `cancel()`, `close()`, `attach(id)`. | HOST/prompts/tools/eval-judge.md:9-10 | Chunked scoring loops. |
| `completion(prompt, model='default'|'smol'|'slow', system, schema)`: stateless, no tools. | HOST/prompts/tools/eval-judge.md:2 | — |
| `agent(...)`, `workpool(...)`, `wait(...)` run task subagents from eval code; `budget` reports spend. | HOST/prompts/tools/eval-agents.md:2-16; eval-helpers.md:8 | Parallel research fan-out. |
| `tool.<name>(args)` calls any enabled registry tool by name, so an eval script can call omp-optchat's `zoom`, `date` and `work`. | HOST/eval/js/tool-bridge.ts:60-66; HOST/session/session-tools.ts:446-455; HOST/prompts/tools/eval.md:20-21; OPTCHAT/src/handoff.ts:148-185 | The kit's proposed read-only memory API (`src/agent/memory-api.ts`) and `codemode` flag: codemode retrieval needs no new API. |
| `archive` (read-only local session history) is a built-in eval prelude; extensions cannot register preludes. | HOST/prompts/tools/archive.md:8-17; HOST/sdk.ts:2405-2430 | — |

### 1.4 Extension hooks

| Fact | Source | Replaces in the kit |
|---|---|---|
| Plugins declare `omp.extensions` in package.json; extensions run in-process with no sandbox; most handlers get 30 s. | omp://extension-loading.md:55-61,215-233,311-320 | The kit's own CLI process. |
| Events include `session_start`, `before_agent_start` ({message, systemPrompt[]}), `context` ({messages} replaces what is sent to the model), `before_provider_request`, `tool_call`, `tool_result`, `tool_approval_requested/resolved`, `input`, `session_before_compact`, and more. | HOST/extensibility/extensions/types.ts:1435-1448,1521-1589 | The kit's turn loop and request builder. |
| `context` handlers run in extension order, each receiving the previous result. | HOST/extensibility/extensions/runner.ts:1989-2040 | — |
| `tool_call` returns `{block, reason, input, additionalContext}`. A block reason goes back to the model as an error result. `input` rewrites arguments before approval. The handler fails closed on timeout (`extensionHandlers.toolCallTimeoutMs`), and the timer pauses while a UI dialog is open. | HOST/extensibility/shared-events.ts:325-355; runner.ts:1833-1880; omp://extension-loading.md:311-320; omp://approval-mode.md:62 | The kit's tool gate verdict plumbing. |
| `ctx` has `ui.confirm(title, message, opts?) -> Promise<boolean>`, `ui.notify(msg, "info"|"warning"|"error")`, `ui.select`, `hasUI`, `cwd`, `model`, `modelRegistry`, `models`, `sessionManager`, `agent` (main or sub identity), `getSystemPrompt`, `runEphemeralTurn`, `isIdle`. | HOST/extensibility/extensions/types.ts:274-347,623-735 | The kit's "ask the user" plumbing. |
| `pi.registerFlag/getFlag/registerCommand/registerTool/sendMessage/appendEntry`. Flags are registered while the extension loads; the host parses command-line values after factories run, so omp-optchat registers its flags unconditionally and reads them in `session_start` (OPTCHAT/src/index.ts:1443, :1463; `open()` at :516). | HOST/extensibility/extensions/types.ts:1660,1692; loader.ts:264-293; runner.ts:1219-1221 | `src/config.ts` environment flags. |
| Speculative `task` launches are vetoed when any extension has a `tool_call`, `tool_result`, `tool_approval_requested` or `tool_approval_resolved` handler, or when the tool's approval is not auto-allow. omp-optchat already registers `tool_result` (OPTCHAT/src/index.ts:1298), so adding a `tool_call` handler does not change speculation. | HOST/speculation/host.ts:75-82 (`hasLifecycleHandlers`), :215-232 (`authorizeLaunch`, `#policyGate`); HOST/task/index.ts:652; omp://tools/task.md:126 (consistent) | — |

### 1.5 Tool approval

| Fact | Source | Replaces in the kit |
|---|---|---|
| `tools.approvalMode` is `always-ask`, `write` or `yolo` (default `yolo`); this host leaves it unset. `tools.approval.<tool>` (`allow`, `deny`, `prompt`) applies in every mode. Bash has pattern rules. `eval` is the exec tier. | HOST/tools/settings.ts:311-316; HOST/tools/approval.ts:203-315; omp://approval-mode.md:18-81 | A static, rule-based layer the judged tool gate sits on top of. Overlap is listed in the map's "Not yet specified". |
| Subagent sessions run with approval forced to `yolo`. | omp://tools/task.md:107 | Why the tool gate screens the `task` call itself. |

### 1.6 Ratchet (trusted-eval hill-climb)

| Fact | Source | Replaces in the kit |
|---|---|---|
| `/ratchet` and eval `ratchet(flow)` build a trusted eval for one LLM flow and hill-climb it one change per round. State lives at `.omp/ratchet/<flow>/`. API: `init(cases, harness, change, off_limits, command)`, `plan(goal, reps, stop, command, prices)`, `split(tags, test_fraction=0.4)` (frozen after baseline), `approve(inputs|grader|plan)` (host dialog over hashed content), `check`, `gate` -> baseline/keep/revert/rerun with paired deltas, `train`, `status`. | HOST/prompts/tools/ratchet.md:5-29; HOST/tools/ratchet.ts:19 | The kit's `autoresearch` skill and hand-run loop. |
| Trust model: the host owns approvals, the split and keep/revert; the model sees scores only; test transcripts are never shown; acceptance is a held-out test delta. Runner contract: `results.jsonl` rows with prompt_id, rep, tags, grade, status, model, usage, latency_s (optional judge_model, judge_usage), plus `errors.jsonl` and train-only `traces/`. | HOST/prompts/tools/ratchet.md:5-10,23-29,54-73 | The kit's overfitting guards. |
| `ratchet.enabled` defaults to false and is true on this host; `/ratchet` turns it on for the session and needs the eval and task tools. Headless runs can only continue a flow whose approvals are current. | HOST/tools/settings.ts:606-616; CFG:289-290; HOST/slash-commands/builtin-modes.ts:244-263,733 | — |

### 1.7 Plan mode, handoff, todo, ask, task subagents

| Fact | Source | Replaces in the kit |
|---|---|---|
| `/handoff` summarizes the session into a handoff document and compacts in place. | HOST/slash-commands/builtin-lifecycle.ts:305 | The kit's `handoff` skill (dropped). |
| Plan mode: `/plan [prompt]` writes `local://<slug>-plan.md`, reviewed with `/plan-review`; the tree is read-only while active. `plan.enabled` defaults to true but this host sets false. | HOST/slash-commands/builtin-modes.ts:326,347; HOST/plan-mode/approved-plan.ts:6-8,114-116; HOST/plan-mode/settings.ts:12-15; CFG:169-170 | The kit's `create-plan` skill (dropped) for small plans; `todo` covers the rest. |
| `todo` tracks a single-op task list; `/todo export|import`. | omp://tools/todo.md:18-30; HOST/slash-commands/builtin-session.ts:205-226 | — |
| `ask` asks batched multiple-choice questions with an optional recommended option. | omp://tools/ask.md:15-28 | Grilling's one-question-at-a-time prompts can use it. |
| `task` subagents: bundled `scout`, `task`, `reviewer`, `security-reviewer`, `sonic`; custom agents in `.omp/agents/*.md`; `isolated` runs in a separate worktree and returns a patch. | omp://task-agent-discovery.md:25-48,52,128-153; omp://tools/task.md:33,50,104-106,127-128 | Research fan-out and the kit's subagent "spawn". |

### 1.8 Memory backends and judged rules

| Fact | Source | Replaces in the kit |
|---|---|---|
| `memory.backend` is `off`, `local`, `hindsight`, `mnemopi` or `sharpshooter`; this host uses `sharpshooter`. omp-optchat does not replace it. | HOST/memory-backend/settings.ts:13-16; CFG:86-87; OPTCHAT/README.md:95 | Overlap with the rules ledger (map "Not yet specified"). |
| Judged TTSR rules: a rule file with `question:` frontmatter is checked after each completed output with one Jev `noul` request carrying every candidate question, over state `{output, content}` trimmed to 32,000 Jev tokens; P >= 0.7 injects the rule as an aside; usage purpose `ttsr`; failures deliver nothing. | omp://ttsr-injection-lifecycle.md:288-305; omp://rulebook-matching-pipeline.md:37-91 | Evidence that many questions ride one Jev request; overlap with the rules ledger. |

## 2. omp-optchat v0.5.0

omp-optchat is an OMP extension plugin (`omp.extensions: ["./src/index.ts"]`, OMP >= 18.9.0) that already implements the kit's old milestones 0 to 3. At HEAD (bc633ac) it has no judge or Jev code: a case-insensitive search for `judge|jev` finds only deterministic scoring in the evidence runner (OPTCHAT/scripts/evidence-recall.ts:917, OPTCHAT/scripts/evidence/scoring.ts). The working tree is not at HEAD; see the in-flight note in this section.

| Kit term | Status | Source | Difference from the kit, and what it replaces |
|---|---|---|---|
| Message kinds | implemented, plus `work` | OPTCHAT/src/store.ts:26; src/index.ts:232-333 | Kinds are user, talk, tool, echo, note, work. `work` holds subagent and background-job reports; `note` comes only from import; `think` is never logged (src/index.ts:60). |
| Log (append-only, fsync) | implemented | src/store.ts:404-410,727-787 | Daily files `main/YYYY-MM-DD.jsonl`; torn lines skipped and reported; id gaps refused. Replaces kit milestone 0's log. |
| Single writer | implemented differently | src/store.ts:353-378,657-658; src/index.ts:529-534 | Abstract Unix socket lease keyed by the directory's device and inode, Linux only. A conflict makes the session inactive, as with `--no-optchat`. Replaces the kit's file socket lock. |
| Store location | implemented | src/config.ts:173-184 | Per git worktree: `<agentDir>/optchat-worktrees/<slug>-<sha16>`; outside git `<agentDir>/optchat`; `--optchat-dir` overrides. Replaces `chat/` and `OPTCHAT_HOME`. |
| Node, tree, `NODE` = 512 | implemented | src/config.ts:9; src/memory.ts:192,201 | Tree records `{l,i,text,size}` in `tree/`. Safety ceiling 16,384 bytes. |
| Address `id+n` | implemented | src/memory.ts:276-285,334-337 | — |
| Free node | implemented | src/memory.ts:582-592 | — |
| Compactor (omp-optchat calls it the compressor) | implemented, different policy | src/memory.ts:64,203,230-235,481-497,624-750; src/index.ts:663,698-760 | 8 jobs, 5 tries with one feedback turn per try, shortest reply kept. No retry timers: a failed node is retried on the next append. Dependency-ready order: a parent may build before an earlier leaf. Long records are paged (16,384-byte pages) and reduced. A refused compaction falls back once to the main model, then to an `[unsummarized: compressor refused]` excerpt. Default model role `@smol`. Replaces `RETRY = 10 s` and strict order. |
| No ids in compactor calls | different | src/memory.ts:465,630-637; src/prompts.ts:18-19 | Task lines name ids ("compress message N", "merge lines a+h and b+h") and context lines carry `id+n|` heads; the output must omit heads. The kit's "never put ids in a compactor call" rule does not hold here. |
| Compactor context | implemented | src/memory.ts:195-196,419-472 | A separate 16,000-32,000-byte sawtooth view of built lines before the target. |
| View, fit | implemented, different budget | src/memory.ts:193-194,345-394 | Sawtooth: grows to 128,000 bytes, then merges down to 64,000. Merge priority is age. Snapshot `view.json` (atomic, fsynced). Replaces the kit's fixed 128,000 budget. |
| Settle | implemented | src/index.ts:53-57,1168-1199 | 25 s shared with startup, under the host's 30 s context-handler cap; on timeout the prompt is refused and stays logged unanswered. |
| Turn (fresh context) | implemented | src/index.ts:372,1027-1069 | The `context` hook returns `[view, ...this turn's messages]`; the view is frozen per turn. |
| Tools `zoom`, `date`, `work` | implemented | src/handoff.ts:141-198; src/memory.ts:301-306 | `zoom(id, n, offset)` returns 16 KB pages; `work(name)` returns a stored report. |
| Tool-output cap | implemented | src/config.ts:13; src/index.ts:103-121,1298-1310 | 30,000 characters, head and tail; the full text stays in the log. |
| Cache marks | implemented, provider-specific | src/cache.ts:17-19,52-123,213-323 | Official Anthropic image-capable routes: view split in four-line blocks, one 5-minute ephemeral mark on the last whole block plus the host's request-end mark and kept tools/system marks, at most 4. Other routes keep fixed cuts at 50,000/80,000/100,000 characters; OpenAI Responses uses `prompt_cache_breakpoint`. The view must be the leading user message (`leadingView`, src/cache.ts:124). Replaces the kit's request builder. |
| Subagent reports | implemented | src/index.ts:232-256; src/reports.ts | Logged as kind `work` with source (task, async-result, launch-completion) and completeness (full or pointer-only). Replaces the kit's "`[id] ` user message" design. |
| Child views | implemented, on by default since 0.11.0 | src/config.ts:14,78-82; src/index.ts:578-622; src/handoff.ts:77-233 | `--optchat-child-view` (default on since 0.11.0; `--no-optchat-child-view` opts out): frozen render plus read-only zoom/date/work bounded to the spawn point; revoked on switch or shutdown. |
| Images, export, import | implemented | src/archive.ts:5-8; src/history.ts:196-263 | — |
| Commands | implemented | src/index.ts:1363-1384,1452-1461 | `/optchat status | view | export PATH | import PATH`. |
| Flags | implemented | src/config.ts:6-15,33-152 | `--optchat`, `--no-optchat`, `--optchat-dir`, `--optchat-model`, `--optchat-node-bytes`, `--optchat-view-bytes`, `--optchat-jobs`, `--optchat-tries`, `--optchat-tool-cap`, `--optchat-child-view`. Malformed values throw, and the session refuses prompts until restart (src/index.ts:509-516). |
| Factory options | implemented | src/index.ts:65-78 | `OptChatOptions`: `settleTimeoutMs`, `onCompressorUsage`, `admitCompressorCall`, `compressorMaxTokens`. No judge factory and no compressor hint hook. `CompactionRequest` is `{context, instruction, feedback}` (src/memory.ts:6-10). |
| Evidence runner | implemented | scripts/evidence-recall.ts; scripts/evidence/options.ts:68-89; scripts/evidence/artifact.ts:8-57,348 | `bun run evidence:recall`: dry run unless `--confirm-live-provider-calls`, then `--max-cost-usd` (at most 30) is required; paired on/off arms; 13 probe kinds (scripts/evidence/corpus.ts:17-47); deterministic grounded scoring; usage per role with unobserved values null, never 0. No recall-by-age buckets and no rule-persistence probe. |
| Tests, typecheck, smoke | implemented | package.json:14-19; scripts/smoke.ts:1-60 | `bun test tests`, `bun run typecheck`, `OPTCHAT_SMOKE_OMP=<omp> bun run smoke` (real OMP host, loopback model). |
| System One gates (Jev) | absent at HEAD; in flight in the working tree (uncommitted) | `git status` in OPTCHAT at audit time: `M src/config.ts`, `M src/memory.ts`, `?? src/system1/`, `?? tests/helpers/fake-host.ts`; `src/index.ts` unchanged | The gates this plan builds. A sibling agent (task `OptchatGates`) owns the in-flight edits. |
| Planning | GitHub Issues | omp-optchat issues #2, #9 (labels `wayfinder:map|task|research`); CHANGELOG "Tracks Wayfinder map #N" | No local plan files in the repo. |

In-flight note (2026-10-11; source-read from the working tree, not reviewed for correctness). The uncommitted diff adds: flags `--optchat-rules`, `--optchat-prefetch`, `--optchat-value-score`, `--optchat-tool-gate`, `--optchat-rule-add`, `--optchat-prefetch-k`, `--optchat-prefetch-min` (OPTCHAT/src/config.ts, the `registerFlag` block after `--optchat-child-view`); an optional `hint` and `hintTimeoutMs` on `MemoryOptions`, with `hintFor()`, which asks the hint once per level-0 leaf that is not verbatim and appends one sentence to the compaction instruction (OPTCHAT/src/memory.ts:36-41,177-178,221-222,660-667,723-760; `grep -c hint` on HEAD's src/memory.ts is 0); and four new modules, `src/system1/judge.ts`, `ledger.ts`, `prefetch.ts` and `rules.ts`. Nothing is wired into `src/index.ts`; `OptChatOptions` still has no judge or hint option; there is no value-score or tool-gate module yet. The plan therefore treats the in-flight code as an unreviewed draft by another agent and does not assume it.

## 3. omp-jevify v0.2.0

omp-jevify is a skill-only plugin: `files: [skills, …]`, `omp: {}`, no TypeScript, hooks, gates or HTTP transport (JEVIFY/package.json:16-17; glob for `*.ts`/`*.js`: none).

**Skill contract** (JEVIFY/skills/jevify/SKILL.md). Jev is an optional classifier, not evidence or permission (:10-12). Method comes first: a compiler, search or script when a rule decides; direct reading for small or cross-dependent jobs; Jev only for repeated, independently judgeable semantic decisions (:16-21). Thresholds are set before a pilot; default escalation is top choice p < 0.7, unknown labels, or bool p between 0.3 and 0.7 (:29-34). Pilot, then freeze the questions with a hash; a wording change after freezing invalidates verdicts (:39-44). Errors, fallback answers and unknown provenance count as unresolved, never as answered (:45-49,58-62). Calibrate before bulk or destructive action (:63-65). Reports state method, coverage counts, errors, models, fallbacks and calibration, and separate estimates from confirmed results (:80-85). This replaces the kit's informal rule "Jev outputs feed thresholds owned by code" with a fuller, already-written discipline.

**`jv` helper** (JEVIFY/skills/jevify/jevify.py, loaded with `%load skill://jevify/jevify.py`). Question builders `choice`, `yes` (type `bool`) and `scale` (type `score`) (:43-69); `freeze`/`qhash` (:72-82); unit extractors `git_units`, `rg_units`, `ast_units`, `line_units` (:154-347); `jev_tokens` via `omp toks <file> --json` (:420-447); `states` with a 12,000-character string cap and a 32,000-Jev-token ceiling, measuring oversize states (:35-36,450-487); `group`/`slot_questions` (:537-590); `run` over `judge_batch` with a receipt that records models, fallback, cache counts and provenance (:778-927); `flag`, `tally`, `calibrate` (choice only, `completion` on the `slow` role), `save`/`load`, `delete_spans` (dry run by default), `report` (:930-1218).

**Eval runner and grader.** `evals/run.py` launches one OMP process per attempt: `omp --session-dir <tmp> --mode json --auto-approve --config <overlay> --no-extensions --no-rules --no-lsp --no-title --tools read,eval,grep,glob,bash,find,edit,write --max-time N "<prompt>"`, with a private session directory and a per-attempt `OMP_JUDGMENT_CACHE_DB` (cold, warm read-only snapshot, or uncontrolled) (JEVIFY/evals/run.py:362-453,1110-1209). It reads session JSONL `model_usage` rows (purposes `judgment` for judge calls, `completion` for eval completions; required fields id, timestamp, purpose, api, provider, model, stopReason, usage) after the session settles (:61,549-552,1225-1231). `evals/grade.py` grades results with `judge_batch` against answer keys and writes a shared grading ledger whose total cost is null and `billing_complete: false` (JEVIFY/evals/grade.py:285-327,412-417,518-526). A sealed `evals/holdout.json` is never read for tuning (holdout.json:3). This is the pattern the kit's eval docs now cite for accounting: unknown cost is null, never zero.

**Recorded Jev limits.**
- Context: states of 32,086 and 32,595 Jev tokens were judged; 33,101 and 34,107 failed with `max_tokens_exceeded` (JEVIFY/skills/jevify/reference.md:586-590). The helper's 32,000 ceiling is a policy, not a vendor limit (reference.md:338-339).
- Tokenizer: byte-level BPE, at most 1 token per byte; measured 0.76 tokens per byte for dense ASCII, 0.64 for CJK, 0.56 for emoji (jevify.py:461-463).
- An empty-string state rejects the whole batch at submission (reference.md:586).
- Jev bills the state once per request, and many questions can ride one request: judged TTSR rules send every candidate question in one `noul` request (omp://ttsr-injection-lifecycle.md:297).
- Maximum questions per request: unknown (not found in omp-jevify or the host bridge).
- Judge latency from this host: no figure recorded; `omp toks` takes about 0.25 s on real text (reference.md:594-596).
- Pricing: none recorded; costs appear only as batch-status estimates (jevify.py:630-635).

**Gaps.** No runtime gates, no extension hooks, no persistent store, no HTTP transport (all judging goes through eval-kernel globals). On stock OMP 18.8.7 judgment items carried only key/answers/error/model, so rows were `provenance_unknown`; behaviour on 18.9.1 is not documented (JEVIFY/README.md:62-68; reference.md:392-402) [INFERENCE: unverified on 18.9.1]. Eval `completion` calls were not journaled in `model_usage`, and fully cached judging may emit no usage rows (README.md:113-125).

## 4. Other plugins

| Plugin | Status | Source | Relevance |
|---|---|---|---|
| omp-cljs-codemode 0.1.22 | installed, disabled | PLUGINS/package.json:5; PLUGINS/omp-plugins.lock.json:8-12 | Replaces the visible `eval` with a ClojureScript-only one (Squint) that runs through native eval; scripts can still call `tool.zoom`. Optional for codemode retrieval: plain JS eval already reaches `tool.zoom` and `judge_batch`. All-model code mode on 18.9.1 is unverified. |
| omp-fleet 0.2.12 | installed, disabled | PLUGINS/omp-plugins.lock.json:18-22 | Read-only supervisor for Herdr worker panes; it observes, never grades. Not needed by this kit. |
| omp-workflows 0.14.8 | not installed (orphan lock entry) | PLUGINS/omp-plugins.lock.json:13-16; absent from PLUGINS/package.json:4-10 | Its autoplan/autodoc/autoimplement pipeline and autoresearch workflow example would need a proper install; the kit does not depend on it. |

## 5. Still unverified

- Whether `journalJudgmentUsage(ctx.sessionManager)` journals from an extension at runtime (type gap in 1.2). Checked by ExecPlan M1 (unit) and M6 (real host).
- Maximum questions per Jev request and judge latency from this host are measured in `docs/research/jev-api.md` (sections 1 and 2; map ticket 01).
- Whether Jev access works on this account through the configured route (map ticket 02).
- How extra user messages after the view interact with `src/cache.ts` marks on each provider (map ticket 05; ExecPlan M1 test).
- Vendor claims about Jev not observed here: price ($0.042 per million input tokens, output free), latency 70-500 ms, a 255-option cap on choices, a 64,000-token context on some routes. These come from launch coverage (`docs/design/optchat-jev.md`, Sources) and stay labelled as vendor-reported.
