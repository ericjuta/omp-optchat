# omp-optchat

omp-optchat is an OMP extension plugin that gives a session one chat that never ends. Every message is kept in an append-only, fsynced log, compressed into a binary tree of one-line summaries, and each turn the agent sees a fixed-size view of the whole history and can `zoom` into any line (`README.md`). Besides `zoom`, `date` and `work`, the memory tools include `chat_search` (exact words over the raw log) and `zoom` depth. On top of it, four System One gates (`--optchat-rules`, `--optchat-prefetch`, `--optchat-value-score`, `--optchat-recall`) ask Jev, a fast typed decision model reached through OMP's `judge` role, to keep standing rules, prefetch relevant history, hint the compressor, and guide `chat_recall` down the tree (`src/system1/`, README "System One gates"). Host-reserved tool names (`search` aliases to `grep`; `recall` is a builtin) are why the new tools carry the `chat_` prefix.

## Where planning lives

- ExecPlan (living, with Progress and Decision Log): `plans/optchat-jev.md`, maintained under `.agent/PLANS.md`.
- Design in plain words, with this repo's differences from the original spec: `docs/design/optchat-jev.md`.
- Vocabulary: `GLOSSARY.md`.
- What OMP, omp-optchat and omp-jevify provide, with citations: `docs/research/omp-capabilities.md`.
- Wayfinder map for the System One work: `.scratch/optchat-jev/map.md` (local markdown draft until charted).
- Tracker conventions: `docs/agents/issue-tracker.md`. Domain docs: `docs/agents/domain.md`.
- Eval references (not built): `docs/evals/`.
- Project skills: `.omp/skills/` (wayfinder, grilling, research, prototype, domain-modeling, execplan, verify-store-lease). Upstream originals and provenance: `vendor/`, `vendor/SOURCES.md`.

## How to start

- **Building or continuing the gates**: `/skill:execplan plans/optchat-jev.md`. If a ticket isn't resolved yet, the plan's Decision Log default stands.
- **Open decisions remain**: `/skill:wayfinder .scratch/optchat-jev/map.md`, one ticket per session. Research tickets can run in parallel as `task` subagents.
- **Improving**: `/ratchet` against the flows in `docs/evals/autoresearch-loop.md`. Reference only; the current plan does not build it.

## ExecPlans

When writing complex features or significant refactors, use an ExecPlan (as described in `.agent/PLANS.md`) from design to implementation. Keep its Progress, Surprises & Discoveries, Decision Log and Outcomes sections current as work proceeds.

## Rules for this codebase

- The chat log, the summary tree and `ledger.jsonl` are append-only. Never edit or delete their files, including in tests (use a temporary directory). Garbage collection of unreferenced image blobs and staging files is the one deletion the store performs (README "OMP-specific boundaries").
- Sizes are bytes or characters, never tokens. The only exception is an external model's stated context limit.
- The system prompt and tool definitions are byte-identical across calls: no dates, counters or per-turn state in them. Per-turn content goes after the view as its own message.
- Never put long messages in full, or truncated text, in the view; a turn waits for the compressor instead. Short records that fit in `--optchat-node-bytes` (512) are free nodes, word for word. The one exception is the refusal stand-in `[unsummarized: compressor refused]` (README "Storage and compression").
- Never put message ids in new compressor input. The existing task lines do name ids (`src/memory.ts:663-665`, "compress message N" / "merge lines a+h and b+h"); that deviation is recorded in the plan's Surprises and in `docs/design/optchat-jev.md` §2.4. Do not extend it. Value hints are fixed phrases and never carry ids or record text (`src/system1/value.ts:188-194`).
- Jev never takes part in merging the view (the merge stays deterministic), and a value hint never changes which nodes are built or when. System One messages (`<rules>`, then `<prefetch>`) go after the view and are frozen per turn (`src/index.ts:1119`, `1260`).
- Every System One gate is on by default and has its own opt-out flag (`--no-optchat-rules`, `--no-optchat-prefetch`, `--no-optchat-value-score`, `--no-optchat-recall`), which wins over the gate flag. With every gate opted out, OptChat resolves no judge and registers no `chat_recall` tool, and its context and `/optchat status` are the memory-only ones: v0.5.0's plus `chat_search` and `zoom` depth (README "System One gates"). Memory-only harnesses (integration tests, smoke, the evidence runner) opt out explicitly.
- Jev outputs feed thresholds owned by code (`--optchat-rule-add`, `--optchat-prefetch-min`, `--optchat-recall-min`); never let a Jev answer act without one. Malformed flag values fail closed.
- Keep secrets in OMP's credential store. Record variable names, never values.
- Eval runs must state a budget; never edit the eval generator, judge prompt, scorer, heldout data or hard-gate thresholds without the user.

## OMP rules

- Jev is reached only through the host `judge` role (`resolveJudge` from `@oh-my-pi/pi-coding-agent/judgment`, wrapped by `hostJudge` in `src/system1/judge.ts`). Do not add a provider HTTP client, a model SDK, or an API-key variable to the plugin. Tests inject a fake judge through `OptChatOptions.judge`.
- Choose models by OMP role or flag (`--optchat-model`, the `judge` role, a role name in an eval config). Never through an environment variable that holds a model id.
- Unknown provenance or unknown cost is unresolved. Record it as `unknown`, never as zero, and never as a guess.
- Never claim savings, quality gains or cache wins without paired evidence: the same chat, the same probes, repeated runs, and a stated budget.
- Skills live in `.omp/skills/`. Do not add paths or instructions for any other agent harness to this repo.
- Read host source from this repo's `node_modules/@oh-my-pi/pi-coding-agent/src` (18.10.3), not the stale copy under `~/.omp/plugins/node_modules`.

## Verification

Run from the repository root. There are no git hooks; these commands are the gates.

    bun run typecheck
    bun run test
    bun run test:host
    OPTCHAT_SMOKE_OMP=/home/ericjuta/.bun/bin/omp bun run smoke

The smoke uses a loopback model and makes no provider calls. `bun run test:host` launches real OMP hosts from `tests/host/` (the real-host integration suite and the paired evidence run). CI (`.github/workflows/ci.yml`) runs the same checks: typecheck, `bun run test`, `bun run test:host`, and smoke.

Changing the store writer lease (`acquireLease`, `Store.open`/`close`, `archiveStoreDirectory`, `/optchat new`, or how `ledger.jsonl` and `metrics.jsonl` are written): also run `bun run verify:lease` (about 12 s, needs Java; `.omp/skills/verify-store-lease/SKILL.md`). It is not in CI.

## Agent skills

### Issue tracker

This repo charts Wayfinder maps on GitHub Issues. The System One map is a local markdown draft under `.scratch/optchat-jev/` until it is charted. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context: `GLOSSARY.md` at the repo root, and `docs/adr/` once it exists. See `docs/agents/domain.md`.
