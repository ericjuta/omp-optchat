# Wayfinder map: OptChat + Jev

## Destination

`plans/optchat-jev.md` has no open decisions left: every default in its Decision Log is confirmed or replaced, Jev's limits as seen from this OMP host are measured, and the gate set, eval scope and demo are chosen. An agent can then implement the plan milestone by milestone without asking anything.

## Notes

- Domain: an endless-chat agent (OptChat, the omp-optchat plugin) with a summary tree plus fast typed decision gates (Jev, reached through OMP's `judge` role). Read `GLOSSARY.md`, `docs/design/optchat-jev.md` and `docs/research/omp-capabilities.md` before working any ticket.
- Skills to consult: `/skill:grilling` and `/skill:domain-modeling` for decisions, `/skill:research` for facts, `/skill:prototype` for logic questions. Research tickets can run as OMP `task` subagents in parallel.
- Tracker: local markdown, per `docs/agents/issue-tracker.md`. A ticket with `Status: open` is unclaimed. Set `Status: claimed` before any work.
- Time-boxed. If a ticket isn't resolved in time, the default already written in the ExecPlan's Decision Log stands; record that as its answer.
- When a ticket resolves, fold the answer into `plans/optchat-jev.md` (Decision Log, plus any section it changes), not just here.
- The proposal is a starting position, not a decision. Nothing below counts as decided until it appears under Decisions so far.

## Decisions so far

<!-- one line per resolved ticket or settled direction: [title](issues/NN-slug.md): gist -->

- [Implementation home is omp-optchat](issues/03-runtime-and-model-stack.md): the gates are flags in the omp-optchat OMP extension (TypeScript on Bun), not a standalone app; model roles come from OMP. Closes ticket 03.
- [Jev through the host judge role](issues/01-jev-api-and-limits.md): the plugin reaches Jev only through `resolveJudge` (the `judge` role), with no provider client. Narrows ticket 01; its remaining items are listed there.
- [View fold tested in omp-optchat](issues/04-view-fold-prototype.md): omp-optchat's fold and its named tests answer the prototype question; the untested cases move into the plan. Closes ticket 04.
- [Retrieval primitives](issues/10-codemode-retrieval.md): raw-log text search ships as `chat_search`, judge-guided descent as the recall gate's `chat_recall`, plus `zoom` depth; codemode beam stays in the eval kernel, not the plugin. Synthetic comparison recorded in ticket 10; real-summary and Jev evidence still open. Answers ticket 10 (synthetic).
- Skills live under `.omp/skills/` (wayfinder, grilling, domain-modeling, research, prototype, execplan). Set by the user's direction; no ticket.
- The eval harness and the automated research loop are out of scope for the current build. Set by the user's direction; narrows ticket 07 to the current build, and their reference documents remain in `docs/evals/`.
- [Jev access](issues/02-jev-access.md) and [Jev limits](issues/01-jev-api-and-limits.md): native Jev answers through OpenRouter only (the direct TypeSafe credential was removed); limits and latency are in `docs/research/jev-api.md`, and the chunker constants hold. Closes tickets 01 and 02.
- Tool gate removed in 0.8.0 (Eric, 2026-10-13): OMP's own tool approval owns risky-call approval. This settles the tool gate against `tools.approval` and the question of screening subagent calls.
- Standing instructions are split by scope (Eric, 2026-10-13): the rules ledger holds what the user says in this chat (per store), OMP TTSR rule files hold enforced guardrails across sessions, and Sharpshooter holds cross-session project decisions. Documentation only.
- First ratchet flow `chat-recall-descent` plateaued after three wording rounds (test 1/19); the misses are structural. Top-k descent is opt-in (no measurable gain); raw-log seeds are being evaluated.

## Not yet specified

- Embedding search over the raw log, beside the shipped text search (`chat_search`).
- Where replayed real sessions come from for cost and cache metrics, and how private content is kept out of shared datasets.
- Subagents: omp-optchat already logs `work` reports and offers opt-in child views (design §4). Still open: whether the demo needs subagents.
- Whether Jev can pre-filter tool noise before the compactor, beyond giving it a hint.
- Rules ledger edge cases: rules with a scope ("for this project only"), and rules that expire.

## Out of scope

Proposed for this effort; edit freely.

- Computer use and desktop control.
- More than one user per chat.
- Importing chat history from other tools.
